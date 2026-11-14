package handlers

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	"github.com/hush1981/mayfly/server/internal/auth"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
)

// busy: all password-hashing slots are taken (see auth.ErrBusy).
func busy() error {
	return echo.NewHTTPError(http.StatusServiceUnavailable, "server is busy, try again in a moment")
}

var usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_]{3,50}$`)

type AuthHandler struct {
	pool *pgxpool.Pool
}

func NewAuthHandler(pool *pgxpool.Pool) *AuthHandler {
	return &AuthHandler{pool: pool}
}

type registerRequest struct {
	Username  string `json:"username"`
	Password  string `json:"password"`
	PublicKey string `json:"public_key"` // base64-encoded X25519 public key
	Invite    string `json:"invite"`     // required only if REGISTRATION_TOKEN is set
}

func (h *AuthHandler) Register(c echo.Context) error {
	var req registerRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	// Optional closed registration: the operator hands out REGISTRATION_TOKEN as invite code.
	if want := os.Getenv("REGISTRATION_TOKEN"); want != "" &&
		subtle.ConstantTimeCompare([]byte(req.Invite), []byte(want)) != 1 {
		return echo.NewHTTPError(http.StatusForbidden, "a valid invite code is required on this server")
	}

	if !usernameRegex.MatchString(req.Username) {
		return echo.NewHTTPError(http.StatusBadRequest, "username must be 3-50 characters, alphanumeric or underscore")
	}
	if len(req.Password) < 8 || len(req.Password) > auth.MaxPasswordLen {
		return echo.NewHTTPError(http.StatusBadRequest, "password must be 8-256 characters")
	}

	pubKeyBytes, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(pubKeyBytes) != 32 {
		return echo.NewHTTPError(http.StatusBadRequest, "public_key must be a base64-encoded 32-byte X25519 key")
	}

	hash, err := auth.HashPassword(req.Password)
	if errors.Is(err, auth.ErrBusy) {
		return busy()
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not hash password")
	}

	user, err := models.CreateUser(h.pool, req.Username, hash, pubKeyBytes)
	if err != nil {
		if isDuplicateKeyError(err) {
			return echo.NewHTTPError(http.StatusConflict, "username already taken")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "could not create user")
	}

	return c.JSON(http.StatusCreated, map[string]string{
		"id":       user.ID,
		"username": user.Username,
	})
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (h *AuthHandler) Login(c echo.Context) error {
	var req loginRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	if req.Username == "" || len(req.Username) > 50 || len(req.Password) > auth.MaxPasswordLen {
		auth.VerifyDummy(req.Password[:min(len(req.Password), auth.MaxPasswordLen)])
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid username or password")
	}

	user, err := models.GetUserByUsername(h.pool, req.Username)
	if err == pgx.ErrNoRows {
		// Run dummy hash to prevent timing-based username enumeration
		auth.VerifyDummy(req.Password)
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid username or password")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "login failed")
	}

	ok, err := auth.VerifyPassword(req.Password, user.PasswordHash)
	if errors.Is(err, auth.ErrBusy) {
		return busy()
	}
	if err != nil || !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid username or password")
	}

	token, err := auth.GenerateToken(user.ID, user.TokenVersion)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not generate token")
	}

	return c.JSON(http.StatusOK, map[string]string{
		"token":    token,
		"user_id":  user.ID,
		"username": user.Username,
		// the account's current public key: the app compares it with the key on the device
		// and offers to create a new one if they differ (new phone, other account before)
		"public_key": base64.StdEncoding.EncodeToString(user.PublicKey),
	})
}

// Refresh: POST /auth/refresh (valid session required) → a fresh token with the full lifetime.
// The app calls it about once a day, so a session only ends when the phone was not used for
// a month, the password changed or the account was deleted.
func (h *AuthHandler) Refresh(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	token, err := auth.GenerateToken(me, mw.GetTokenVersion(c))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not generate token")
	}
	return c.JSON(http.StatusOK, map[string]any{
		"token":      token,
		"expires_in": int(auth.TokenLifetime.Seconds()),
	})
}

func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "duplicate key") || strings.Contains(msg, "unique constraint")
}
