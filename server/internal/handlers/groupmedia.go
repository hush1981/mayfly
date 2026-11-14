package handlers

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
)

// SendMedia stores one encrypted blob for a group chat. The key goes end-to-end encrypted
// to every member through the relay (the server never sees it); every other member may
// download the blob once, it is deleted when all of them opened it or after 24 hours.
func (h *GroupsHandler) SendMedia(c echo.Context) error {
	g, me, err := h.groupFor(c)
	if err != nil {
		return err
	}
	if g.Kind != models.GroupKindChat {
		return echo.NewHTTPError(http.StatusBadRequest, "not a group chat")
	}
	if err := parseUpload(c); err != nil {
		return err
	}
	mediaType := c.FormValue("media_type")
	if mediaType != "image" && mediaType != "video" && mediaType != "audio" {
		return echo.NewHTTPError(http.StatusBadRequest, "media_type must be 'image', 'video' or 'audio'")
	}
	file, err := c.FormFile("encrypted_file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "encrypted_file required")
	}
	if file.Size <= 0 || file.Size > MaxMediaBytes {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "file too large")
	}
	if h.quota != nil {
		if err := h.quota.CheckGroupMedia(h.pool, h.mediaStore, g.ID, file.Size); err != nil {
			return err
		}
	}
	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not open file")
	}
	defer src.Close()
	id := uuid.New().String()
	if err := h.mediaStore.Save(id, src); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store file")
	}
	recipients, err := models.CreateGroupMedia(h.pool, id, g.ID, me, mediaType, file.Size)
	if err != nil {
		h.mediaStore.Delete(id)
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store media")
	}
	if len(recipients) == 0 {
		// nobody to deliver to (alone in the chat): nothing to keep
		models.DeleteGroupMediaByID(h.pool, id)
		h.mediaStore.Delete(id)
	}
	wakeUsers(h.pool, recipients...)
	return c.JSON(http.StatusCreated, map[string]any{"media_id": id, "recipients": len(recipients)})
}

func groupMediaID(c echo.Context) (string, string, error) {
	me, ok := mw.GetUserID(c)
	if !ok {
		return "", "", echo.NewHTTPError(http.StatusUnauthorized)
	}
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		return "", "", echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
	return id, me, nil
}

func (h *GroupsHandler) DownloadMedia(c echo.Context) error {
	id, me, err := groupMediaID(c)
	if err != nil {
		return err
	}
	mt, err := models.GroupMediaForRecipient(h.pool, id, me)
	if err == pgx.ErrNoRows {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	f, err := h.mediaStore.Load(id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
	defer f.Close()
	c.Response().Header().Set("X-Media-Type", mt)
	return c.Stream(http.StatusOK, "application/octet-stream", f)
}

func (h *GroupsHandler) MediaViewed(c echo.Context) error {
	id, me, err := groupMediaID(c)
	if err != nil {
		return c.NoContent(http.StatusNoContent)
	}
	done, err := models.MarkGroupMediaViewed(h.pool, id, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if done {
		_ = h.mediaStore.Delete(id)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *GroupsHandler) UnsendMedia(c echo.Context) error {
	id, me, err := groupMediaID(c)
	if err != nil {
		return err
	}
	deleted, err := models.UnsendGroupMedia(h.pool, id, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if deleted {
		_ = h.mediaStore.Delete(id)
	}
	return c.NoContent(http.StatusNoContent)
}
