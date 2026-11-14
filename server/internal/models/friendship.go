package models

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	StatusPending  = "pending"
	StatusAccepted = "accepted"
)

type Friendship struct {
	ID          string    `json:"id"`
	RequesterID string    `json:"requester_id"`
	AddresseeID string    `json:"addressee_id"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

type FriendRequest struct {
	ID        string     `json:"id"`
	Requester UserPublic `json:"requester"`
	CreatedAt time.Time  `json:"created_at"`
}

// MaxPendingRequests bounds the unanswered friend requests one account may have sent.
const MaxPendingRequests = 100

func CountPendingRequestsFrom(pool *pgxpool.Pool, requesterID string) (int, error) {
	var n int
	err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM friendships WHERE requester_id = $1 AND status = $2`,
		requesterID, StatusPending).Scan(&n)
	return n, err
}

func CreateFriendRequest(pool *pgxpool.Pool, requesterID, addresseeID string) error {
	_, err := pool.Exec(context.Background(),
		`INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)`,
		requesterID, addresseeID,
	)
	return err
}

// AcceptFriendRequest updates status to accepted, verifying that currentUserID is the addressee.
func AcceptFriendRequest(pool *pgxpool.Pool, friendshipID, currentUserID string) error {
	tag, err := pool.Exec(context.Background(),
		`UPDATE friendships SET status = $1
		 WHERE id = $2 AND addressee_id = $3 AND status = $4`,
		StatusAccepted, friendshipID, currentUserID, StatusPending,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func GetPendingRequests(pool *pgxpool.Pool, userID string) ([]FriendRequest, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT f.id, u.id, u.username, f.created_at
		 FROM friendships f
		 JOIN users u ON u.id = f.requester_id
		 WHERE f.addressee_id = $1 AND f.status = $2`,
		userID, StatusPending,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var requests []FriendRequest
	for rows.Next() {
		var r FriendRequest
		if err := rows.Scan(&r.ID, &r.Requester.ID, &r.Requester.Username, &r.CreatedAt); err != nil {
			return nil, err
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

func GetFriends(pool *pgxpool.Pool, userID string) ([]UserPublic, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT u.id, u.username FROM users u
		 JOIN friendships f ON (
		   (f.requester_id = $1 AND f.addressee_id = u.id) OR
		   (f.addressee_id = $1 AND f.requester_id = u.id)
		 )
		 WHERE f.status = $2
		 ORDER BY u.username ASC`,
		userID, StatusAccepted,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var friends []UserPublic
	for rows.Next() {
		var u UserPublic
		if err := rows.Scan(&u.ID, &u.Username); err != nil {
			return nil, err
		}
		friends = append(friends, u)
	}
	return friends, rows.Err()
}

func AreFriends(pool *pgxpool.Pool, userAID, userBID string) (bool, error) {
	var count int
	err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM friendships
		 WHERE (
		   (requester_id = $1 AND addressee_id = $2) OR
		   (requester_id = $2 AND addressee_id = $1)
		 ) AND status = $3`,
		userAID, userBID, StatusAccepted,
	).Scan(&count)
	return count > 0, err
}

// AcceptReverseRequest accepts a pending request from requesterID to addresseeID, if any.
func AcceptReverseRequest(pool *pgxpool.Pool, requesterID, addresseeID string) (bool, error) {
	tag, err := pool.Exec(context.Background(),
		`UPDATE friendships SET status = $1
		 WHERE requester_id = $2 AND addressee_id = $3 AND status = $4`,
		StatusAccepted, requesterID, addresseeID, StatusPending,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RemoveFriendship deletes the friendship (or a pending request) between two users, in
// either direction. Returns whether something was removed.
func RemoveFriendship(pool *pgxpool.Pool, userAID, userBID string) (bool, error) {
	tag, err := pool.Exec(context.Background(),
		`DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
		userAID, userBID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
