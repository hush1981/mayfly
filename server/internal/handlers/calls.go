package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
)

// Calls are peer-to-peer WebRTC (DTLS-SRTP, end-to-end encrypted); offers, answers and ICE
// candidates travel end-to-end encrypted through the relay. The server only hands out TURN
// credentials so calls work behind NAT and — with "relay only" — without the two phones
// learning each other's IP address. TURN (coturn) only forwards encrypted packets.
//
// Credentials follow the TURN REST scheme (coturn use-auth-secret): username =
// "<expiry>:<random>", password = base64(HMAC-SHA1(secret, username)). The random part is
// not the user id, so the TURN server's logs cannot tell who called.
//
// TURN_URLS   comma-separated, e.g. "turn:mayfly.example:3478?transport=udp,turn:mayfly.example:3478?transport=tcp"
// TURN_SECRET the coturn static-auth-secret (≥ 32 random characters)
// STUN_URLS   optional extra STUN servers (default: none — no third parties)
type CallsHandler struct {
	turn   []string
	stun   []string
	secret []byte
	ttl    time.Duration
}

func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func NewCallsHandlerFromEnv() *CallsHandler {
	h := &CallsHandler{
		turn:   splitList(os.Getenv("TURN_URLS")),
		stun:   splitList(os.Getenv("STUN_URLS")),
		secret: []byte(os.Getenv("TURN_SECRET")),
		ttl:    8 * time.Hour,
	}
	if v, err := strconv.Atoi(os.Getenv("TURN_TTL_HOURS")); err == nil && v > 0 && v <= 48 {
		h.ttl = time.Duration(v) * time.Hour
	}
	if len(h.secret) < 16 {
		h.turn = nil // no usable secret: do not hand out TURN servers
	}
	return h
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// ICE: GET /calls/ice → {"ice_servers": [...], "relay": bool}. relay = a TURN server exists, so
// the app can hide IP addresses (iceTransportPolicy "relay").
func (h *CallsHandler) ICE(c echo.Context) error {
	if _, ok := mw.GetUserID(c); !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	servers := []iceServer{}
	if len(h.turn) > 0 {
		rnd := make([]byte, 8)
		if _, err := rand.Read(rnd); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError)
		}
		user := strconv.FormatInt(time.Now().Add(h.ttl).Unix(), 10) + ":" + hex.EncodeToString(rnd)
		mac := hmac.New(sha1.New, h.secret)
		mac.Write([]byte(user))
		servers = append(servers, iceServer{
			URLs: h.turn, Username: user, Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		})
	}
	if len(h.stun) > 0 {
		servers = append(servers, iceServer{URLs: h.stun})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"ice_servers": servers,
		"relay":       len(h.turn) > 0,
		"ttl":         int(h.ttl.Seconds()),
	})
}
