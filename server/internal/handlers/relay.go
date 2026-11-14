package handlers

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
)

// relayQueueFull: the recipient has too many messages waiting (code "queue"). The app keeps
// the message and retries; a sealed-sender delivery falls back to a logged-in one.
func relayQueueFull() error {
	return echo.NewHTTPError(http.StatusTooManyRequests,
		map[string]string{"message": "too many messages are waiting for this person — try again later", "code": "queue"})
}

type RelayHandler struct {
	pool *pgxpool.Pool
}

func NewRelayHandler(pool *pgxpool.Pool) *RelayHandler {
	return &RelayHandler{pool: pool}
}

type relayIn struct {
	RecipientID        string `json:"recipient_id"`
	EphemeralPublicKey string `json:"ephemeral_public_key"`
	Nonce              string `json:"nonce"`
	Payload            string `json:"payload"`
	// Notify wakes the recipient's device (used for text messages, not for receipts).
	Notify bool `json:"notify"`
}

type relayOut struct {
	ID                 string    `json:"id"`
	SenderID           string    `json:"sender_id"`
	EphemeralPublicKey string    `json:"ephemeral_public_key"`
	Nonce              string    `json:"nonce"`
	Payload            string    `json:"payload"`
	CreatedAt          time.Time `json:"created_at"`
}

// Send stores an encrypted message for a friend or group co-member.
func (h *RelayHandler) Send(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var in relayIn
	if err := c.Bind(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	if _, err := uuid.Parse(in.RecipientID); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid recipient_id")
	}
	eph, err := base64.StdEncoding.DecodeString(in.EphemeralPublicKey)
	if err != nil || len(eph) != 32 {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid ephemeral_public_key")
	}
	nonce, err := base64.StdEncoding.DecodeString(in.Nonce)
	if err != nil || len(nonce) != 24 {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid nonce")
	}
	payload, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil || len(payload) == 0 || len(payload) > models.RelayMaxPayload {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid payload")
	}

	friends, err := models.AreFriends(h.pool, me, in.RecipientID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !friends {
		shared, err := models.ShareGroupMembership(h.pool, me, in.RecipientID)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError)
		}
		if !shared {
			return echo.NewHTTPError(http.StatusForbidden, "recipient is not a contact")
		}
	}

	if blocked, err := models.IsBlockedEither(h.pool, me, in.RecipientID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	} else if blocked {
		return echo.NewHTTPError(http.StatusForbidden, "recipient is not a contact")
	}

	if err := models.CreateRelayMessage(h.pool, me, in.RecipientID, eph, nonce, payload); err != nil {
		if errors.Is(err, models.ErrRelayQueueFull) {
			return relayQueueFull()
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store message")
	}
	notifyRelay(h.pool, in.RecipientID)
	if in.Notify {
		wakeUsers(h.pool, in.RecipientID)
	}
	return c.NoContent(http.StatusCreated)
}

// List returns pending messages for the current user (they stay until acknowledged).
// With ?wait=N (1–25 s) an empty queue is held open until something arrives.
func (h *RelayHandler) List(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	wait, _ := strconv.Atoi(c.QueryParam("wait"))
	if wait > 25 {
		wait = 25
	}
	var ch chan struct{}
	if wait > 0 {
		// subscribe before reading, so nothing that arrives in between is missed
		var cancel func()
		var ok bool
		ch, cancel, ok = hub.subscribe(me)
		defer cancel()
		if !ok {
			wait = 0
		}
	}
	msgs, err := models.GetRelayMessages(h.pool, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if len(msgs) == 0 && wait > 0 {
		t := time.NewTimer(time.Duration(wait) * time.Second)
		defer t.Stop()
		select {
		case <-ch:
		case <-t.C:
		case <-c.Request().Context().Done():
			return nil
		}
		if msgs, err = models.GetRelayMessages(h.pool, me); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError)
		}
	}
	out := make([]relayOut, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, relayOut{
			ID:                 m.ID,
			SenderID:           m.SenderID,
			EphemeralPublicKey: base64.StdEncoding.EncodeToString(m.EphemeralPublicKey),
			Nonce:              base64.StdEncoding.EncodeToString(m.Nonce),
			Payload:            base64.StdEncoding.EncodeToString(m.Payload),
			CreatedAt:          m.CreatedAt,
		})
	}
	return c.JSON(http.StatusOK, out)
}

// Ack deletes delivered messages.
func (h *RelayHandler) Ack(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	ids := make([]string, 0, len(body.IDs))
	for _, id := range body.IDs {
		if _, err := uuid.Parse(id); err == nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return c.NoContent(http.StatusNoContent)
	}
	if err := models.AckRelayMessages(h.pool, me, ids); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.NoContent(http.StatusNoContent)
}
