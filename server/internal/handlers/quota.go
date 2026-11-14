package handlers

import (
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

// MediaQuota keeps the server's disk from filling up. Kept deliberately simple (user, 2026-11-14):
// unopened moments per sender, waiting moments per recipient, unopened media per group chat, story
// megabytes per owner, and a minimum of free disk space. All values can be changed with
// environment variables; GET /limits reports them (the app shows them).
type MediaQuota struct {
	MaxPendingPerSender    int
	MaxPendingPerRecipient int
	MaxPendingPerGroup     int
	MaxStoryBytes          int64
	MinFreeBytes           uint64
}

func envInt64(name string, def int64) int64 {
	if v, err := strconv.ParseInt(os.Getenv(name), 10, 64); err == nil && v > 0 {
		return v
	}
	return def
}

// NewMediaQuotaFromEnv reads MEDIA_MAX_PENDING_PER_SENDER (100), MEDIA_MAX_PENDING_PER_RECIPIENT (200),
// MEDIA_MAX_PENDING_PER_GROUP (200), STORY_MAX_MB (300 MB of active stories per user) and
// MEDIA_MIN_FREE_MB (1024).
func NewMediaQuotaFromEnv() *MediaQuota {
	return &MediaQuota{
		MaxPendingPerSender:    int(envInt64("MEDIA_MAX_PENDING_PER_SENDER", 100)),
		MaxPendingPerRecipient: int(envInt64("MEDIA_MAX_PENDING_PER_RECIPIENT", 200)),
		MaxPendingPerGroup:     int(envInt64("MEDIA_MAX_PENDING_PER_GROUP", 200)),
		MaxStoryBytes:          envInt64("STORY_MAX_MB", 300) << 20,
		MinFreeBytes:           uint64(envInt64("MEDIA_MIN_FREE_MB", 1024)) << 20,
	}
}

// quotaError carries a machine-readable code so the app can explain it and point to
// self-hosting ("this server is shared and has limits — you can run your own").
func quotaError(status int, code, msg string) error {
	return echo.NewHTTPError(status, map[string]string{"message": msg, "code": code})
}

type freeSpacer interface{ FreeBytes() (uint64, error) }

// Check runs before an upload of size bytes from sender to recipient.
func (q *MediaQuota) Check(pool *pgxpool.Pool, store storage.Storage, sender, recipient string, size int64) error {
	if q.diskFull(store, size) {
		return quotaError(http.StatusInsufficientStorage, "server_full", "this server is out of storage right now — try again later")
	}
	st, err := models.PendingMediaStats(pool, sender, recipient)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not check limits")
	}
	if st.SenderCount >= q.MaxPendingPerSender {
		return quotaError(http.StatusTooManyRequests, "quota", "too many unopened moments — wait until your friends opened some")
	}
	if st.RecipientCount >= q.MaxPendingPerRecipient {
		return quotaError(http.StatusTooManyRequests, "quota", "this friend has too many unopened moments")
	}
	return nil
}

func (q *MediaQuota) diskFull(store storage.Storage, size int64) bool {
	if fs, ok := store.(freeSpacer); ok {
		if free, err := fs.FreeBytes(); err == nil && free < q.MinFreeBytes+uint64(size) {
			return true
		}
	}
	return false
}

// CheckStory runs before a story upload: disk space and the owner's active story megabytes.
func (q *MediaQuota) CheckStory(pool *pgxpool.Pool, store storage.Storage, owner string, size int64) error {
	if q.diskFull(store, size) {
		return quotaError(http.StatusInsufficientStorage, "server_full", "this server is out of storage right now — try again later")
	}
	_, bytes, err := models.OwnerStoryStats(pool, owner)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not check limits")
	}
	if bytes+size > q.MaxStoryBytes {
		return quotaError(http.StatusTooManyRequests, "quota", "your active stories are too big together — wait until older ones expire")
	}
	return nil
}

// CheckGroupMedia runs before a group chat upload (one blob for all members): unopened
// media per group chat.
func (q *MediaQuota) CheckGroupMedia(pool *pgxpool.Pool, store storage.Storage, groupID string, size int64) error {
	if q.diskFull(store, size) {
		return quotaError(http.StatusInsufficientStorage, "server_full", "this server is out of storage right now — try again later")
	}
	n, err := models.GroupPendingMedia(pool, groupID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not check limits")
	}
	if n >= q.MaxPendingPerGroup {
		return quotaError(http.StatusTooManyRequests, "quota", "this group has too many unopened moments — wait until they were opened")
	}
	return nil
}

// CheckSealed runs before a sealed-sender upload: there is no sender account, so only the
// recipient's waiting moments are limited (plus the per-IP request rate limit).
func (q *MediaQuota) CheckSealed(pool *pgxpool.Pool, store storage.Storage, recipient string, size int64) error {
	if q.diskFull(store, size) {
		return quotaError(http.StatusInsufficientStorage, "server_full", "this server is out of storage right now — try again later")
	}
	n, err := models.PendingForRecipient(pool, recipient)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not check limits")
	}
	if n >= q.MaxPendingPerRecipient {
		return quotaError(http.StatusTooManyRequests, "quota", "this friend has too many unopened moments")
	}
	return nil
}

// Limits: GET /limits (public) — what this server allows, for the app's "server limits" page.
func (q *MediaQuota) Limits(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]interface{}{
		"pending_moments_per_sender":    q.MaxPendingPerSender,
		"pending_moments_per_recipient": q.MaxPendingPerRecipient,
		"pending_moments_per_group":     q.MaxPendingPerGroup,
		"pending_messages_per_user":   models.RelayMaxPending,
		"pending_messages_per_sender": models.RelayMaxPerSender,
		"story_mb":                    q.MaxStoryBytes >> 20,
		"group_members":               models.GroupChatMaxMembers,
		"keep_hours":                  24,
		"call_mbit":                   envInt64("CALL_MAX_MBIT", 4),
		"min_free_mb":                 q.MinFreeBytes >> 20,
		"video_seconds":               30,
	})
}
