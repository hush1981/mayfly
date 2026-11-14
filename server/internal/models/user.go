package models

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	PublicKey    []byte    `json:"-"`
	TokenVersion int       `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
}

type UserPublic struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func CreateUser(pool *pgxpool.Pool, username, passwordHash string, publicKey []byte) (*User, error) {
	u := &User{}
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (username, password_hash, public_key)
		 VALUES ($1, $2, $3)
		 RETURNING id, username, created_at`,
		username, passwordHash, publicKey,
	).Scan(&u.ID, &u.Username, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

// GetUserByUsername finds an account by name. Names are unique regardless of case
// (migration 016), so "Anna" and "anna" are the same account.
func GetUserByUsername(pool *pgxpool.Pool, username string) (*User, error) {
	u := &User{}
	err := pool.QueryRow(context.Background(),
		`SELECT id, username, password_hash, public_key, token_version, created_at FROM users WHERE lower(username) = lower($1)`,
		username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.PublicKey, &u.TokenVersion, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func GetUserByID(pool *pgxpool.Pool, id string) (*User, error) {
	u := &User{}
	err := pool.QueryRow(context.Background(),
		`SELECT id, username, password_hash, public_key, token_version, created_at FROM users WHERE id = $1`,
		id,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.PublicKey, &u.TokenVersion, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func GetUserPublicKey(pool *pgxpool.Pool, userID string) ([]byte, error) {
	var key []byte
	err := pool.QueryRow(context.Background(),
		`SELECT public_key FROM users WHERE id = $1`,
		userID,
	).Scan(&key)
	return key, err
}

// GetPushEndpoint returns the user's UnifiedPush endpoint ("" if push is off).
func GetPushEndpoint(pool *pgxpool.Pool, userID string) (string, error) {
	var ep *string
	err := pool.QueryRow(context.Background(), `SELECT push_endpoint FROM users WHERE id = $1`, userID).Scan(&ep)
	if err != nil || ep == nil {
		return "", err
	}
	return *ep, nil
}

func SetPushEndpoint(pool *pgxpool.Pool, userID, endpoint string) error {
	var v interface{}
	if endpoint != "" {
		v = endpoint
	}
	_, err := pool.Exec(context.Background(), `UPDATE users SET push_endpoint = $1 WHERE id = $2`, v, userID)
	return err
}

// ClearPushEndpointIf forgets an endpoint the push server reported as gone,
// unless the user registered a new one meanwhile.
func ClearPushEndpointIf(pool *pgxpool.Pool, userID, endpoint string) {
	pool.Exec(context.Background(),
		`UPDATE users SET push_endpoint = NULL WHERE id = $1 AND push_endpoint = $2`, userID, endpoint)
}

func SetUserHasAvatar(pool *pgxpool.Pool, userID string, has bool) error {
	_, err := pool.Exec(context.Background(),
		`UPDATE users SET has_avatar = $1 WHERE id = $2`,
		has, userID,
	)
	return err
}

func GetUserHasAvatar(pool *pgxpool.Pool, userID string) (bool, error) {
	var has bool
	err := pool.QueryRow(context.Background(),
		`SELECT has_avatar FROM users WHERE id = $1`,
		userID,
	).Scan(&has)
	return has, err
}

func SetUserPublicKey(pool *pgxpool.Pool, userID string, key []byte) error {
	_, err := pool.Exec(context.Background(), `UPDATE users SET public_key = $1 WHERE id = $2`, key, userID)
	return err
}

// UserAuthState is used by the auth middleware: deleted accounts lose access immediately,
// and tokens with an outdated version (password changed since) are rejected.
func UserAuthState(pool *pgxpool.Pool, userID string) (exists bool, tokenVersion int, err error) {
	err = pool.QueryRow(context.Background(),
		`SELECT token_version FROM users WHERE id = $1`, userID).Scan(&tokenVersion)
	if err == pgx.ErrNoRows {
		return false, 0, nil
	}
	return err == nil, tokenVersion, err
}

func GetTokenVersion(pool *pgxpool.Pool, userID string) (int, error) {
	var v int
	err := pool.QueryRow(context.Background(), `SELECT token_version FROM users WHERE id = $1`, userID).Scan(&v)
	return v, err
}

// SetUserPassword stores the new hash and bumps token_version; returns the new version.
func SetUserPassword(pool *pgxpool.Pool, userID, hash string) (int, error) {
	var v int
	err := pool.QueryRow(context.Background(),
		`UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version`,
		hash, userID).Scan(&v)
	return v, err
}

// DeleteUser deletes the account (cascades to friendships, memberships, media rows,
// relay messages, stories) and returns the storage paths of media it sent or received
// and of its stories, plus the ids of the groups that were deleted with it (their pictures).
func DeleteUser(pool *pgxpool.Pool, userID string) (paths []string, groupIDs []string, err error) {
	paths, groupIDs, err = deleteUser(pool, userID)
	if err != nil {
		return nil, nil, err
	}
	return paths, groupIDs, nil
}

func deleteUser(pool *pgxpool.Pool, userID string) ([]string, []string, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT storage_path FROM media WHERE sender_id = $1 OR recipient_id = $1`, userID)
	if err != nil {
		return nil, nil, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return nil, nil, err
		}
		paths = append(paths, p)
	}
	rows.Close()
	// Own stories (the story id is also its storage key).
	srows, err := tx.Query(ctx, `SELECT id::text FROM stories WHERE owner_id = $1`, userID)
	if err != nil {
		return nil, nil, err
	}
	for srows.Next() {
		var p string
		if err := srows.Scan(&p); err != nil {
			srows.Close()
			return nil, nil, err
		}
		paths = append(paths, p)
	}
	srows.Close()
	// Group chats with other members get a new owner (the longest member) instead of vanishing.
	if _, err := tx.Exec(ctx,
		`UPDATE groups g SET owner_id = (
		   SELECT gm.user_id FROM group_memberships gm
		   WHERE gm.group_id = g.id AND gm.status = 'member' AND gm.user_id <> $1
		   ORDER BY gm.joined_at ASC LIMIT 1)
		 WHERE g.owner_id = $1 AND g.kind = 'chat' AND EXISTS (
		   SELECT 1 FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'member' AND gm.user_id <> $1)`,
		userID); err != nil {
		return nil, nil, err
	}
	gpaths, err := groupMediaOfUser(ctx, tx, userID)
	if err != nil {
		return nil, nil, err
	}
	paths = append(paths, gpaths...)
	// Remaining groups owned by the user go away with them.
	grows, err := tx.Query(ctx, `DELETE FROM groups WHERE owner_id = $1 RETURNING id::text`, userID)
	if err != nil {
		return nil, nil, err
	}
	var groupIDs []string
	for grows.Next() {
		var g string
		if err := grows.Scan(&g); err != nil {
			grows.Close()
			return nil, nil, err
		}
		groupIDs = append(groupIDs, g)
	}
	grows.Close()
	if err := grows.Err(); err != nil {
		return nil, nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		return nil, nil, err
	}
	return paths, groupIDs, tx.Commit(ctx)
}
