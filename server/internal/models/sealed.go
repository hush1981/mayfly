package models

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrTokenTaken: another account already uses this delivery token hash (practically only
// if a client reuses a token on purpose).
var ErrTokenTaken = errors.New("delivery token already in use")

// SetDeliveryTokenHash replaces the user's delivery token (old tokens stop working at once).
func SetDeliveryTokenHash(pool *pgxpool.Pool, userID string, hash []byte) error {
	_, err := pool.Exec(context.Background(), `UPDATE users SET delivery_token_hash = $2 WHERE id = $1`, userID, hash)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrTokenTaken
	}
	return err
}

// UserByDeliveryTokenHash returns the user id for a token hash ("" if none).
func UserByDeliveryTokenHash(pool *pgxpool.Pool, hash []byte) (string, error) {
	var id string
	err := pool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE delivery_token_hash = $1`, hash).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return id, err
}

// PendingForRecipient counts unopened moments waiting for a user.
func PendingForRecipient(pool *pgxpool.Pool, recipient string) (int, error) {
	var n int
	err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM media WHERE recipient_id = $1 AND viewed_at IS NULL`, recipient).Scan(&n)
	return n, err
}

// UnsendSealedMedia deletes a sealed moment that is still unopened, if the unsend secret matches.
// Returns the storage path to delete ("" if nothing matched).
func UnsendSealedMedia(pool *pgxpool.Pool, mediaID string, unsendHash []byte) (string, error) {
	var path string
	err := pool.QueryRow(context.Background(),
		`DELETE FROM media WHERE id = $1 AND sender_id IS NULL AND unsend_hash = $2 AND viewed_at IS NULL
		 RETURNING storage_path`, mediaID, unsendHash).Scan(&path)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return path, err
}
