package handlers

import (
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/hush1981/mayfly/server/internal/storage"
)

// UploadGate is the admission control for every multipart upload route.
//
// An upload body can be 200 MB and is read before a handler knows whether it will accept it,
// so without a gate a few parallel requests could exhaust memory or disk — on the sealed
// route even without an account. The gate allows only a few uploads at once (in total and
// per account / client address) and reserves their declared size against the free disk
// space, so uploads that are still on their way cannot fill the disk together.
type UploadGate struct {
	slots   chan struct{}
	perKey  int
	wait    time.Duration
	minFree uint64
	store   storage.Storage

	mu       sync.Mutex
	active   map[string]int
	reserved int64
}

const (
	uploadSlots     = 8
	uploadsPerKey   = 3
	uploadSlotWait  = 20 * time.Second
	uploadMemory    = 1 << 20 // per upload kept in RAM; the rest goes to a temp file on the media disk
	maxUploadBodies = MaxMediaBytes + 5<<20
)

func NewUploadGate(store storage.Storage, quota *MediaQuota) *UploadGate {
	g := &UploadGate{
		slots:  make(chan struct{}, uploadSlots),
		perKey: uploadsPerKey,
		wait:   uploadSlotWait,
		store:  store,
		active: map[string]int{},
	}
	if quota != nil {
		g.minFree = quota.MinFreeBytes
	}
	return g
}

func (g *UploadGate) enter(key string, size int64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active[key] >= g.perKey {
		return echo.NewHTTPError(http.StatusTooManyRequests, "too many uploads at once — wait for the running ones")
	}
	if fs, ok := g.store.(freeSpacer); ok && g.minFree > 0 {
		if free, err := fs.FreeBytes(); err == nil && free < g.minFree+uint64(g.reserved+size) {
			return quotaError(http.StatusInsufficientStorage, "server_full", "this server is out of storage right now — try again later")
		}
	}
	g.active[key]++
	g.reserved += size
	return nil
}

func (g *UploadGate) leave(key string, size int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active[key] <= 1 {
		delete(g.active, key)
	} else {
		g.active[key]--
	}
	g.reserved -= size
}

// Middleware admits the request or answers 429 / 503 / 507 without reading the body.
// key names who is uploading (account id, or the client address for sealed sender).
func (g *UploadGate) Middleware(key func(echo.Context) string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			size := c.Request().ContentLength
			if size < 0 || size > maxUploadBodies {
				size = maxUploadBodies // unknown length: assume the largest allowed body
			}
			k := key(c)
			if err := g.enter(k, size); err != nil {
				return err
			}
			defer g.leave(k, size)

			select {
			case g.slots <- struct{}{}:
			default:
				t := time.NewTimer(g.wait)
				defer t.Stop()
				select {
				case g.slots <- struct{}{}:
				case <-t.C:
					c.Response().Header().Set("Retry-After", "30")
					return echo.NewHTTPError(http.StatusServiceUnavailable, "the server is busy with other uploads — try again in a moment")
				case <-c.Request().Context().Done():
					return echo.NewHTTPError(http.StatusServiceUnavailable, "upload cancelled")
				}
			}
			defer func() { <-g.slots }()
			return next(c)
		}
	}
}

// parseUpload reads the multipart body: at most 1 MB stays in memory, larger files go to a
// temp file (TMPDIR — the server points it at the media disk, not at the in-memory /tmp).
// Handlers call it after every check that does not need the body, and before FormValue /
// FormFile (which would otherwise buffer up to 32 MB in memory).
func parseUpload(c echo.Context) error {
	if err := c.Request().ParseMultipartForm(uploadMemory); err != nil {
		var he *echo.HTTPError
		if errors.As(err, &he) {
			return he // e.g. 413 from the body limit
		}
		return echo.NewHTTPError(http.StatusBadRequest, "invalid upload")
	}
	return nil
}

// ClientKey identifies a client address for rate limits: the IPv4 address, or the /64 of an
// IPv6 address (one customer line owns a whole /64 and could otherwise rotate through it).
func ClientKey(c echo.Context) string {
	raw := c.RealIP()
	ip := net.ParseIP(raw)
	if ip == nil {
		return raw
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
