package models

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Stories can be watched for 24 hours (expires_at = created + 24 h); the cleanup deletes them afterwards.

// ErrNotAllowed: a viewer is not a friend of the owner (or one of them blocked the other).
var ErrNotAllowed = errors.New("not allowed")

// StoryMaxViewers caps the per-viewer key envelopes of one story.
const StoryMaxViewers = 500

// StoryMaxEnvelope is the largest accepted key envelope (an end-to-end encrypted ~200 bytes).
const StoryMaxEnvelope = 2048

// StoryKey is the encrypted envelope for one viewer (only that viewer can open it).
type StoryKey struct {
	ViewerID string
	Envelope []byte
}

// StoryForViewer is a friend's story as listed to one allowed viewer.
type StoryForViewer struct {
	ID            string    `json:"id"`
	OwnerID       string    `json:"owner_id"`
	OwnerUsername string    `json:"owner_username"`
	MediaType     string    `json:"media_type"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	Envelope      []byte    `json:"-"`
}

// OwnStory is one of the user's own active stories.
type OwnStory struct {
	ID        string    `json:"id"`
	MediaType string    `json:"media_type"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Audience  int       `json:"audience"`
}

// CreateStory stores the story row and its key envelopes in one transaction.
// Every viewer must be an accepted friend of the owner and not blocked either way.
// Returns ErrNotAllowed if any viewer fails that check (nothing is stored then).
func CreateStory(pool *pgxpool.Pool, id, owner, mediaType string, size int64, keys []StoryKey) (time.Time, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback(ctx)

	viewers := make([]string, 0, len(keys))
	for _, k := range keys {
		viewers = append(viewers, k.ViewerID)
	}
	var allowed int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(DISTINCT v) FROM unnest($2::uuid[]) AS v
		 WHERE EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND
		         ((f.requester_id = $1 AND f.addressee_id = v) OR (f.requester_id = v AND f.addressee_id = $1)))
		   AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
		         (b.blocker_id = $1 AND b.blocked_id = v) OR (b.blocker_id = v AND b.blocked_id = $1))`,
		owner, viewers).Scan(&allowed); err != nil {
		return time.Time{}, err
	}
	if allowed != len(viewers) {
		return time.Time{}, ErrNotAllowed
	}

	var expires time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO stories (id, owner_id, media_type, file_size, expires_at)
		 VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours') RETURNING expires_at`,
		id, owner, mediaType, size).Scan(&expires); err != nil {
		return time.Time{}, err
	}
	rows := make([][]any, 0, len(keys))
	for _, k := range keys {
		rows = append(rows, []any{id, k.ViewerID, k.Envelope})
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"story_keys"}, []string{"story_id", "viewer_id", "envelope"},
		pgx.CopyFromRows(rows)); err != nil {
		return time.Time{}, err
	}
	return expires, tx.Commit(ctx)
}

// storyVisible is the access rule for viewers: a key envelope exists, the story is not
// expired, the two are (still) friends and neither blocked the other.
const storyVisible = `
	s.expires_at > NOW()
	AND EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND
	      ((f.requester_id = s.owner_id AND f.addressee_id = k.viewer_id) OR (f.requester_id = k.viewer_id AND f.addressee_id = s.owner_id)))
	AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
	      (b.blocker_id = s.owner_id AND b.blocked_id = k.viewer_id) OR (b.blocker_id = k.viewer_id AND b.blocked_id = s.owner_id))`

// StoriesForViewer lists the friends' stories the viewer may watch, oldest first.
func StoriesForViewer(pool *pgxpool.Pool, viewer string) ([]StoryForViewer, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT s.id, s.owner_id, u.username, s.media_type, s.created_at, s.expires_at, k.envelope
		 FROM story_keys k
		 JOIN stories s ON s.id = k.story_id
		 JOIN users u ON u.id = s.owner_id
		 WHERE k.viewer_id = $1 AND `+storyVisible+`
		 ORDER BY s.created_at ASC
		 LIMIT 1000`, viewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StoryForViewer{}
	for rows.Next() {
		var s StoryForViewer
		if err := rows.Scan(&s.ID, &s.OwnerID, &s.OwnerUsername, &s.MediaType, &s.CreatedAt, &s.ExpiresAt, &s.Envelope); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// OwnStories lists the owner's active stories with the size of their audience.
func OwnStories(pool *pgxpool.Pool, owner string) ([]OwnStory, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT s.id, s.media_type, s.created_at, s.expires_at,
		        (SELECT COUNT(*) FROM story_keys k WHERE k.story_id = s.id)
		 FROM stories s WHERE s.owner_id = $1 AND s.expires_at > NOW()
		 ORDER BY s.created_at ASC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OwnStory{}
	for rows.Next() {
		var s OwnStory
		if err := rows.Scan(&s.ID, &s.MediaType, &s.CreatedAt, &s.ExpiresAt, &s.Audience); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// StoryReadable reports whether user may download the story blob (owner or allowed viewer).
func StoryReadable(pool *pgxpool.Pool, storyID, user string) (bool, error) {
	var ok bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM stories s WHERE s.id = $1 AND s.owner_id = $2 AND s.expires_at > NOW())
		     OR EXISTS (SELECT 1 FROM story_keys k JOIN stories s ON s.id = k.story_id
		                WHERE k.story_id = $1 AND k.viewer_id = $2 AND `+storyVisible+`)`,
		storyID, user).Scan(&ok)
	return ok, err
}

// DeleteOwnStory removes a story of owner; returns false if there was none.
func DeleteOwnStory(pool *pgxpool.Pool, storyID, owner string) (bool, error) {
	tag, err := pool.Exec(context.Background(),
		`DELETE FROM stories WHERE id = $1 AND owner_id = $2`, storyID, owner)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// OwnerStoryStats counts the owner's active stories and their bytes (for upload limits).
func OwnerStoryStats(pool *pgxpool.Pool, owner string) (count int, bytes int64, err error) {
	err = pool.QueryRow(context.Background(),
		`SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM stories WHERE owner_id = $1 AND expires_at > NOW()`,
		owner).Scan(&count, &bytes)
	return
}

// ExpiredStoryIDs returns stories past their lifetime (their id is also the storage key).
func ExpiredStoryIDs(pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(context.Background(), `SELECT id FROM stories WHERE expires_at <= NOW()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func DeleteStoryByID(pool *pgxpool.Pool, id string) error {
	_, err := pool.Exec(context.Background(), `DELETE FROM stories WHERE id = $1`, id)
	return err
}
