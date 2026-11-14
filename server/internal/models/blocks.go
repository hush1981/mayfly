package models

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Block records that blocker blocked blocked, and removes everything that connects the
// two: the friendship (in any state), pending moments and pending chat messages in both
// directions. Returns the storage paths of the deleted moments.
func Block(pool *pgxpool.Pool, blocker, blocked string) ([]string, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		blocker, blocked); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
		blocker, blocked); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx,
		`DELETE FROM media WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
		 RETURNING storage_path`, blocker, blocked)
	if err != nil {
		return nil, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return nil, err
		}
		paths = append(paths, p)
	}
	rows.Close()
	if _, err := tx.Exec(ctx,
		`DELETE FROM relay_messages WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`,
		blocker, blocked); err != nil {
		return nil, err
	}
	// Neither side can open the other's stories any more.
	if _, err := tx.Exec(ctx,
		`DELETE FROM story_keys k USING stories s WHERE s.id = k.story_id AND
		   ((s.owner_id = $1 AND k.viewer_id = $2) OR (s.owner_id = $2 AND k.viewer_id = $1))`,
		blocker, blocked); err != nil {
		return nil, err
	}
	return paths, tx.Commit(ctx)
}

// Unblock removes a block. Friendship is not restored.
func Unblock(pool *pgxpool.Pool, blocker, blocked string) error {
	_, err := pool.Exec(context.Background(),
		`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, blocker, blocked)
	return err
}

// ListBlocked returns the users blocker has blocked.
func ListBlocked(pool *pgxpool.Pool, blocker string) ([]UserPublic, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT u.id, u.username FROM blocks b JOIN users u ON u.id = b.blocked_id
		 WHERE b.blocker_id = $1 ORDER BY u.username`, blocker)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserPublic{}
	for rows.Next() {
		var u UserPublic
		if err := rows.Scan(&u.ID, &u.Username); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// HasBlocked reports whether blocker blocked blocked.
func HasBlocked(pool *pgxpool.Pool, blocker, blocked string) (bool, error) {
	var ok bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2)`, blocker, blocked).Scan(&ok)
	return ok, err
}

// IsBlockedEither reports whether one of the two users blocked the other.
func IsBlockedEither(pool *pgxpool.Pool, a, b string) (bool, error) {
	var ok bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1))`,
		a, b).Scan(&ok)
	return ok, err
}

// DeletePendingMediaBySender deletes a moment the sender wants back, as long as the
// recipient has not opened it yet. Returns the storage path ("" = nothing deleted).
func DeletePendingMediaBySender(pool *pgxpool.Pool, mediaID, senderID string) (string, error) {
	var path string
	err := pool.QueryRow(context.Background(),
		`DELETE FROM media WHERE id = $1 AND sender_id = $2 AND viewed_at IS NULL RETURNING storage_path`,
		mediaID, senderID).Scan(&path)
	if err != nil {
		return "", err
	}
	return path, nil
}
