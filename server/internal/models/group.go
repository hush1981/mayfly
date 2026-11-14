package models

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	GroupKindList = "list" // broadcast list ("Rundliste"): moments go to every member one by one
	GroupKindChat = "chat" // group chat: invited members accept, everyone may rename / change the picture

	MemberInvited = "invited"
	MemberActive  = "member"

	// GroupChatMaxMembers keeps fan-out (one end-to-end encrypted copy per member) bounded.
	GroupChatMaxMembers = 64

	// MaxOwnedGroups bounds the groups (lists + chats) one account may own.
	MaxOwnedGroups = 100
)

// ErrTooManyGroups: the account already owns MaxOwnedGroups groups.
var ErrTooManyGroups = errors.New("too many groups")

type Group struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
	// The caller's own membership state ("member" or "invited").
	MyStatus  string  `json:"my_status"`
	InvitedBy *string `json:"invited_by,omitempty"`
}

type GroupMember struct {
	UserID   string    `json:"user_id"`
	Username string    `json:"username"`
	Status   string    `json:"status"`
	JoinedAt time.Time `json:"joined_at"`
}

func CreateGroup(pool *pgxpool.Pool, name, ownerID, kind string) (*Group, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var owned int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM groups WHERE owner_id = $1`, ownerID).Scan(&owned); err != nil {
		return nil, err
	}
	if owned >= MaxOwnedGroups {
		return nil, ErrTooManyGroups
	}
	g := &Group{MyStatus: MemberActive}
	err = tx.QueryRow(ctx,
		`INSERT INTO groups (name, owner_id, kind) VALUES ($1, $2, $3)
		 RETURNING id, name, owner_id, kind, created_at`,
		name, ownerID, kind,
	).Scan(&g.ID, &g.Name, &g.OwnerID, &g.Kind, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx,
		`INSERT INTO group_memberships (group_id, user_id, status) VALUES ($1, $2, 'member')`,
		g.ID, ownerID); err != nil {
		return nil, err
	}
	return g, tx.Commit(ctx)
}

// GetGroupsForUser lists the user's group chats (including invitations) and the broadcast
// lists the user owns. A broadcast list is private to its owner: the people on it are not
// told and do not see it.
func GetGroupsForUser(pool *pgxpool.Pool, userID string) ([]Group, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT g.id, g.name, g.owner_id, g.kind, g.created_at, gm.status, gm.invited_by
		 FROM groups g
		 JOIN group_memberships gm ON gm.group_id = g.id
		 WHERE gm.user_id = $1 AND (g.kind = 'chat' OR g.owner_id = $1)
		 ORDER BY g.created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []Group
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.Name, &g.OwnerID, &g.Kind, &g.CreatedAt, &g.MyStatus, &g.InvitedBy); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

func GetGroup(pool *pgxpool.Pool, groupID string) (*Group, error) {
	g := &Group{}
	err := pool.QueryRow(context.Background(),
		`SELECT id, name, owner_id, kind, created_at FROM groups WHERE id = $1`, groupID,
	).Scan(&g.ID, &g.Name, &g.OwnerID, &g.Kind, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// GetGroupMembers lists members and (for group chats) pending invitations.
func GetGroupMembers(pool *pgxpool.Pool, groupID string) ([]GroupMember, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT u.id, u.username, gm.status, gm.joined_at
		 FROM group_memberships gm
		 JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = $1
		 ORDER BY gm.joined_at ASC`,
		groupID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []GroupMember
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.UserID, &m.Username, &m.Status, &m.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// ActiveMemberIDs: accepted members of a group.
func ActiveMemberIDs(pool *pgxpool.Pool, groupID string) ([]string, error) {
	rows, err := pool.Query(context.Background(),
		`SELECT user_id::text FROM group_memberships WHERE group_id = $1 AND status = 'member'`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// AddGroupMember adds a member to a broadcast list right away.
func AddGroupMember(pool *pgxpool.Pool, groupID, userID string) error {
	_, err := pool.Exec(context.Background(),
		`INSERT INTO group_memberships (group_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
		groupID, userID,
	)
	return err
}

// InviteToGroupChat records an invitation; the invitee becomes a member only after accepting.
// Returns false if the user is already a member or invited, or the chat is full.
func InviteToGroupChat(pool *pgxpool.Pool, groupID, userID, invitedBy string) (bool, error) {
	tag, err := pool.Exec(context.Background(),
		`INSERT INTO group_memberships (group_id, user_id, status, invited_by)
		 SELECT $1, $2, 'invited', $3
		 WHERE (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) < $4
		 ON CONFLICT DO NOTHING`,
		groupID, userID, invitedBy, GroupChatMaxMembers)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// AcceptGroupInvite turns the caller's invitation into a membership.
func AcceptGroupInvite(pool *pgxpool.Pool, groupID, userID string) (bool, error) {
	tag, err := pool.Exec(context.Background(),
		`UPDATE group_memberships SET status = 'member', joined_at = NOW()
		 WHERE group_id = $1 AND user_id = $2 AND status = 'invited'`,
		groupID, userID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RemoveGroupMember removes a member or invitation. In a group chat the ownership passes to
// the longest member when the owner leaves, and an empty chat is deleted. Returns the storage
// keys of group media that must be deleted.
func RemoveGroupMember(pool *pgxpool.Pool, groupID, userID string) ([]string, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`DELETE FROM group_memberships WHERE group_id = $1 AND user_id = $2`, groupID, userID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM group_media_pending p USING group_media m
		 WHERE m.id = p.media_id AND m.group_id = $1 AND p.user_id = $2`, groupID, userID); err != nil {
		return nil, err
	}
	var kind, owner string
	if err := tx.QueryRow(ctx, `SELECT kind, owner_id::text FROM groups WHERE id = $1`, groupID).Scan(&kind, &owner); err != nil {
		if err == pgx.ErrNoRows {
			return nil, tx.Commit(ctx)
		}
		return nil, err
	}
	var paths []string
	if kind == GroupKindChat {
		var next string
		err := tx.QueryRow(ctx,
			`SELECT user_id::text FROM group_memberships WHERE group_id = $1 AND status = 'member'
			 ORDER BY joined_at ASC LIMIT 1`, groupID).Scan(&next)
		if err != nil && err != pgx.ErrNoRows {
			return nil, err
		}
		if err == pgx.ErrNoRows {
			// nobody left: the chat goes away (invitations included)
			if paths, err = groupMediaKeys(ctx, tx, `group_id = $1`, groupID); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM groups WHERE id = $1`, groupID); err != nil {
				return nil, err
			}
		} else if owner == userID {
			if _, err := tx.Exec(ctx, `UPDATE groups SET owner_id = $2 WHERE id = $1`, groupID, next); err != nil {
				return nil, err
			}
		}
	}
	return paths, tx.Commit(ctx)
}

// RenameGroup changes the name.
func RenameGroup(pool *pgxpool.Pool, groupID, name string) error {
	_, err := pool.Exec(context.Background(), `UPDATE groups SET name = $2 WHERE id = $1`, groupID, name)
	return err
}

// IsGroupMember: an accepted member (invitations do not count).
func IsGroupMember(pool *pgxpool.Pool, groupID, userID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM group_memberships WHERE group_id = $1 AND user_id = $2 AND status = 'member')`,
		groupID, userID,
	).Scan(&exists)
	return exists, err
}

// CanSeeGroup is the rule for reading a group's members and picture: members of a group chat
// and people invited to it (before they decide), and the owner of a broadcast list — nobody
// else, in particular not the people on somebody's list.
func CanSeeGroup(pool *pgxpool.Pool, groupID, userID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON g.id = gm.group_id
		               WHERE gm.group_id = $1 AND gm.user_id = $2 AND (g.kind = 'chat' OR g.owner_id = $2))`,
		groupID, userID,
	).Scan(&exists)
	return exists, err
}

// IsOnOwnList reports whether listID is a broadcast list owned by owner with member on it.
func IsOnOwnList(pool *pgxpool.Pool, listID, owner, member string) (bool, error) {
	var exists bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM groups g JOIN group_memberships gm ON gm.group_id = g.id
		               WHERE g.id = $1 AND g.kind = 'list' AND g.owner_id = $2 AND gm.user_id = $3)`,
		listID, owner, member,
	).Scan(&exists)
	return exists, err
}

// ShareGroupMembership returns true if both users are accepted members of a common group
// chat. Broadcast lists do not count: being put on somebody's list must not connect two
// people who never agreed to anything.
func ShareGroupMembership(pool *pgxpool.Pool, userAID, userBID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(
			SELECT 1 FROM group_memberships a
			JOIN group_memberships b ON a.group_id = b.group_id
			JOIN groups g ON g.id = a.group_id AND g.kind = 'chat'
			WHERE a.user_id = $1 AND b.user_id = $2 AND a.status = 'member' AND b.status = 'member'
		)`,
		userAID, userBID,
	).Scan(&exists)
	return exists, err
}

func IsGroupOwner(pool *pgxpool.Pool, groupID, userID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM groups WHERE id = $1 AND owner_id = $2)`,
		groupID, userID,
	).Scan(&exists)
	return exists, err
}

// DeleteGroup removes a group (only by its owner); memberships and group chat media go with
// it, pending moments sent through a broadcast list stay but lose their group tag.
// Returns whether something was deleted and the storage keys of group media to delete.
func DeleteGroup(pool *pgxpool.Pool, groupID, ownerID string) (bool, []string, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, nil, err
	}
	defer tx.Rollback(ctx)
	paths, err := groupMediaKeys(ctx, tx, `group_id = $1`, groupID)
	if err != nil {
		return false, nil, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM groups WHERE id = $1 AND owner_id = $2`, groupID, ownerID)
	if err != nil {
		return false, nil, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil, nil
	}
	return true, paths, tx.Commit(ctx)
}

func groupMediaKeys(ctx context.Context, tx pgx.Tx, where string, args ...any) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT id::text FROM group_media WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
