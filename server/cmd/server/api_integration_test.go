//go:build integration

// Integration tests against a real PostgreSQL (DATABASE_URL). Run:
//
//	DATABASE_URL=postgres://… JWT_SECRET=<32+ chars> go test -tags integration ./cmd/server/
//
// They exercise the full HTTP stack (middleware, rate limits, handlers, SQL).
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appdb "github.com/hush1981/mayfly/server/internal/db"
	"github.com/hush1981/mayfly/server/internal/storage"
)

var srv, strict *httptest.Server

func TestMain(m *testing.M) {
	if os.Getenv("DATABASE_URL") == "" {
		fmt.Println("DATABASE_URL not set — skipping integration tests")
		os.Exit(0)
	}
	pool, err := appdb.Connect()
	if err != nil {
		panic(err)
	}
	if err := appdb.Migrate(pool); err != nil {
		panic(err)
	}
	// Many registrations per test run: lift the per-IP auth limit for the main server.
	// The brute-force test builds its own server with the production default.
	os.Setenv("AUTH_BURST", "1000")
	os.Setenv("FDROID_INDEX_URL", "off")
	friendName = uniq("site")
	os.Setenv("SITE_FRIEND_USER", friendName)
	dir, _ := os.MkdirTemp("", "mayfly-it")
	testDir = dir
	store, _ := storage.NewLocalStorage(dir)
	avatars, _ := storage.NewLocalStorage(filepath.Join(dir, "avatars"))
	groups, _ := storage.NewLocalStorage(filepath.Join(dir, "group-avatars"))
	srv = httptest.NewServer(newServer(pool, store, avatars, groups))
	os.Unsetenv("AUTH_BURST")
	// The strict server also has a tiny upload quota (see the quota test).
	os.Setenv("MEDIA_MAX_PENDING_PER_SENDER", "2")
	strict = httptest.NewServer(newServer(pool, store, avatars, groups))
	os.Unsetenv("MEDIA_MAX_PENDING_PER_SENDER")
	code := m.Run()
	srv.Close()
	os.RemoveAll(dir)
	os.Exit(code)
}

var friendName string

// testDir is the storage directory of the test servers (media, avatars/, group-avatars/).
var testDir string

