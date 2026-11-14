package models

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// RelayMessage is an end-to-end encrypted message between two clients. The server
// cannot read Payload; it only routes it and deletes it once acknowledged.
type RelayMessage struct {
	ID                 string
	SenderID           string
	EphemeralPublicKey []byte
	Nonce              []byte
	Payload            []byte
	CreatedAt          time.Time
}

// Room for a 1000-character text message or a call offer (SDP), plus ratchet / sealed-sender overhead.
const RelayMaxPayload = 24576

// Queue limits per recipient. Nobody can push somebody else's messages out of the queue:
//   - RelayMaxPending bounds everything waiting for one recipient; when it is reached, new
//     messages are refused (the sender's app keeps them and tries again later);
//   - one logged-in sender may have RelayMaxPerSender waiting — beyond that its own oldest
//     messages make room (a misbehaving client only loses its own messages);
//   - sealed-sender messages have no sender the server could tell apart, so they share one
//     bucket of RelayMaxSealed and are refused when it is full. The sender's app then falls
//     back to a normal (logged-in) delivery.
const (
	RelayMaxPending   = 500
	RelayMaxPerSender = 100
	RelayMaxSealed    = 300
)

// ErrRelayQueueFull: the recipient's queue has no room for this message right now.
var ErrRelayQueueFull = errors.New("relay queue full")

// CreateRelayMessage stores a message; senderID "" = sealed sender (no sender stored).
func CreateRelayMessage(pool *pgxpool.Pool, senderID, recipientID string, eph, nonce, payload []byte) error {
	ctx := context.Background()
	var sender interface{}
	if senderID != "" {
		sender = senderID
	}
	var total, mine int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*), COUNT(*) FILTER (WHERE sender_id IS NOT DISTINCT FROM $2::uuid)
		 FROM relay_messages WHERE recipient_id = $1`, recipientID, sender,
	).Scan(&total, &mine); err != nil {
		return err
	}
	if senderID == "" {
		if mine >= RelayMaxSealed || total >= RelayMaxPending {
			return ErrRelayQueueFull
		}
	} else {
		if mine >= RelayMaxPerSender {
			drop := mine - RelayMaxPerSender + 1
			if _, err := pool.Exec(ctx,
				`DELETE FROM relay_messages WHERE id IN (
				   SELECT id FROM relay_messages WHERE recipient_id = $1 AND sender_id = $2
				   ORDER BY created_at ASC LIMIT $3)`,
				recipientID, senderID, drop); err != nil {
				return err
			}
			total -= drop
		}
		if total >= RelayMaxPending {
			return ErrRelayQueueFull
		}
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO relay_messages (sender_id, recipient_id, ephemeral_public_key, nonce, payload)
		 VALUES ($1, $2, $3, $4, $5)`,
		sender, recipientID, eph, nonce, payload)
	return err
}

func GetRelayMessages(pool *pgxpool.Pool, recipientID string) ([]RelayMessage, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT id, COALESCE(sender_id::text, ''), ephemeral_public_key, nonce, payload, created_at
		 FROM relay_messages WHERE recipient_id = $1 ORDER BY created_at ASC LIMIT 200`,
		recipientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RelayMessage
	for rows.Next() {
		var m RelayMessage
		if err := rows.Scan(&m.ID, &m.SenderID, &m.EphemeralPublicKey, &m.Nonce, &m.Payload, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AckRelayMessages deletes the given messages, but only those addressed to recipientID.
func AckRelayMessages(pool *pgxpool.Pool, recipientID string, ids []string) error {
	_, err := pool.Exec(context.Background(),
		`DELETE FROM relay_messages WHERE recipient_id = $1 AND id = ANY($2::uuid[])`,
		recipientID, ids)
	return err
}

func PurgeOldRelayMessages(pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(context.Background(),
		`DELETE FROM relay_messages WHERE created_at < NOW() - INTERVAL '24 hours'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
