package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

// StoriesHandler: a story is one encrypted blob plus, for every friend the owner picked,
// an end-to-end encrypted envelope with the blob's key. Friends without an envelope cannot
// even see that the story exists. Everything is deleted 24 hours after posting.
type StoriesHandler struct {
	pool    *pgxpool.Pool
	storage storage.Storage
	quota   *MediaQuota
}

func NewStoriesHandler(pool *pgxpool.Pool, store storage.Storage, quota *MediaQuota) *StoriesHandler {
	return &StoriesHandler{pool: pool, storage: store, quota: quota}
}

type storyKeyIn struct {
	ViewerID string `json:"viewer_id"`
	Envelope string `json:"envelope"`
}

// Create: multipart with encrypted_file, media_type and keys (JSON [{viewer_id, envelope}]).
func (h *StoriesHandler) Create(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	if err := parseUpload(c); err != nil {
		return err
	}
	mediaType := c.FormValue("media_type")
	if mediaType != "image" && mediaType != "video" {
		return echo.NewHTTPError(http.StatusBadRequest, "media_type must be 'image' or 'video'")
	}
	var in []storyKeyIn
	if err := json.Unmarshal([]byte(c.FormValue("keys")), &in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid keys")
	}
	if len(in) == 0 || len(in) > models.StoryMaxViewers {
		return echo.NewHTTPError(http.StatusBadRequest, "pick between 1 and 500 friends")
	}
	keys := make([]models.StoryKey, 0, len(in))
	seen := map[string]bool{}
	for _, k := range in {
		id, err := uuid.Parse(k.ViewerID)
		if err != nil || id.String() == me || seen[id.String()] {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid viewer_id")
		}
		seen[id.String()] = true
		env, err := base64.StdEncoding.DecodeString(k.Envelope)
		if err != nil || len(env) == 0 || len(env) > models.StoryMaxEnvelope {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid envelope")
		}
		keys = append(keys, models.StoryKey{ViewerID: id.String(), Envelope: env})
	}

	file, err := c.FormFile("encrypted_file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "encrypted_file required")
	}
	if file.Size <= 0 || file.Size > MaxMediaBytes {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "file too large")
	}
	if h.quota != nil {
		if err := h.quota.CheckStory(h.pool, h.storage, me, file.Size); err != nil {
			return err
		}
	}
	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not open file")
	}
	defer src.Close()

	id := uuid.New().String()
	if err := h.storage.Save(id, src); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store file")
	}
	expires, err := models.CreateStory(h.pool, id, me, mediaType, file.Size, keys)
	if err != nil {
		h.storage.Delete(id)
		if errors.Is(err, models.ErrNotAllowed) {
			return echo.NewHTTPError(http.StatusForbidden, "stories can only be shared with friends")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store story")
	}
	return c.JSON(http.StatusCreated, map[string]any{"id": id, "expires_at": expires})
}

type storyOut struct {
	ID            string    `json:"id"`
	OwnerID       string    `json:"owner_id"`
	OwnerUsername string    `json:"owner_username"`
	MediaType     string    `json:"media_type"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	Envelope      string    `json:"envelope"`
}

// List returns the friends' stories visible to the caller and the caller's own ones.
func (h *StoriesHandler) List(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	friends, err := models.StoriesForViewer(h.pool, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	mine, err := models.OwnStories(h.pool, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	out := make([]storyOut, 0, len(friends))
	for _, s := range friends {
		out = append(out, storyOut{
			ID: s.ID, OwnerID: s.OwnerID, OwnerUsername: s.OwnerUsername, MediaType: s.MediaType,
			CreatedAt: s.CreatedAt, ExpiresAt: s.ExpiresAt, Envelope: base64.StdEncoding.EncodeToString(s.Envelope),
		})
	}
	return c.JSON(http.StatusOK, map[string]any{"friends": out, "mine": mine})
}

// Download streams the encrypted blob to the owner or an allowed viewer.
func (h *StoriesHandler) Download(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "story not found")
	}
	readable, err := models.StoryReadable(h.pool, id, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !readable {
		return echo.NewHTTPError(http.StatusNotFound, "story not found")
	}
	f, err := h.storage.Load(id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "story not found")
	}
	defer f.Close()
	return c.Stream(http.StatusOK, "application/octet-stream", f)
}

// Delete removes one of the caller's own stories right away.
func (h *StoriesHandler) Delete(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	deleted, err := models.DeleteOwnStory(h.pool, id, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !deleted {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	_ = h.storage.Delete(id)
	return c.NoContent(http.StatusNoContent)
}
