package middleware

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/hush1981/mayfly/server/internal/auth"
)

type contextKey string

const UserIDKey contextKey = "userID"

// TokenVersionKey holds the account's current token version (for POST /auth/refresh).
const TokenVersionKey contextKey = "tokenVersion"

// authError is a 401 the app can tell apart from "wrong password" answers of the account
// routes: code "auth" means the session itself is no longer valid (log in again).
func authError(msg string) error {
	return echo.NewHTTPError(http.StatusUnauthorized, map[string]string{"message": msg, "code": "auth"})
}

// RequireAuth validates the bearer token, that the account still exists and that the
// token's version is current (password not changed since it was issued).
func RequireAuth(state func(userID string) (bool, int, error)) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			header := c.Request().Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				return authError("missing token")
			}

			claims, err := auth.ParseToken(strings.TrimPrefix(header, "Bearer "))
			if err != nil {
				return authError("invalid token")
			}

			ok, version, err := state(claims.UserID)
			if err != nil {
				// database trouble is not the client's fault: do not make the app log out
				return echo.NewHTTPError(http.StatusServiceUnavailable, "try again later")
			}
			if !ok {
				return authError("invalid token")
			}
			if claims.TokenVersion != version {
				return authError("session expired, please log in again")
			}

			c.Set(string(UserIDKey), claims.UserID)
			c.Set(string(TokenVersionKey), version)
			return next(c)
		}
	}
}

func GetTokenVersion(c echo.Context) int {
	v, _ := c.Get(string(TokenVersionKey)).(int)
	return v
}

func GetUserID(c echo.Context) (string, bool) {
	v := c.Get(string(UserIDKey))
	id, ok := v.(string)
	return id, ok && id != ""
}
