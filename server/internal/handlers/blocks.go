package handlers

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

type BlocksHandler struct {
	pool    *pgxpool.Pool
	storage storage.Storage
}

func NewBlocksHandler(pool *pgxpool.Pool, store storage.Storage) *BlocksHandler {
	return &BlocksHandler{pool: pool, storage: store}
}

type blockBody struct {
	UserID string `json:"user_id"`
}

// Block blocks a user by id. It also ends the friendship and drops everything pending
// between the two. Idempotent.
func (h *BlocksHandler) Block(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body blockBody
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if _, err := uuid.Parse(body.UserID); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid user_id")
	}
	if body.UserID == me {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot block yourself")
	}
	if _, err := models.GetUserByID(h.pool, body.UserID); err == pgx.ErrNoRows {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	} else if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	paths, err := models.Block(h.pool, me, body.UserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not block")
	}
	for _, p := range paths {
		h.storage.Delete(p)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *BlocksHandler) Unblock(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	if err := models.Unblock(h.pool, me, id); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *BlocksHandler) List(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	list, err := models.ListBlocked(h.pool, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.JSON(http.StatusOK, list)
}

// Unsend deletes a moment the caller sent, if the recipient has not opened it yet.
func (h *MediaHandler) Unsend(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	path, err := models.DeletePendingMediaBySender(h.pool, id, me)
	if err == pgx.ErrNoRows {
		// Already opened, expired or not ours — nothing on the server any more.
		return echo.NewHTTPError(http.StatusNotFound)
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	h.storage.Delete(path)
	return c.NoContent(http.StatusNoContent)
}
