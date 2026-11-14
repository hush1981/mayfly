package handlers

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
)

type FriendsHandler struct {
	pool *pgxpool.Pool
}

func NewFriendsHandler(pool *pgxpool.Pool) *FriendsHandler {
	return &FriendsHandler{pool: pool}
}

type friendRequestBody struct {
	Username string `json:"username"`
}

func (h *FriendsHandler) SendRequest(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	var req friendRequestBody
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.Username == "" || len(req.Username) > 50 {
		return echo.NewHTTPError(http.StatusBadRequest, "username required")
	}

	target, err := models.GetUserByUsername(h.pool, req.Username)
	if err == pgx.ErrNoRows {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "lookup failed")
	}
	if target.ID == currentUserID {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot add yourself")
	}

	// Someone who blocked you looks like a user that does not exist.
	if blockedMe, err := models.HasBlocked(h.pool, target.ID, currentUserID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "lookup failed")
	} else if blockedMe {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if iBlocked, err := models.HasBlocked(h.pool, currentUserID, target.ID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "lookup failed")
	} else if iBlocked {
		return echo.NewHTTPError(http.StatusForbidden, "you blocked this user — unblock them first")
	}

	already, err := models.AreFriends(h.pool, currentUserID, target.ID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "lookup failed")
	}
	if already {
		return echo.NewHTTPError(http.StatusConflict, "already friends")
	}
	// If they already asked us, adding them back accepts that request.
	if accepted, err := models.AcceptReverseRequest(h.pool, target.ID, currentUserID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not send request")
	} else if accepted {
		wakeUsers(h.pool, target.ID)
		return c.JSON(http.StatusOK, map[string]string{"status": "accepted"})
	}

	// Bound unanswered requests per account (spam, and a queue nobody can ever answer).
	if n, err := models.CountPendingRequestsFrom(h.pool, currentUserID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not send request")
	} else if n >= models.MaxPendingRequests {
		return quotaError(http.StatusTooManyRequests, "quota", "too many friend requests are still unanswered")
	}

	if err := models.CreateFriendRequest(h.pool, currentUserID, target.ID); err != nil {
		if isDuplicateKeyError(err) {
			return echo.NewHTTPError(http.StatusConflict, "request already exists")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "could not send request")
	}
	// Wake the addressee's phone so it can show "new friend request" (the push itself is empty).
	wakeUsers(h.pool, target.ID)

	return c.JSON(http.StatusCreated, map[string]string{"status": "pending"})
}

func (h *FriendsHandler) ListRequests(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	requests, err := models.GetPendingRequests(h.pool, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not get requests")
	}

	if requests == nil {
		requests = []models.FriendRequest{}
	}
	return c.JSON(http.StatusOK, requests)
}

func (h *FriendsHandler) AcceptRequest(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	friendshipID := c.Param("id")
	if _, err := uuid.Parse(friendshipID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "request not found")
	}
	if err := models.AcceptFriendRequest(h.pool, friendshipID, currentUserID); err == pgx.ErrNoRows {
		return echo.NewHTTPError(http.StatusNotFound, "request not found")
	} else if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not accept request")
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "accepted"})
}

func (h *FriendsHandler) ListFriends(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}

	friends, err := models.GetFriends(h.pool, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not get friends")
	}

	if friends == nil {
		friends = []models.UserPublic{}
	}
	return c.JSON(http.StatusOK, friends)
}

// Remove: DELETE /friends/:id — ends a friendship, withdraws my request or declines theirs.
// The other side is not told (their app notices that we are no longer friends).
func (h *FriendsHandler) Remove(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	other := c.Param("id")
	if _, err := uuid.Parse(other); err != nil || other == me {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid user id")
	}
	if _, err := models.RemoveFriendship(h.pool, me, other); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.NoContent(http.StatusNoContent)
}
