package handlers

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

// Sealed sender: friends send to a user with that user's delivery token instead of their own
// login. The server learns the recipient, the time and the size, but not who sent it. The
// token is a random 32-byte value the recipient gives to friends end-to-end encrypted; the
// server only keeps its SHA-256 hash. Who the message is from is inside the ciphertext.
//
// Abuse limits without a sender: per client IP (rate limit + daily volume) and per recipient
// (pending moments / relay queue). Blocking works by changing the token (old ones stop at once)
// and by the app dropping messages from blocked people.

const (
	maxSealedHeader = 4096
	tokenLen        = 32
)

type SealedHandler struct {
	pool    *pgxpool.Pool
	storage storage.Storage
	quota   *MediaQuota
}

func NewSealedHandler(pool *pgxpool.Pool, store storage.Storage, quota *MediaQuota) *SealedHandler {
	return &SealedHandler{pool: pool, storage: store, quota: quota}
}

func decodeToken(v string) ([]byte, bool) {
	v = strings.TrimSpace(v)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawURLEncoding, base64.URLEncoding, base64.RawStdEncoding} {
		if b, err := enc.DecodeString(v); err == nil && len(b) == tokenLen {
			return b, true
		}
	}
	return nil, false
}

func hashOf(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

// recipient resolves the X-Delivery-Token header. Unknown tokens get 404 so the sender's app
// knows to fall back to a normal (authenticated) delivery and to ask for a fresh token.
func (h *SealedHandler) recipient(c echo.Context) (string, error) {
	tok, ok := decodeToken(c.Request().Header.Get("X-Delivery-Token"))
	if !ok {
		return "", echo.NewHTTPError(http.StatusBadRequest, "invalid delivery token")
	}
	id, err := models.UserByDeliveryTokenHash(h.pool, hashOf(tok))
	if err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError)
	}
	if id == "" {
		return "", echo.NewHTTPError(http.StatusNotFound, map[string]string{"message": "unknown delivery token", "code": "token"})
	}
	return id, nil
}

// SetToken: PUT /users/me/delivery-token {"token_hash": base64(sha256(token))} (authenticated).
func (h *SealedHandler) SetToken(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var in struct {
		TokenHash string `json:"token_hash"`
	}
	if err := c.Bind(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	hash, err := base64.StdEncoding.DecodeString(in.TokenHash)
	if err != nil || len(hash) != sha256.Size {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid token_hash")
	}
	if err := models.SetDeliveryTokenHash(h.pool, me, hash); err != nil {
		if errors.Is(err, models.ErrTokenTaken) {
			return echo.NewHTTPError(http.StatusConflict, "choose another token")
		}
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.NoContent(http.StatusNoContent)
}

// Relay: POST /sealed/relay (no login) {"payload": base64, "notify": bool}.
func (h *SealedHandler) Relay(c echo.Context) error {
	var in struct {
		Payload string `json:"payload"`
		Notify  bool   `json:"notify"`
	}
	if err := c.Bind(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	payload, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil || len(payload) == 0 || len(payload) > models.RelayMaxPayload {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid payload")
	}
	to, err := h.recipient(c)
	if err != nil {
		return err
	}
	if err := models.CreateRelayMessage(h.pool, "", to, []byte{}, []byte{}, payload); err != nil {
		if errors.Is(err, models.ErrRelayQueueFull) {
			return relayQueueFull()
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store message")
	}
	notifyRelay(h.pool, to)
	if in.Notify {
		wakeUsers(h.pool, to)
	}
	return c.NoContent(http.StatusCreated)
}

// Media: POST /sealed/media (no login), multipart: media_type, sealed_header (base64),
// unsend_hash (base64 sha256 of the sender's unsend secret, optional), encrypted_file.
func (h *SealedHandler) Media(c echo.Context) error {
	// The delivery token comes first: without a valid one the body is not read at all
	// (this route needs no login).
	to, err := h.recipient(c)
	if err != nil {
		return err
	}
	if err := parseUpload(c); err != nil {
		return err
	}
	mediaType := c.FormValue("media_type")
	if mediaType != "image" && mediaType != "video" && mediaType != "audio" {
		return echo.NewHTTPError(http.StatusBadRequest, "media_type must be 'image', 'video' or 'audio'")
	}
	header, err := base64.StdEncoding.DecodeString(c.FormValue("sealed_header"))
	if err != nil || len(header) < 32 || len(header) > maxSealedHeader {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid sealed_header")
	}
	var unsendHash []byte
	if v := c.FormValue("unsend_hash"); v != "" {
		unsendHash, err = base64.StdEncoding.DecodeString(v)
		if err != nil || len(unsendHash) != sha256.Size {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid unsend_hash")
		}
	}
	file, err := c.FormFile("encrypted_file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "encrypted_file required")
	}
	if file.Size <= 0 || file.Size > MaxMediaBytes {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "file too large")
	}
	if h.quota != nil {
		if err := h.quota.CheckSealed(h.pool, h.storage, to, file.Size); err != nil {
			return err
		}
	}
	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not open file")
	}
	defer src.Close()
	mediaID := uuid.New().String()
	if err := h.storage.Save(mediaID, src); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store file")
	}
	if _, err := models.CreateMedia(h.pool, models.CreateMediaParams{
		ID:                 mediaID,
		RecipientID:        to,
		EphemeralPublicKey: make([]byte, 32),
		Nonce:              make([]byte, 24),
		MediaType:          mediaType,
		FileSize:           file.Size,
		SealedHeader:       header,
		UnsendHash:         unsendHash,
	}); err != nil {
		h.storage.Delete(mediaID)
		return echo.NewHTTPError(http.StatusInternalServerError, "could not create media record")
	}
	wakeUsers(h.pool, to)
	return c.JSON(http.StatusCreated, map[string]string{"media_id": mediaID})
}

// Unsend: DELETE /sealed/media/:id (no login) with the X-Unsend-Token secret, while unopened.
func (h *SealedHandler) Unsend(c echo.Context) error {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		return c.NoContent(http.StatusNoContent)
	}
	tok, ok := decodeToken(c.Request().Header.Get("X-Unsend-Token"))
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid unsend token")
	}
	path, err := models.UnsendSealedMedia(h.pool, id, hashOf(tok))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if path != "" {
		h.storage.Delete(path)
	}
	return c.NoContent(http.StatusNoContent)
}
