package main

import (
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	appdb "github.com/hush1981/mayfly/server/internal/db"
	"github.com/hush1981/mayfly/server/internal/handlers"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
	"github.com/hush1981/mayfly/server/internal/web"
)

func main() {
	// Load .env if present (ignored in production where env vars are injected)
	godotenv.Load()

	for _, key := range []string{"DATABASE_URL", "JWT_SECRET", "STORAGE_PATH"} {
		if os.Getenv(key) == "" {
			log.Fatalf("required env var %s is not set", key)
		}
	}
	if secret := os.Getenv("JWT_SECRET"); len(secret) < 32 || strings.Contains(secret, "change_in_production") {
		log.Fatalf("JWT_SECRET must be a random value of at least 32 characters (e.g. openssl rand -hex 32)")
	}

	pool, err := appdb.Connect()
	if err != nil {
		log.Fatalf("connect to database: %v", err)
	}
	defer pool.Close()

	if err := appdb.Ping(pool); err != nil {
		log.Fatalf("ping database: %v", err)
	}
	fmt.Println("database connected")

	if err := appdb.Migrate(pool); err != nil {
		log.Fatalf("run migrations: %v", err)
	}
	fmt.Println("migrations applied")

	storagePath := os.Getenv("STORAGE_PATH")
	store, err := storage.NewLocalStorage(storagePath)
	if err != nil {
		log.Fatalf("init media storage: %v", err)
	}

	avatarStore, err := storage.NewLocalStorage(filepath.Join(storagePath, "avatars"))
	if err != nil {
		log.Fatalf("init avatar storage: %v", err)
	}

	groupAvatarStore, err := storage.NewLocalStorage(filepath.Join(storagePath, "group-avatars"))
	if err != nil {
		log.Fatalf("init group avatar storage: %v", err)
	}

	// Uploads are spooled to the media disk, not to the container's in-memory /tmp.
	if err := useUploadTempDir(filepath.Join(storagePath, "tmp")); err != nil {
		log.Fatalf("init upload temp dir: %v", err)
	}

	e := newServer(pool, store, avatarStore, groupAvatarStore)

	go handlers.RunCleanup(pool, store)

	log.Printf("server starting on :8080")
	if err := e.Start(":8080"); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

// newServer wires middleware and routes (also used by the integration tests).
func newServer(pool *pgxpool.Pool, store, avatarStore, groupAvatarStore storage.Storage) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	// Behind the reverse proxy: take the client IP from X-Forwarded-For, but only trust
	// the header when it was added by a proxy on a private network. Used for rate limits
	// only — client IPs are never logged or stored.
	e.IPExtractor = ipExtractor(os.Getenv("TRUSTED_PROXIES"))

	// Slow-client protection
	e.Server.ReadHeaderTimeout = 10 * time.Second
	e.Server.ReadTimeout = 5 * time.Minute
	e.Server.WriteTimeout = 5 * time.Minute
	e.Server.IdleTimeout = 2 * time.Minute

	// Privacy: log only method, route pattern (e.g. /users/:id/avatar — no user or group ids),
	// status and latency — no client IPs, user agents or query strings.
	e.Use(middleware.LoggerWithConfig(middleware.LoggerConfig{
		Format: "${time_rfc3339} ${method} ${route} ${status} ${latency_human}\n",
	}))
	e.Use(middleware.Recover())
	e.Use(middleware.SecureWithConfig(middleware.SecureConfig{
		XSSProtection:      "0",
		ContentTypeNosniff: "nosniff",
		XFrameOptions:      "DENY",
		// HSTS is set by the TLS-terminating reverse proxy (one header, not two).
		ContentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
		ReferrerPolicy:        "no-referrer",
	}))
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Response().Header().Set("Cache-Control", "no-store")
			return next(c)
		}
	})
	// No CORS middleware on purpose: there is no browser client, so browsers must not be
	// able to call the API cross-origin.

	smallBody := middleware.BodyLimit("64K")
	avatarBody := middleware.BodyLimit("6M")
	mediaBody := middleware.BodyLimit("205M")

	// Brute-force / abuse limits (in-memory, per client IP for auth, per user otherwise).
	authLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		// 10 attempts, then one every 6 s per client IP (AUTH_BURST only for tests).
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate: rate.Limit(10.0 / 60.0), Burst: envInt("AUTH_BURST", 10), ExpiresIn: 30 * time.Minute,
		}),
		IdentifierExtractor: func(c echo.Context) (string, error) { return handlers.ClientKey(c), nil },
		DenyHandler: func(c echo.Context, _ string, _ error) error {
			return echo.NewHTTPError(http.StatusTooManyRequests, "too many attempts, try again later")
		},
	})
	userLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate: 15, Burst: 60, ExpiresIn: 10 * time.Minute,
		}),
		IdentifierExtractor: func(c echo.Context) (string, error) {
			if id, ok := mw.GetUserID(c); ok {
				return "u:" + id, nil
			}
			return "ip:" + handlers.ClientKey(c), nil
		},
	})
	// Sensitive account actions that check the password again.
	passwordLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate: rate.Limit(5.0 / 300.0), Burst: 5, ExpiresIn: time.Hour,
		}),
		IdentifierExtractor: func(c echo.Context) (string, error) {
			id, _ := mw.GetUserID(c)
			return "p:" + id, nil
		},
	})

	// Friend requests: looking up names one by one must stay slow (20, then one per 30 s).
	friendLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate: rate.Limit(1.0 / 30.0), Burst: envInt("FRIEND_REQUEST_BURST", 20), ExpiresIn: time.Hour,
		}),
		IdentifierExtractor: func(c echo.Context) (string, error) {
			id, _ := mw.GetUserID(c)
			return "f:" + id, nil
		},
	})

	authH := handlers.NewAuthHandler(pool)
	usersH := handlers.NewUsersHandler(pool, avatarStore, groupAvatarStore, store)
	friendsH := handlers.NewFriendsHandler(pool)
	quota := handlers.NewMediaQuotaFromEnv()
	mediaH := handlers.NewMediaHandler(pool, store, quota)
	storiesH := handlers.NewStoriesHandler(pool, store, quota)
	groupsH := handlers.NewGroupsHandler(pool, groupAvatarStore, store, quota)
	relayH := handlers.NewRelayHandler(pool)
	blocksH := handlers.NewBlocksHandler(pool, store)
	sealedH := handlers.NewSealedHandler(pool, store, quota)
	callsH := handlers.NewCallsHandlerFromEnv()

	// Admission control for upload bodies (see handlers.UploadGate).
	gate := handlers.NewUploadGate(store, quota)
	userUpload := gate.Middleware(func(c echo.Context) string {
		id, _ := mw.GetUserID(c)
		return "u:" + id
	})
	sealedUpload := gate.Middleware(func(c echo.Context) string { return "ip:" + handlers.ClientKey(c) })

	// Public routes
	e.POST("/auth/register", authH.Register, smallBody, authLimiter)
	e.POST("/auth/login", authH.Login, smallBody, authLimiter)

	// Sealed sender: no login — the delivery token decides the recipient (rate-limited per IP).
	ipLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate: 15, Burst: 60, ExpiresIn: 10 * time.Minute,
		}),
		IdentifierExtractor: func(c echo.Context) (string, error) { return "s:" + handlers.ClientKey(c), nil },
	})
	e.GET("/limits", quota.Limits, ipLimiter)
	e.POST("/sealed/relay", sealedH.Relay, smallBody, ipLimiter)
	e.POST("/sealed/media", sealedH.Media, mediaBody, ipLimiter, sealedUpload)
	e.DELETE("/sealed/media/:id", sealedH.Unsend, ipLimiter)

	// Authenticated routes
	requireAuth := mw.RequireAuth(func(id string) (bool, int, error) { return models.UserAuthState(pool, id) })
	api := e.Group("", requireAuth, userLimiter)
	api.POST("/auth/refresh", authH.Refresh, smallBody)
	api.GET("/users/:id/public-key", usersH.GetPublicKey)
	api.GET("/users/:id/avatar", usersH.ServeAvatar)
	api.GET("/users/me/push", usersH.GetPush)
	api.PUT("/users/me/push", usersH.SetPush, smallBody)
	api.POST("/users/me/avatar", usersH.UploadAvatar, avatarBody, userUpload)
	api.PUT("/users/me/public-key", usersH.RotatePublicKey, smallBody, passwordLimiter)
	api.POST("/users/me/delete", usersH.DeleteAccount, smallBody, passwordLimiter)
	api.PUT("/users/me/password", usersH.ChangePassword, smallBody, passwordLimiter)
	api.PUT("/users/me/delivery-token", sealedH.SetToken, smallBody)
	api.GET("/calls/ice", callsH.ICE)

	api.POST("/friends/request", friendsH.SendRequest, smallBody, friendLimiter)
	api.GET("/friends/requests", friendsH.ListRequests)
	api.POST("/friends/accept/:id", friendsH.AcceptRequest, smallBody)
	api.GET("/friends", friendsH.ListFriends)
	api.DELETE("/friends/:id", friendsH.Remove)

	api.POST("/media/send", mediaH.Send, mediaBody, userUpload)
	api.GET("/media/inbox", mediaH.Inbox)
	api.GET("/media/:id", mediaH.Download)
	api.POST("/media/:id/viewed", mediaH.MarkViewed, smallBody)
	api.DELETE("/media/:id", mediaH.Unsend)

	api.POST("/stories", storiesH.Create, mediaBody, userUpload)
	api.GET("/stories", storiesH.List)
	api.GET("/stories/:id", storiesH.Download)
	api.DELETE("/stories/:id", storiesH.Delete)

	api.GET("/blocks", blocksH.List)
	api.POST("/blocks", blocksH.Block, smallBody)
	api.DELETE("/blocks/:id", blocksH.Unblock)

	api.POST("/relay", relayH.Send, smallBody)
	api.GET("/relay", relayH.List)
	api.POST("/relay/ack", relayH.Ack, smallBody)

	api.POST("/groups", groupsH.Create, smallBody)
	api.GET("/groups", groupsH.List)
	api.DELETE("/groups/:id", groupsH.Delete)
	api.PUT("/groups/:id", groupsH.Rename, smallBody)
	api.POST("/groups/:id/join", groupsH.Join, smallBody)
	api.POST("/groups/:id/media", groupsH.SendMedia, mediaBody, userUpload)
	api.GET("/group-media/:id", groupsH.DownloadMedia)
	api.POST("/group-media/:id/viewed", groupsH.MediaViewed, smallBody)
	api.DELETE("/group-media/:id", groupsH.UnsendMedia)
	api.GET("/groups/:id/members", groupsH.ListMembers)
	api.POST("/groups/:id/members", groupsH.AddMember, smallBody)
	api.DELETE("/groups/:id/members/:uid", groupsH.RemoveMember)
	api.POST("/groups/:id/avatar", groupsH.UploadAvatar, avatarBody, userUpload)
	api.GET("/groups/:id/avatar", groupsH.ServeAvatar)

	// Public landing page (registered last so it wins over the auth group's catch-all).
	web.Register(e, web.Options{
		IndexURL:   os.Getenv("FDROID_INDEX_URL"),
		FriendCode: friendCode(pool, os.Getenv("SITE_FRIEND_USER")),
	})

	return e
}

