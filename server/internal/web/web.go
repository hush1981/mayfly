// Package web serves the public landing page (what Mayfly is, how to install it).
//
// Everything is embedded in the binary: no external fonts, scripts or trackers. The page
// gets its own (still strict) CSP; the API keeps "default-src 'none'".
package web

import (
	"bytes"
	"embed"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

//go:embed static
var files embed.FS

const (
	// RepoURL is the F-Droid repository that hosts the signed release builds.
	RepoURL = "https://fdroid.paul42.de/repo"
	// RepoFingerprint is the SHA-256 of the repo signing certificate (checked by F-Droid on add).
	RepoFingerprint = "45AD2945568B96FCBF5DCE87ED36749731B358D0E6E55C06553FF201D195B1DF"
	// AppID is the release package name.
	AppID = "de.paul42.mayfly"
	// DefaultIndexURL is where the latest release is looked up.
	DefaultIndexURL = RepoURL + "/index-v1.json"
)

const pageCSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type pageData struct {
	Version     string
	RepoURL     string
	RepoAddURL  string       // https link, also what the QR code encodes
	RepoDeepURL template.URL // fdroidrepos:// opens F-Droid directly (constant, so safe to mark)
	Fingerprint string
	AppID       string
	FriendName  string // optional "add me" code on the page
	FriendQR    string
}

// Options configures Register.
type Options struct {
	// IndexURL: "" uses DefaultIndexURL, "off" disables the release lookup (tests).
	IndexURL string
	// FriendCode, if set, returns the username and the friend QR payload shown on the page.
	FriendCode func() (name, payload string, ok bool)
}

// cachedFriend keeps the friend code for a few minutes so the public page does not
// cost a database query per request.
type cachedFriend struct {
	get  func() (string, string, bool)
	mu   sync.Mutex
	at   time.Time
	name string
	qr   string
	ok   bool
}

func (f *cachedFriend) value() (string, string, bool) {
	if f.get == nil {
		return "", "", false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if time.Since(f.at) > 5*time.Minute {
		f.name, f.qr, f.ok = f.get()
		f.at = time.Now()
	}
	return f.name, f.qr, f.ok
}

// Register adds GET /, GET /datenschutz, GET /version, GET /download and GET /site/* to e.
func Register(e *echo.Echo, opt Options) {
	tpl := template.Must(template.ParseFS(files, "static/index.html"))
	privacy, err := fs.ReadFile(files, "static/datenschutz.html")
	if err != nil {
		panic(err)
	}
	rel := newReleases(opt.IndexURL)
	friend := &cachedFriend{get: opt.FriendCode}

	page := func(c echo.Context) error {
		r, _ := rel.latest()
		data := pageData{
			Version:     r.VersionName,
			RepoURL:     RepoURL,
			RepoAddURL:  RepoURL + "?fingerprint=" + RepoFingerprint,
			RepoDeepURL: template.URL("fdroidrepos://fdroid.paul42.de/repo?fingerprint=" + RepoFingerprint),
			Fingerprint: RepoFingerprint,
			AppID:       AppID,
		}
		if name, qr, ok := friend.value(); ok {
			data.FriendName, data.FriendQR = name, qr
		}
		var buf bytes.Buffer
		if err := tpl.Execute(&buf, data); err != nil {
			log.Printf("web: render: %v", err)
			return echo.NewHTTPError(http.StatusInternalServerError)
		}
		h := c.Response().Header()
		h.Set("Content-Security-Policy", pageCSP)
		h.Set("Cache-Control", "no-cache")
		return c.HTMLBlob(http.StatusOK, buf.Bytes())
	}
	e.GET("/", page)
	e.HEAD("/", page)

	// Privacy policy (static, same CSP as the landing page).
	privacyPage := func(c echo.Context) error {
		h := c.Response().Header()
		h.Set("Content-Security-Policy", pageCSP)
		h.Set("Cache-Control", "no-cache")
		return c.HTMLBlob(http.StatusOK, privacy)
	}
	e.GET("/datenschutz", privacyPage)
	e.HEAD("/datenschutz", privacyPage)

	// Newest release, for the app's update notice (no auth, nothing personal).
	e.GET("/version", func(c echo.Context) error {
		c.Response().Header().Set("Cache-Control", "no-cache")
		r, ok := rel.latest()
		if !ok {
			return echo.NewHTTPError(http.StatusNotFound, "unknown")
		}
		return c.JSON(http.StatusOK, map[string]any{"version_code": r.VersionCode, "version_name": r.VersionName})
	})

	// Stable link (QR code) to the newest release APK.
	e.GET("/download", func(c echo.Context) error {
		target := RepoURL + "/"
		if r, ok := rel.latest(); ok {
			target = RepoURL + "/" + r.APK
		}
		c.Response().Header().Set("Cache-Control", "no-cache")
		return c.Redirect(http.StatusFound, target)
	})

	static, _ := fs.Sub(files, "static")
	assets := http.FileServer(http.FS(static))
	e.GET("/site/*", func(c echo.Context) error {
		name := c.Param("*")
		if name == "" || strings.HasSuffix(name, ".html") {
			return echo.ErrNotFound
		}
		if _, err := fs.Stat(static, name); err != nil {
			return echo.ErrNotFound
		}
		h := c.Response().Header()
		h.Set("Cache-Control", "public, max-age=3600")
		req := c.Request().Clone(c.Request().Context())
		req.URL.Path = "/" + name
		assets.ServeHTTP(c.Response(), req)
		return nil
	})
}