func b64(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

func uniq(prefix string) string {
	b := make([]byte, 4)
	rand.Read(b)
	return fmt.Sprintf("%s_%x", prefix, b)
}

type resp struct {
	code int
	body map[string]any
	raw  []byte
	hdr  http.Header
}

func call(t *testing.T, method, path, token string, body any) resp {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		j, _ := json.Marshal(body)
		rdr = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	out := resp{code: r.StatusCode, raw: raw, hdr: r.Header}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

type user struct{ id, name, pw, token string }

func register(t *testing.T, prefix string) user {
	t.Helper()
	u := user{name: uniq(prefix), pw: "password-" + b64(6)}
	r := call(t, "POST", "/auth/register", "", map[string]string{"username": u.name, "password": u.pw, "public_key": b64(32)})
	if r.code != 201 {
		t.Fatalf("register %s: %d %s", u.name, r.code, r.raw)
	}
	l := call(t, "POST", "/auth/login", "", map[string]string{"username": u.name, "password": u.pw})
	if l.code != 200 {
		t.Fatalf("login: %d %s", l.code, l.raw)
	}
	u.id, u.token = l.body["user_id"].(string), l.body["token"].(string)
	return u
}

func befriend(t *testing.T, a, b user) {
	t.Helper()
	if r := call(t, "POST", "/friends/request", a.token, map[string]string{"username": b.name}); r.code != 201 {
		t.Fatalf("friend request: %d %s", r.code, r.raw)
	}
	reqs := call(t, "GET", "/friends/requests", b.token, nil)
	var list []map[string]any
	json.Unmarshal(reqs.raw, &list)
	for _, q := range list {
		call(t, "POST", "/friends/accept/"+q["id"].(string), b.token, nil)
	}
}

func sendMedia(t *testing.T, from user, to string, groupID string, mediaType ...string) resp {
	return sendMediaTo(t, srv.URL, from, to, groupID, mediaType...)
}

func sendMediaTo(t *testing.T, base string, from user, to string, groupID string, mediaType ...string) resp {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("recipient_id", to)
	w.WriteField("ephemeral_public_key", b64(32))
	w.WriteField("nonce", b64(24))
	mt := "image"
	if len(mediaType) > 0 {
		mt = mediaType[0]
	}
	w.WriteField("media_type", mt)
	if groupID != "" {
		w.WriteField("group_id", groupID)
	}
	fw, _ := w.CreateFormFile("encrypted_file", "media")
	fw.Write([]byte("ciphertext-bytes"))
	w.Close()
	req, _ := http.NewRequest("POST", base+"/media/send", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+from.token)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	out := resp{code: r.StatusCode, raw: raw}
	json.Unmarshal(raw, &out.body)
	return out
}

func expect(t *testing.T, what string, got resp, want int) {
	t.Helper()
	if got.code != want {
		t.Errorf("%s: got %d want %d (%s)", what, got.code, want, got.raw)
	}
}

func TestAPI(t *testing.T) {
	alice, bob, eve := register(t, "alice"), register(t, "bob"), register(t, "eve")
	befriend(t, alice, bob)

	t.Run("security headers and no search", func(t *testing.T) {
		r := call(t, "GET", "/friends", alice.token, nil)
		for _, h := range []string{"X-Content-Type-Options", "X-Frame-Options", "Content-Security-Policy", "Cache-Control"} {
			if r.hdr.Get(h) == "" {
				t.Errorf("missing header %s", h)
			}
		}
		expect(t, "user search removed", call(t, "GET", "/users/search?q=al", alice.token, nil), 404)
		expect(t, "no token", call(t, "GET", "/friends", "", nil), 401)
		expect(t, "garbage token", call(t, "GET", "/friends", "abc.def.ghi", nil), 401)
	})

	t.Run("landing page is public, API stays closed", func(t *testing.T) {
		pub := make([]byte, 32)
		rand.Read(pub)
		reg := call(t, "POST", "/auth/register", "", map[string]string{"username": friendName, "password": "password-" + b64(6), "public_key": base64.StdEncoding.EncodeToString(pub)})
		expect(t, "register site friend", reg, 201)
		r := call(t, "GET", "/", "", nil)
		expect(t, "page", r, 200)
		if want := "mayfly-friend:1:" + friendName + ":" + base64.RawURLEncoding.EncodeToString(pub); !bytes.Contains(r.raw, []byte(want)) {
			t.Errorf("friend QR payload missing (%s)", want)
		}
		if !strings.HasPrefix(r.hdr.Get("Content-Type"), "text/html") || !bytes.Contains(r.raw, []byte("fdroid.paul42.de/repo?fingerprint=")) {
			t.Errorf("unexpected page: %s %.200s", r.hdr.Get("Content-Type"), r.raw)
		}
		if csp := r.hdr.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "unsafe") {
			t.Errorf("page CSP: %q", csp)
		}
		if bytes.Contains(r.raw, []byte("ZgotmplZ")) {
			t.Error("template sanitised a link")
		}
		expect(t, "css", call(t, "GET", "/site/site.css", "", nil), 200)
		expect(t, "template not served raw", call(t, "GET", "/site/index.html", "", nil), 404)
		expect(t, "no traversal", call(t, "GET", "/site/../go.mod", "", nil), 404)
		expect(t, "unknown path still needs auth", call(t, "GET", "/whatever", "", nil), 401)
		expect(t, "version unknown without index", call(t, "GET", "/version", "", nil), 404)
		noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		d, err := noFollow.Get(srv.URL + "/download")
		if err != nil {
			t.Fatal(err)
		}
		d.Body.Close()
		if d.StatusCode != 302 || !strings.HasPrefix(d.Header.Get("Location"), "https://fdroid.paul42.de/repo/") {
			t.Errorf("download: %d %s", d.StatusCode, d.Header.Get("Location"))
		}
	})

	t.Run("public keys and avatars only for contacts", func(t *testing.T) {
		expect(t, "friend key", call(t, "GET", "/users/"+alice.id+"/public-key", bob.token, nil), 200)
		expect(t, "stranger key", call(t, "GET", "/users/"+alice.id+"/public-key", eve.token, nil), 403)
		expect(t, "stranger avatar", call(t, "GET", "/users/"+alice.id+"/avatar", eve.token, nil), 404)
	})

	t.Run("relay: contacts only, ack deletes only own", func(t *testing.T) {
		msg := map[string]any{"recipient_id": alice.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(100)}
		expect(t, "stranger relay", call(t, "POST", "/relay", eve.token, msg), 403)
		expect(t, "friend relay", call(t, "POST", "/relay", bob.token, msg), 201)
		big := map[string]any{"recipient_id": alice.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(25000)}
		expect(t, "oversized payload", call(t, "POST", "/relay", bob.token, big), 400)
		list := call(t, "GET", "/relay", alice.token, nil)
		var msgs []map[string]any
		json.Unmarshal(list.raw, &msgs)
		if len(msgs) != 1 || msgs[0]["sender_id"] != bob.id {
			t.Fatalf("alice relay inbox: %s", list.raw)
		}
		id := msgs[0]["id"].(string)
		call(t, "POST", "/relay/ack", eve.token, map[string]any{"ids": []string{id}}) // must not delete
		var again []map[string]any
		json.Unmarshal(call(t, "GET", "/relay", alice.token, nil).raw, &again)
		if len(again) != 1 {
			t.Fatalf("foreign ack deleted the message")
		}
		call(t, "POST", "/relay/ack", alice.token, map[string]any{"ids": []string{id}})
		var after []map[string]any
		json.Unmarshal(call(t, "GET", "/relay", alice.token, nil).raw, &after)
		if len(after) != 0 {
			t.Fatalf("ack did not delete")
		}
	})

	t.Run("media: no sending to strangers, no group bypass, view once", func(t *testing.T) {
		expect(t, "stranger moment", sendMedia(t, eve, alice.id, ""), 403)
		g := call(t, "POST", "/groups", eve.token, map[string]string{"name": "evil"})
		expect(t, "group bypass", sendMedia(t, eve, alice.id, g.body["id"].(string)), 403)
		sent := sendMedia(t, bob, alice.id, "")
		expect(t, "friend moment", sent, 201)
		mid := sent.body["media_id"].(string)
		expect(t, "other user download", call(t, "GET", "/media/"+mid, eve.token, nil), 404)
		expect(t, "sender download", call(t, "GET", "/media/"+mid, bob.token, nil), 404)
		expect(t, "recipient download", call(t, "GET", "/media/"+mid, alice.token, nil), 200)
		expect(t, "mark viewed", call(t, "POST", "/media/"+mid+"/viewed", alice.token, nil), 204)
		expect(t, "download after view", call(t, "GET", "/media/"+mid, alice.token, nil), 404)
	})

	t.Run("unsend: only the sender, only while unopened; voice messages", func(t *testing.T) {
		expect(t, "bad media type", sendMedia(t, bob, alice.id, "", "exe"), 400)
		voice := sendMedia(t, bob, alice.id, "", "audio")
		expect(t, "voice message", voice, 201)
		vid := voice.body["media_id"].(string)
		expect(t, "recipient cannot unsend", call(t, "DELETE", "/media/"+vid, alice.token, nil), 404)
		expect(t, "stranger cannot unsend", call(t, "DELETE", "/media/"+vid, eve.token, nil), 404)
		expect(t, "sender unsends", call(t, "DELETE", "/media/"+vid, bob.token, nil), 204)
		expect(t, "gone for recipient", call(t, "GET", "/media/"+vid, alice.token, nil), 404)
		opened := sendMedia(t, bob, alice.id, "")
		oid := opened.body["media_id"].(string)
		expect(t, "view", call(t, "POST", "/media/"+oid+"/viewed", alice.token, nil), 204)
		expect(t, "unsend after open", call(t, "DELETE", "/media/"+oid, bob.token, nil), 404)
	})

	t.Run("blocking cuts everything between two users", func(t *testing.T) {
		carol, dave := register(t, "carol"), register(t, "dave")
		befriend(t, carol, dave)
		pending := sendMedia(t, dave, carol.id, "")
		expect(t, "moment before block", pending, 201)
		g := call(t, "POST", "/groups", carol.token, map[string]string{"name": "both"})
		gid := g.body["id"].(string)
		expect(t, "add dave to group", call(t, "POST", "/groups/"+gid+"/members", carol.token, map[string]string{"user_id": dave.id}), 204)

		expect(t, "block", call(t, "POST", "/blocks", carol.token, map[string]string{"user_id": dave.id}), 204)
		expect(t, "block again (idempotent)", call(t, "POST", "/blocks", carol.token, map[string]string{"user_id": dave.id}), 204)
		expect(t, "cannot block self", call(t, "POST", "/blocks", carol.token, map[string]string{"user_id": carol.id}), 400)

		var friends []map[string]any
		json.Unmarshal(call(t, "GET", "/friends", carol.token, nil).raw, &friends)
		if len(friends) != 0 {
			t.Errorf("friendship survived the block: %v", friends)
		}
		var inbox []map[string]any
		json.Unmarshal(call(t, "GET", "/media/inbox", carol.token, nil).raw, &inbox)
		if len(inbox) != 0 {
			t.Errorf("pending moment from blocked user still in inbox")
		}
		expect(t, "blocked: direct moment", sendMedia(t, dave, carol.id, ""), 403)
		expect(t, "blocked: group moment", sendMedia(t, dave, carol.id, gid), 403)
		expect(t, "blocker: group moment", sendMedia(t, carol, dave.id, gid), 403)
		msg := map[string]any{"recipient_id": carol.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(100)}
		expect(t, "blocked: relay", call(t, "POST", "/relay", dave.token, msg), 403)
		expect(t, "blocked: public key", call(t, "GET", "/users/"+carol.id+"/public-key", dave.token, nil), 403)
		expect(t, "blocked: friend request looks like unknown user", call(t, "POST", "/friends/request", dave.token, map[string]string{"username": carol.name}), 404)
		expect(t, "blocker: friend request needs unblock", call(t, "POST", "/friends/request", carol.token, map[string]string{"username": dave.name}), 403)

		var blocked []map[string]any
		json.Unmarshal(call(t, "GET", "/blocks", carol.token, nil).raw, &blocked)
		if len(blocked) != 1 || blocked[0]["id"] != dave.id {
			t.Errorf("block list: %v", blocked)
		}
		expect(t, "unblock", call(t, "DELETE", "/blocks/"+dave.id, carol.token, nil), 204)
		expect(t, "request after unblock", call(t, "POST", "/friends/request", dave.token, map[string]string{"username": carol.name}), 201)
	})

	t.Run("upload quota stops one user from filling the disk", func(t *testing.T) {
		u1, u2 := register(t, "q1"), register(t, "q2")
		befriend(t, u1, u2)
		expect(t, "1st", sendMediaTo(t, strict.URL, u1, u2.id, ""), 201)
		expect(t, "2nd", sendMediaTo(t, strict.URL, u1, u2.id, ""), 201)
		over := sendMediaTo(t, strict.URL, u1, u2.id, "")
		expect(t, "3rd over quota", over, 429)
		if over.body["code"] != "quota" {
			t.Errorf("quota error without code: %s", over.raw)
		}
	})

	t.Run("group picture only for members", func(t *testing.T) {
		owner, outsider := register(t, "gown"), register(t, "gout")
		g := call(t, "POST", "/groups", owner.token, map[string]string{"name": "pics"})
		gid := g.body["id"].(string)
		expect(t, "outsider", call(t, "GET", "/groups/"+gid+"/avatar", outsider.token, nil), 404)
		expect(t, "bad uid", call(t, "DELETE", "/groups/"+gid+"/members/not-a-uuid", owner.token, nil), 404)
	})

	t.Run("push endpoint validation (SSRF)", func(t *testing.T) {
		expect(t, "http endpoint", call(t, "PUT", "/users/me/push", alice.token, map[string]string{"endpoint": "http://10.0.0.1/x"}), 400)
		expect(t, "credentials in url", call(t, "PUT", "/users/me/push", alice.token, map[string]string{"endpoint": "https://u:p@example.org/x"}), 400)
		expect(t, "valid endpoint", call(t, "PUT", "/users/me/push", alice.token, map[string]string{"endpoint": "https://ntfy.example.org/upAbc?up=1"}), 204)
		r := call(t, "GET", "/users/me/push", alice.token, nil)
		if r.body["enabled"] != true {
			t.Errorf("push not enabled: %s", r.raw)
		}
	})

	t.Run("password change logs out other sessions", func(t *testing.T) {
		u := register(t, "pw")
		old := u.token
		expect(t, "wrong current password", call(t, "PUT", "/users/me/password", old, map[string]string{"current_password": "nope-nope", "new_password": "new-password-1"}), 401)
		r := call(t, "PUT", "/users/me/password", old, map[string]string{"current_password": u.pw, "new_password": "new-password-1"})
		expect(t, "change password", r, 200)
		expect(t, "old token after change", call(t, "GET", "/friends", old, nil), 401)
		expect(t, "new token", call(t, "GET", "/friends", r.body["token"].(string), nil), 200)
		expect(t, "login old password", call(t, "POST", "/auth/login", "", map[string]string{"username": u.name, "password": u.pw}), 401)
	})

	t.Run("delete account revokes access immediately", func(t *testing.T) {
		u := register(t, "del")
		expect(t, "delete wrong password", call(t, "POST", "/users/me/delete", u.token, map[string]string{"password": "wrong-pass"}), 401)
		expect(t, "delete", call(t, "POST", "/users/me/delete", u.token, map[string]string{"password": u.pw}), 204)
		expect(t, "token after delete", call(t, "GET", "/friends", u.token, nil), 401)
	})

	t.Run("invite code when REGISTRATION_TOKEN is set", func(t *testing.T) {
		os.Setenv("REGISTRATION_TOKEN", "invite-123")
		defer os.Unsetenv("REGISTRATION_TOKEN")
		body := map[string]string{"username": uniq("inv"), "password": "password-123", "public_key": b64(32)}
		expect(t, "without invite", call(t, "POST", "/auth/register", "", body), 403)
		body["invite"] = "invite-123"
		expect(t, "with invite", call(t, "POST", "/auth/register", "", body), 201)
	})

	// Production limits (separate server instance with the default AUTH_BURST).
	t.Run("login brute force is rate limited", func(t *testing.T) {
		limited := false
		for i := 0; i < 25 && !limited; i++ {
			j, _ := json.Marshal(map[string]string{"username": alice.name, "password": "wrong-password"})
			r, err := http.Post(strict.URL+"/auth/login", "application/json", bytes.NewReader(j))
			if err != nil {
				t.Fatal(err)
			}
			r.Body.Close()
			limited = r.StatusCode == 429
			time.Sleep(5 * time.Millisecond)
		}
		if !limited {
			t.Error("no 429 after 25 failed logins")
		}
	})
}
