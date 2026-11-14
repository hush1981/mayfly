package models

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Media struct {
	ID                 string     `json:"id"`
	SenderID           string     `json:"sender_id"`
	RecipientID        string     `json:"recipient_id"`
	GroupID            *string    `json:"group_id,omitempty"`
	storagePath        string     // never exposed in JSON
	EphemeralPublicKey []byte     `json:"-"`
	Nonce              []byte     `json:"-"`
	MediaType          string     `json:"media_type"`
	FileSize           int64      `json:"file_size"`
	ExpiresAt          time.Time  `json:"expires_at"`
	ViewedAt           *time.Time `json:"viewed_at,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}

type MediaInboxItem struct {
	ID             string    `json:"id"`
	SenderID       string    `json:"sender_id"`
	SenderUsername string    `json:"sender_username"`
	GroupID        *string   `json:"group_id,omitempty"`
	GroupName      *string   `json:"group_name,omitempty"`
	MediaType      string    `json:"media_type"`
	FileSize       int64     `json:"file_size"`
	CreatedAt      time.Time `json:"created_at"`
	// Sealed sender: SenderID / SenderUsername are empty, the sender is inside this
	// end-to-end encrypted header (base64 in JSON).
	SealedHeader []byte `json:"sealed_header,omitempty"`
}

type CreateMediaParams struct {
	ID                 string // pre-generated UUID, also used as storage_path
	SenderID           string
	RecipientID        string
	GroupID            *string // nil = direct moment (no group)
	EphemeralPublicKey []byte
	Nonce              []byte
	MediaType          string
	FileSize           int64
	// Sealed sender (SenderID ""): encrypted header with the sender + hash of the unsend secret.
	SealedHeader []byte
	UnsendHash   []byte
}

func CreateMedia(pool *pgxpool.Pool, p CreateMediaParams) (*Media, error) {
	m := &Media{}
	var sender interface{}
	if p.SenderID != "" {
		sender = p.SenderID
	}
	// $1=id (uuid), $4=storage_path (text) — same value passed twice so Postgres
	// can resolve each column's type independently (avoids SQLSTATE 42P08).
	err := pool.QueryRow(context.Background(),
		`INSERT INTO media (id, sender_id, recipient_id, storage_path, ephemeral_public_key, nonce, media_type, file_size, expires_at, group_id, sealed_header, unsend_hash)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours', $9::uuid, $10, $11)
		 RETURNING id, COALESCE(sender_id::text, ''), recipient_id, group_id, media_type, file_size, expires_at, created_at`,
		p.ID, sender, p.RecipientID, p.ID,
		p.EphemeralPublicKey, p.Nonce, p.MediaType, p.FileSize, p.GroupID, p.SealedHeader, p.UnsendHash,
	).Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.GroupID, &m.MediaType, &m.FileSize, &m.ExpiresAt, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func GetInbox(pool *pgxpool.Pool, recipientID string) ([]MediaInboxItem, error) {
	rows, err := pool.Query(context.Background(),
		// (no group columns: which broadcast list a moment was sent through is the sender's business)
		`SELECT m.id, COALESCE(m.sender_id::text, ''), COALESCE(u.username, ''), NULL::uuid, NULL::text, m.media_type, m.file_size, m.created_at, m.sealed_header
		 FROM media m
		 LEFT JOIN users u ON u.id = m.sender_id
		 WHERE m.recipient_id = $1 AND m.viewed_at IS NULL
		 ORDER BY m.created_at DESC`,
		recipientID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []MediaInboxItem
	for rows.Next() {
		var item MediaInboxItem
		if err := rows.Scan(&item.ID, &item.SenderID, &item.SenderUsername, &item.GroupID, &item.GroupName, &item.MediaType, &item.FileSize, &item.CreatedAt, &item.SealedHeader); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GetMediaForDownload returns a media row only if the requesting user is the recipient.
func GetMediaForDownload(pool *pgxpool.Pool, mediaID, recipientID string) (*Media, error) {
	m := &Media{}
	err := pool.QueryRow(context.Background(),
		`SELECT id, COALESCE(sender_id::text, ''), recipient_id, storage_path, ephemeral_public_key, nonce, media_type, file_size, expires_at, created_at
		 FROM media
		 WHERE id = $1 AND recipient_id = $2 AND viewed_at IS NULL`,
		mediaID, recipientID,
	).Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.storagePath, &m.EphemeralPublicKey, &m.Nonce, &m.MediaType, &m.FileSize, &m.ExpiresAt, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Media) StoragePath() string {
	return m.storagePath
}

// MarkViewed atomically marks a media row as viewed and returns the storage path.
// wasUpdated is false if the row didn't exist, belongs to another user, or was already viewed.
func MarkViewed(pool *pgxpool.Pool, mediaID, recipientID string) (storagePath string, wasUpdated bool, err error) {
	err = pool.QueryRow(context.Background(),
		`UPDATE media SET viewed_at = NOW()
		 WHERE id = $1 AND recipient_id = $2 AND viewed_at IS NULL
		 RETURNING storage_path`,
		mediaID, recipientID,
	).Scan(&storagePath)
	if err == pgx.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return storagePath, true, nil
}

// ExpiredUnviewed returns storage paths and IDs of media that has passed its TTL without being viewed.
type ExpiredMedia struct {
	ID          string
	StoragePath string
}

func GetExpiredUnviewed(pool *pgxpool.Pool) ([]ExpiredMedia, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT id, storage_path FROM media
		 WHERE expires_at < NOW() AND viewed_at IS NULL`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []ExpiredMedia
	for rows.Next() {
		var e ExpiredMedia
		if err := rows.Scan(&e.ID, &e.StoragePath); err != nil {
			return nil, err
		}
		items = append(items, e)
	}
	return items, rows.Err()
}

// GetViewedLeftovers returns media that was opened but whose row (or file) could not be
// deleted at that moment, so the cleanup can finish the job.
func GetViewedLeftovers(pool *pgxpool.Pool) ([]ExpiredMedia, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT id, storage_path FROM media WHERE viewed_at IS NOT NULL AND viewed_at < NOW() - INTERVAL '5 minutes'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []ExpiredMedia
	for rows.Next() {
		var e ExpiredMedia
		if err := rows.Scan(&e.ID, &e.StoragePath); err != nil {
			return nil, err
		}
		items = append(items, e)
	}
	return items, rows.Err()
}

func DeleteMediaByID(pool *pgxpool.Pool, mediaID string) error {
	_, err := pool.Exec(context.Background(),
		`DELETE FROM media WHERE id = $1`,
		mediaID,
	)
	return err
}

// PendingStats counts unopened moments of a sender (count + bytes) and of a recipient.
type PendingStats struct {
	SenderCount    int
	SenderBytes    int64
	RecipientCount int
}

func PendingMediaStats(pool *pgxpool.Pool, sender, recipient string) (PendingStats, error) {
	var st PendingStats
	err := pool.QueryRow(context.Background(),
		`SELECT
		   COUNT(*) FILTER (WHERE sender_id = $1),
		   COALESCE(SUM(file_size) FILTER (WHERE sender_id = $1), 0),
		   COUNT(*) FILTER (WHERE recipient_id = $2)
		 FROM media WHERE viewed_at IS NULL AND (sender_id = $1 OR recipient_id = $2)`,
		sender, recipient,
	).Scan(&st.SenderCount, &st.SenderBytes, &st.RecipientCount)
	return st, err
}
