package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

type fakeStore struct{ free uint64 }

func (f *fakeStore) Save(string, io.Reader) error         { return nil }
func (f *fakeStore) Load(string) (io.ReadCloser, error)   { return nil, nil }
func (f *fakeStore) Delete(string) error                  { return nil }
func (f *fakeStore) FreeBytes() (uint64, error)           { return f.free, nil }

func TestUploadGatePerKeyAndReservation(t *testing.T) {
	st := &fakeStore{free: 1000}
	g := NewUploadGate(st, &MediaQuota{MinFreeBytes: 100})

	for i := 0; i < uploadsPerKey; i++ {
		if err := g.enter("u:a", 10); err != nil {
			t.Fatalf("upload %d refused: %v", i, err)
		}
	}
	if err := g.enter("u:a", 10); err == nil {
		t.Fatal("one account must not run more than its share of uploads at once")
	}
	if err := g.enter("u:b", 10); err != nil {
		t.Fatalf("another account is not affected: %v", err)
	}

	// 40 bytes are reserved; 1000 free - 100 minimum leaves room for 860 more.
	if err := g.enter("u:c", 861); err == nil {
		t.Fatal("uploads on their way must count against the free space")
	}
	if err := g.enter("u:c", 860); err != nil {
		t.Fatalf("fits exactly: %v", err)
	}
	g.leave("u:c", 860)
	for i := 0; i < uploadsPerKey; i++ {
		g.leave("u:a", 10)
	}
	g.leave("u:b", 10)
	if g.reserved != 0 || len(g.active) != 0 {
		t.Fatalf("gate not empty after all left: %d %v", g.reserved, g.active)
	}
}

func TestClientKey(t *testing.T) {
	e := echo.New()
	e.IPExtractor = echo.ExtractIPDirect()
	for addr, want := range map[string]string{
		"203.0.113.7:1234":              "203.0.113.7",
		"[2001:db8:1:2:aaaa::1]:1234":   "2001:db8:1:2::/64",
		"[2001:db8:1:2:ffff:1:2:3]:999": "2001:db8:1:2::/64",
		"[2001:db8:1:3::1]:1234":        "2001:db8:1:3::/64",
		"[::ffff:198.51.100.4]:80":      "198.51.100.4",
	} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = addr
		if got := ClientKey(e.NewContext(req, httptest.NewRecorder())); got != want {
			t.Errorf("%s → %q, want %q", addr, got, want)
		}
	}
}

func TestWakeThrottle(t *testing.T) {
	w := &wakeThrottle{m: map[string]*wakeEntry{}}
	allowed := 0
	for i := 0; i < 50; i++ {
		if w.allow("user") {
			allowed++
		}
	}
	if allowed != 10 {
		t.Errorf("burst must be 10, got %d", allowed)
	}
	if !w.allow("someone else") {
		t.Error("another recipient has its own budget")
	}
}
