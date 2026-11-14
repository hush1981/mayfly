package handlers

import (
	"encoding/base64"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

// MaxMediaBytes is only a technical safety net against absurd uploads (uploads are buffered in the
// container's in-memory /tmp); a 30 s video — even a dual camera one — stays far below it. Not a
// user-facing limit.
const MaxMediaBytes = 200 << 20

type MediaHandler struct {
	pool    *pgxpool.Pool
	storage storage.Storage
	quota   *MediaQuota
}

func NewMediaHandler(pool *pgxpool.Pool, store storage.Storage, quota *MediaQuota) *MediaHandler {
	return &MediaHandler{pool: pool, storage: store, quota: quota}
}

func (h *MediaHandler) Send(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	if err := parseUpload(c); err != nil {
		return err
	}
	recipientID := c.FormValue("recipient_id")
	ephemeralKeyB64 := c.FormValue("ephemeral_public_key")
	nonceB64 := c.FormValue("nonce")
	mediaType := c.FormValue("media_type")
	groupIDStr := c.FormValue("group_id")

	if recipientID == "" || ephemeralKeyB64 == "" || nonceB64 == "" || mediaType == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "missing required fields")
	}
	if _, err := uuid.Parse(recipientID); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid recipient_id")
	}
	if recipientID == currentUserID {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot send to yourself")
	}
	if mediaType != "image" && mediaType != "video" && mediaType != "audio" {
		return echo.NewHTTPError(http.StatusBadRequest, "media_type must be 'image', 'video' or 'audio'")
	}

	ephemeralKey, err := base64.StdEncoding.DecodeString(ephemeralKeyB64)
	if err != nil || len(ephemeralKey) != 32 {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid ephemeral_public_key")
	}

	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil || len(nonce) != 24 {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid nonce")
	}

	// Moments only go to friends. A broadcast list is just the owner's private selection of
	// friends: sending "through" it needs the list to be the sender's own and the recipient
	// to be on it — and still a friend. The server does not record which list was used.
	if groupIDStr != "" {
		if _, err := uuid.Parse(groupIDStr); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid group_id")
		}
		onList, err := models.IsOnOwnList(h.pool, groupIDStr, currentUserID, recipientID)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "could not verify the list")
		}
		if !onList {
			return echo.NewHTTPError(http.StatusForbidden, "not a member of this group")
		}
	}
	friends, err := models.AreFriends(h.pool, currentUserID, recipientID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not verify friendship")
	}
	if !friends {
		return echo.NewHTTPError(http.StatusForbidden, "recipient is not a friend")
	}

	if blocked, err := models.IsBlockedEither(h.pool, currentUserID, recipientID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not verify recipient")
	} else if blocked {
		return echo.NewHTTPError(http.StatusForbidden, "recipient is not a friend")
	}

	file, err := c.FormFile("encrypted_file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "encrypted_file required")
	}
	if file.Size <= 0 || file.Size > MaxMediaBytes {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "file too large")
	}
	if h.quota != nil {
		if err := h.quota.Check(h.pool, h.storage, currentUserID, recipientID, file.Size); err != nil {
			return err
		}
	}

	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not open file")
	}
	defer src.Close()

	// Pre-generate UUID so it serves as both DB id and storage key atomically
	mediaID := uuid.New().String()

	// Save file first; if DB insert fails we clean up the file
	if err := h.storage.Save(mediaID, src); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store file")
	}

	media, err := models.CreateMedia(h.pool, models.CreateMediaParams{
		ID:                 mediaID,
		SenderID:           currentUserID,
		RecipientID:        recipientID,
		EphemeralPublicKey: ephemeralKey,
		Nonce:              nonce,
		MediaType:          mediaType,
		FileSize:           file.Size,
	})
	if err != nil {
		h.storage.Delete(mediaID)
		// (no user ids in the log)
		c.Logger().Errorf("CreateMedia failed: %v (mediaType=%s fileSize=%d)", err, mediaType, file.Size)
		return echo.NewHTTPError(http.StatusInternalServerError, "could not create media record")
	}

	// Fire-and-forget, content-free wake-up of the recipient's device (UnifiedPush)
	wakeUsers(h.pool, recipientID)

	return c.JSON(http.StatusCreated, map[string]string{"media_id": media.ID})
}

func (h *MediaHandler) Inbox(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	items, err := models.GetInbox(h.pool, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not get inbox")
	}

	if items == nil {
		items = []models.MediaInboxItem{}
	}
	return c.JSON(http.StatusOK, items)
}

func (h *MediaHandler) Download(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	mediaID := c.Param("id")
	if _, err := uuid.Parse(mediaID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}

	media, err := models.GetMediaForDownload(h.pool, mediaID, currentUserID)
	if err == pgx.ErrNoRows {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not get media")
	}

	f, err := h.storage.Load(media.StoragePath())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not load file")
	}
	defer f.Close()

	c.Response().Header().Set("X-Ephemeral-Key", base64.StdEncoding.EncodeToString(media.EphemeralPublicKey))
	c.Response().Header().Set("X-Nonce", base64.StdEncoding.EncodeToString(media.Nonce))
	c.Response().Header().Set("X-Media-Type", media.MediaType)
	c.Response().Header().Set("Cache-Control", "no-store")

	return c.Stream(http.StatusOK, "application/octet-stream", f)
}

func (h *MediaHandler) MarkViewed(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	mediaID := c.Param("id")
	if _, err := uuid.Parse(mediaID); err != nil {
		return c.NoContent(http.StatusNoContent)
	}

	storagePath, wasUpdated, err := models.MarkViewed(h.pool, mediaID, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not mark as viewed")
	}

	if wasUpdated {
		if err := h.storage.Delete(storagePath); err != nil {
			// Log but don't fail — the DB row is already marked viewed (the cleanup retries)
			c.Logger().Errorf("failed to delete a viewed media file: %v", err)
		}
		// Delete DB row after file is gone
		if err := models.DeleteMediaByID(h.pool, mediaID); err != nil {
			c.Logger().Errorf("failed to delete a viewed media row: %v", err)
		}
	}

	return c.NoContent(http.StatusNoContent)
}
