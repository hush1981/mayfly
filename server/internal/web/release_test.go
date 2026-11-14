package web

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseIndexPicksNewestValidRelease(t *testing.T) {
	idx := `{"packages":{
	  "de.paul42.mayfly":[
	    {"versionCode":11,"versionName":"2.2.0","apkName":"de.paul42.mayfly_11.apk"},
	    {"versionCode":99,"versionName":"9.9","apkName":"../evil.apk"},
	    {"versionCode":98,"versionName":"<script>","apkName":"de.paul42.mayfly_98.apk"},
	    {"versionCode":12,"versionName":"2.3.0","apkName":"de.paul42.mayfly_12.apk"}],
	  "de.paul42.mayfly.beta":[{"versionCode":50,"versionName":"x","apkName":"de.paul42.mayfly.beta_50.apk"}]}}`
	r, err := parseIndex(strings.NewReader(idx))
	if err != nil {
		t.Fatal(err)
	}
	if r.VersionCode != 12 || r.VersionName != "2.3.0" || r.APK != "de.paul42.mayfly_12.apk" {
		t.Fatalf("got %+v", r)
	}
}

func TestParseIndexWithoutApp(t *testing.T) {
	if _, err := parseIndex(strings.NewReader(`{"packages":{}}`)); err == nil {
		t.Fatal("expected error")
	}
}

func TestLatestRefreshesWhenStale(t *testing.T) {
	code := 12
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"packages":{"de.paul42.mayfly":[{"versionCode":%d,"versionName":"2.%d","apkName":"de.paul42.mayfly_%d.apk"}]}}`, code, code, code)
	}))
	defer srv.Close()
	r := &releases{url: srv.URL}
	if got, _ := r.latest(); got.VersionCode != 12 {
		t.Fatalf("first lookup: %+v", got)
	}
	code = 13 // new F-Droid release
	if got, _ := r.latest(); got.VersionCode != 12 {
		t.Fatalf("fresh cache must not refetch: %+v", got)
	}
	r.mu.Lock()
	r.checked = time.Now().Add(-2 * maxAge)
	r.mu.Unlock()
	if got, _ := r.latest(); got.VersionCode != 13 || got.APK != "de.paul42.mayfly_13.apk" {
		t.Fatalf("stale cache not refreshed: %+v", got)
	}
}