// useUploadTempDir makes dir the place where upload bodies are spooled (Go's multipart
// reader uses TMPDIR) and removes whatever a previous run left behind there.
func useUploadTempDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return os.Setenv("TMPDIR", dir)
}

// friendCode returns the "add me" QR payload (same format as the app's Friends → My code)
// for one account, built from its current public key. nil if no account is configured.
func friendCode(pool *pgxpool.Pool, username string) func() (string, string, bool) {
	if username == "" {
		return nil
	}
	return func() (string, string, bool) {
		u, err := models.GetUserByUsername(pool, username)
		if err != nil || len(u.PublicKey) != 32 {
			return "", "", false
		}
		return u.Username, "mayfly-friend:1:" + u.Username + ":" + base64.RawURLEncoding.EncodeToString(u.PublicKey), true
	}
}

// ipExtractor trusts X-Forwarded-For only from the given proxies (comma-separated IPs or
// CIDRs, e.g. "10.0.6.18/32"); without TRUSTED_PROXIES all private networks are trusted.
func ipExtractor(list string) echo.IPExtractor {
	var opts []echo.TrustOption
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			if strings.Contains(item, ":") {
				item += "/128"
			} else {
				item += "/32"
			}
		}
		if _, n, err := net.ParseCIDR(item); err == nil {
			opts = append(opts, echo.TrustIPRange(n))
		} else {
			log.Printf("TRUSTED_PROXIES: ignoring %q", item)
		}
	}
	if len(opts) == 0 {
		return echo.ExtractIPFromXFFHeader(echo.TrustLoopback(true), echo.TrustPrivateNet(true))
	}
	opts = append(opts, echo.TrustLoopback(false), echo.TrustLinkLocal(false), echo.TrustPrivateNet(false))
	return echo.ExtractIPFromXFFHeader(opts...)
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}
