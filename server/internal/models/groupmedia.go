package models

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CreateGroupMedia stores a group chat moment / voice message for all other accepted members
// (except those blocked by or blocking the sender). Returns the recipients.
func CreateGroupMedia(pool *pgxpool.Pool, id, groupID, sender, mediaType string, size int64) ([]string, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`INSERT INTO group_media (id, group_id, sender_id, media_type, file_size, expires_at)
		 VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')`,
		id, groupID, sender, mediaType, size); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx,
		`INSERT INTO group_media_pending (media_id, user_id)
		 SELECT $1, gm.user_id FROM group_memberships gm
		 WHERE gm.group_id = $2 AND gm.status = 'member' AND gm.user_id <> $3
		   AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
		         (b.blocker_id = $3 AND b.blocked_id = gm.user_id) OR (b.blocker_id = gm.user_id AND b.blocked_id = $3))
		 RETURNING user_id::text`,
		id, groupID, sender)
	if err != nil {
		return nil, err
	}
	var recipients []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			rows.Close()
			return nil, err
		}
		recipients = append(recipients, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return recipients, tx.Commit(ctx)
}

// GroupMediaForRecipient returns the media type if user still may download it.
func GroupMediaForRecipient(pool *pgxpool.Pool, id, user string) (string, error) {
	var mt string
	err := pool.QueryRow(context.Background(),
		`SELECT m.media_type FROM group_media m
		 JOIN group_media_pending p ON p.media_id = m.id
		 JOIN group_memberships gm ON gm.group_id = m.group_id AND gm.user_id = p.user_id AND gm.status = 'member'
		 WHERE m.id = $1 AND p.user_id = $2 AND m.expires_at > NOW()`,
		id, user).Scan(&mt)
	return mt, err
}

// MarkGroupMediaViewed removes the user from the pending list. done = nobody is left, the
// blob can be deleted (the row is gone then).
func MarkGroupMediaViewed(pool *pgxpool.Pool, id, user string) (done bool, err error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM group_media_pending WHERE media_id = $1 AND user_id = $2`, id, user)
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	var left int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM group_media_pending WHERE media_id = $1`, id).Scan(&left); err != nil {
		return false, err
	}
	if left == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM group_media WHERE id = $1`, id); err != nil {
			return false, err
		}
		done = true
	}
	return done, tx.Commit(ctx)
}

// UnsendGroupMedia deletes the sender's own group media.
func UnsendGroupMedia(pool *pgxpool.Pool, id, sender string) (bool, error) {
	tag, err := pool.Exec(context.Background(), `DELETE FROM group_media WHERE id = $1 AND sender_id = $2`, id, sender)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// FinishedGroupMediaIDs: expired, or nobody left to open it (e.g. after members left).
func FinishedGroupMediaIDs(pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT id::text FROM group_media m WHERE m.expires_at <= NOW()
		    OR (m.created_at < NOW() - INTERVAL '1 minute'
		        AND NOT EXISTS (SELECT 1 FROM group_media_pending p WHERE p.media_id = m.id))`)
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

func DeleteGroupMediaByID(pool *pgxpool.Pool, id string) error {
	_, err := pool.Exec(context.Background(), `DELETE FROM group_media WHERE id = $1`, id)
	return err
}

// groupMediaOfUser: storage keys of group media sent by the user or living in groups the
// user owns and that will be deleted with the account.
func groupMediaOfUser(ctx context.Context, tx pgx.Tx, userID string) ([]string, error) {
	return groupMediaKeys(ctx, tx,
		`sender_id = $1 OR group_id IN (SELECT id FROM groups WHERE owner_id = $1)`, userID)
}

// GroupPendingMedia counts group media that is still waiting for someone to open it.
func GroupPendingMedia(pool *pgxpool.Pool, groupID string) (int, error) {
	var n int
	err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM group_media WHERE group_id = $1 AND expires_at > NOW()`, groupID).Scan(&n)
	return n, err
}
