package web

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sync"
	"time"
)

type release struct {
	VersionCode int64
	VersionName string
	APK         string
}

// releases keeps the newest release of AppID from the F-Droid index, refreshed in the
// background. Only a validated file name on RepoURL is ever used, so the index cannot
// redirect visitors anywhere else.
type releases struct {
	url     string
	mu      sync.RWMutex
	cur     *release
	checked time.Time // last lookup attempt

	fetching sync.Mutex // one lookup at a time
}

// maxAge: a request refreshes the release info when it is older than this, so the page,
// /download and the app's update check show a new F-Droid release within about a minute.
const maxAge = time.Minute

var (
	apkName     = regexp.MustCompile(`^de\.paul42\.mayfly_[0-9]{1,9}\.apk$`)
	versionName = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,32}$`)
	httpClient  = &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
)

func newReleases(url string) *releases {
	if url == "" {
		url = DefaultIndexURL
	}
	r := &releases{url: url}
	if url != "off" {
		go r.loop()
	}
	return r
}

func (r *releases) latest() (release, bool) {
	if r.url != "off" {
		r.mu.RLock()
		stale := time.Since(r.checked) > maxAge
		r.mu.RUnlock()
		// Refresh on demand; if another request is already fetching, use what we have.
		if stale && r.fetching.TryLock() {
			if err := r.refreshWith(3 * time.Second); err != nil {
				log.Printf("web: release lookup: %v", err)
			}
			r.fetching.Unlock()
		}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.cur == nil {
		return release{}, false
	}
	return *r.cur, true
}

func (r *releases) loop() {
	for {
		wait := 15 * time.Minute
		r.fetching.Lock()
		err := r.refreshWith(15 * time.Second)
		r.fetching.Unlock()
		if err != nil {
			log.Printf("web: release lookup: %v", err)
			if _, ok := r.latest(); !ok {
				wait = 2 * time.Minute
			}
		}
		time.Sleep(wait)
	}
}

func (r *releases) refreshWith(timeout time.Duration) error {
	r.mu.Lock()
	r.checked = time.Now()
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url, nil)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	rel, err := parseIndex(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.cur = rel
	r.mu.Unlock()
	return nil
}

func parseIndex(body io.Reader) (*release, error) {
	var idx struct {
		Packages map[string][]struct {
			VersionCode int64  `json:"versionCode"`
			VersionName string `json:"versionName"`
			ApkName     string `json:"apkName"`
		} `json:"packages"`
	}
	if err := json.NewDecoder(body).Decode(&idx); err != nil {
		return nil, err
	}
	var best *release
	for _, p := range idx.Packages[AppID] {
		if !apkName.MatchString(p.ApkName) || !versionName.MatchString(p.VersionName) {
			continue
		}
		if best == nil || p.VersionCode > best.VersionCode {
			best = &release{VersionCode: p.VersionCode, VersionName: p.VersionName, APK: p.ApkName}
		}
	}
	if best == nil {
		return nil, fmt.Errorf("no valid %s release in index", AppID)
	}
	return best, nil
}
