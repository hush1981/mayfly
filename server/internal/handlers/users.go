package handlers

import (
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	"github.com/hush1981/mayfly/server/internal/auth"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/push"
	"github.com/hush1981/mayfly/server/internal/storage"
)

type UsersHandler struct {
	pool             *pgxpool.Pool
	avatarStore      storage.Storage
	groupAvatarStore storage.Storage
	mediaStore       storage.Storage
}

func NewUsersHandler(pool *pgxpool.Pool, avatarStore, groupAvatarStore, mediaStore storage.Storage) *UsersHandler {
	return &UsersHandler{pool: pool, avatarStore: avatarStore, groupAvatarStore: groupAvatarStore, mediaStore: mediaStore}
}

func (h *UsersHandler) GetPublicKey(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	targetID := c.Param("id")
	if _, err := uuid.Parse(targetID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	// Allow access if they are friends OR share at least one group
	ok, err := isContact(h.pool, currentUserID, targetID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not verify contact")
	}
	if !ok {
		return echo.NewHTTPError(http.StatusForbidden, "not friends")
	}

	pubKey, err := models.GetUserPublicKey(h.pool, targetID)
	if err == pgx.ErrNoRows {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not get public key")
	}

	return c.JSON(http.StatusOK, map[string]string{
		"public_key": base64.StdEncoding.EncodeToString(pubKey),
	})
}

// GetPush tells the app whether the server has a push endpoint for it (not the URL itself).
func (h *UsersHandler) GetPush(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	ep, err := models.GetPushEndpoint(h.pool, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.JSON(http.StatusOK, map[string]bool{"enabled": ep != ""})
}

// SetPush stores (or with an empty endpoint: removes) the device's UnifiedPush endpoint.
func (h *UsersHandler) SetPush(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	body.Endpoint = strings.TrimSpace(body.Endpoint)
	if err := push.ValidateEndpoint(body.Endpoint); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	if err := models.SetPushEndpoint(h.pool, currentUserID, body.Endpoint); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not save push endpoint")
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *UsersHandler) UploadAvatar(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	if err := parseUpload(c); err != nil {
		return err
	}
	file, err := c.FormFile("avatar")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "avatar file required")
	}
	if file.Size > 5<<20 { // 5 MB limit
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "avatar must be under 5 MB")
	}

	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not open file")
	}
	defer src.Close()
	if !isImage(src) {
		return echo.NewHTTPError(http.StatusUnsupportedMediaType, "avatar must be a JPEG or PNG image")
	}

	// Delete existing avatar first (O_EXCL in Save requires this)
	_ = h.avatarStore.Delete(currentUserID)

	if err := h.avatarStore.Save(currentUserID, src); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store avatar")
	}

	if err := models.SetUserHasAvatar(h.pool, currentUserID, true); err != nil {
		c.Logger().Errorf("SetUserHasAvatar failed: %v", err)
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *UsersHandler) ServeAvatar(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	userID := c.Param("id")
	if _, err := uuid.Parse(userID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	// Only yourself, friends and group co-members may see a profile picture.
	if userID != currentUserID {
		allowed, err := isContact(h.pool, currentUserID, userID)
		if err != nil || !allowed {
			return echo.NewHTTPError(http.StatusNotFound)
		}
	}

	has, err := models.GetUserHasAvatar(h.pool, userID)
	if err != nil || !has {
		return echo.NewHTTPError(http.StatusNotFound)
	}

	f, err := h.avatarStore.Load(userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	defer f.Close()

	c.Response().Header().Set("Cache-Control", "private, max-age=300")
	return c.Stream(http.StatusOK, "image/jpeg", f)
}

// RotatePublicKey replaces the account's X25519 public key (new device / reinstall).
// Requires the password again, so a stolen session token alone cannot swap keys.
func (h *UsersHandler) RotatePublicKey(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body struct {
		PublicKey string `json:"public_key"`
		Password  string `json:"password"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	pub, err := base64.StdEncoding.DecodeString(body.PublicKey)
	if err != nil || len(pub) != 32 {
		return echo.NewHTTPError(http.StatusBadRequest, "public_key must be a base64-encoded 32-byte X25519 key")
	}
	if err := h.checkPassword(currentUserID, body.Password); err != nil {
		return err
	}
	if err := models.SetUserPublicKey(h.pool, currentUserID, pub); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not update key")
	}
	return c.NoContent(http.StatusNoContent)
}

// DeleteAccount removes the user and everything tied to them (moments, friendships,
// group memberships, relay messages, avatar). Requires the password.
func (h *UsersHandler) DeleteAccount(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	if err := h.checkPassword(currentUserID, body.Password); err != nil {
		return err
	}
	paths, groupIDs, err := models.DeleteUser(h.pool, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not delete account")
	}
	for _, p := range paths {
		_ = h.mediaStore.Delete(p)
	}
	// pictures of the groups and lists that went away with the account
	for _, g := range groupIDs {
		_ = h.groupAvatarStore.Delete(g)
	}
	_ = h.avatarStore.Delete(currentUserID)
	return c.NoContent(http.StatusNoContent)
}

// ChangePassword sets a new password (old one required). All other sessions are logged
// out because their tokens predate the change; this device gets a fresh token.
func (h *UsersHandler) ChangePassword(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	if len(body.New) < 8 || len(body.New) > auth.MaxPasswordLen {
		return echo.NewHTTPError(http.StatusBadRequest, "new password must be 8-256 characters")
	}
	if err := h.checkPassword(currentUserID, body.Current); err != nil {
		return err
	}
	hash, err := auth.HashPassword(body.New)
	if errors.Is(err, auth.ErrBusy) {
		return busy()
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	version, err := models.SetUserPassword(h.pool, currentUserID, hash)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not change password")
	}
	token, err := auth.GenerateToken(currentUserID, version)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.JSON(http.StatusOK, map[string]string{"token": token})
}

func (h *UsersHandler) checkPassword(userID, password string) error {
	if password == "" || len(password) > auth.MaxPasswordLen {
		return echo.NewHTTPError(http.StatusUnauthorized, "wrong password")
	}
	u, err := models.GetUserByID(h.pool, userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "wrong password")
	}
	ok, err := auth.VerifyPassword(password, u.PasswordHash)
	if errors.Is(err, auth.ErrBusy) {
		return busy()
	}
	if err != nil || !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "wrong password")
	}
	return nil
}

// isImage sniffs the first bytes and rewinds the reader.
func isImage(f io.ReadSeeker) bool {
	buf := make([]byte, 512)
	n, _ := io.ReadFull(f, buf)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return false
	}
	ct := http.DetectContentType(buf[:n])
	return ct == "image/jpeg" || ct == "image/png"
}

func isContact(pool *pgxpool.Pool, a, b string) (bool, error) {
	if blocked, err := models.IsBlockedEither(pool, a, b); err != nil || blocked {
		return false, err
	}
	friends, err := models.AreFriends(pool, a, b)
	if err != nil || friends {
		return friends, err
	}
	return models.ShareGroupMembership(pool, a, b)
}
