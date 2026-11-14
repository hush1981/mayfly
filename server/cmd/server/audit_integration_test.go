//go:build integration

// Regression tests for the 2026-11 security audit.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// paced repeats a request while the general per-user / per-address rate limit answers
// (these tests send hundreds of requests; the limit itself is what slows a real flood down).
func paced(f func() resp) resp {
	for {
		r := f()
		if r.code != 429 || !strings.Contains(string(r.raw), "rate limit exceeded") {
			return r
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func relay(t *testing.T, from user, to string) resp {
	t.Helper()
	return paced(func() resp {
		return call(t, "POST", "/relay", from.token, map[string]any{
			"recipient_id": to, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(40),
		})
	})
}

func relayCount(t *testing.T, u user) (total int, bySender map[string]int) {
	t.Helper()
	bySender = map[string]int{}
	// GET /relay returns at most 200 per call; count by acknowledging in rounds.
	for {
		r := paced(func() resp { return call(t, "GET", "/relay", u.token, nil) })
		var list []map[string]any
		json.Unmarshal(r.raw, &list)
		if len(list) == 0 {
			return
		}
		ids := make([]string, 0, len(list))
		for _, m := range list {
			ids = append(ids, m["id"].(string))
			bySender[m["sender_id"].(string)]++
			total++
		}
		call(t, "POST", "/relay/ack", u.token, map[string]any{"ids": ids})
	}
}

func TestSessionRefresh(t *testing.T) {
	u := register(t, "sess")
	r := call(t, "POST", "/auth/refresh", u.token, nil)
	expect(t, "refresh", r, 200)
	fresh, _ := r.body["token"].(string)
	if fresh == "" || r.body["expires_in"].(float64) < 86400*7 {
		t.Fatalf("refresh answer: %s", r.raw)
	}
	expect(t, "fresh token works", call(t, "GET", "/friends", fresh, nil), 200)
	expect(t, "refresh needs a session", call(t, "POST", "/auth/refresh", "", nil), 401)

	// A dead session is marked with code "auth", a wrong password is not (the app must not
	// treat a mistyped password as "logged out").
	bad := call(t, "GET", "/friends", "abc.def.ghi", nil)
	if bad.code != 401 || bad.body["code"] != "auth" {
		t.Errorf("invalid token: %d %s", bad.code, bad.raw)
	}
	wrong := call(t, "POST", "/users/me/delete", u.token, map[string]string{"password": "definitely-wrong"})
	if wrong.code != 401 || wrong.body["code"] == "auth" {
		t.Errorf("wrong password: %d %s", wrong.code, wrong.raw)
	}

	// Password change: old tokens (also refreshed ones) stop, with code "auth".
	ch := call(t, "PUT", "/users/me/password", u.token, map[string]string{"current_password": u.pw, "new_password": "another-password-1"})
	expect(t, "change password", ch, 200)
	old := call(t, "POST", "/auth/refresh", fresh, nil)
	if old.code != 401 || old.body["code"] != "auth" {
		t.Errorf("old token after password change: %d %s", old.code, old.raw)
	}
}

func TestUsernameCase(t *testing.T) {
	name := uniq("Case")
	pw := "password-" + b64(6)
	expect(t, "register", call(t, "POST", "/auth/register", "", map[string]string{"username": name, "password": pw, "public_key": b64(32)}), 201)
	expect(t, "same name, other case", call(t, "POST", "/auth/register", "", map[string]string{
		"username": strings.ToUpper(name), "password": pw, "public_key": b64(32)}), 409)
	l := call(t, "POST", "/auth/login", "", map[string]string{"username": strings.ToLower(name), "password": pw})
	expect(t, "login with other case", l, 200)
	if l.body["username"] != name {
		t.Errorf("login must return the registered spelling, got %v", l.body["username"])
	}
	other := register(t, "caseb")
	expect(t, "friend request with other case", call(t, "POST", "/friends/request", other.token,
		map[string]string{"username": strings.ToUpper(name)}), 201)
}

func TestBroadcastListsArePrivate(t *testing.T) {
	owner, b, c, d := register(t, "lowner"), register(t, "lb"), register(t, "lc"), register(t, "ld")
	befriend(t, owner, b)
	befriend(t, owner, c)
	befriend(t, owner, d) // friend, but not on the list
	g := call(t, "POST", "/groups", owner.token, map[string]string{"name": "close friends"})
	expect(t, "create list", g, 201)
	gid := g.body["id"].(string)
	for _, m := range []user{b, c} {
		expect(t, "add", call(t, "POST", "/groups/"+gid+"/members", owner.token, map[string]string{"user_id": m.id}), 204)
	}

	// The people on a list do not see it, its members or its picture.
	var groups []map[string]any
	json.Unmarshal(call(t, "GET", "/groups", b.token, nil).raw, &groups)
	if len(groups) != 0 {
		t.Errorf("list member sees the list: %v", groups)
	}
	json.Unmarshal(call(t, "GET", "/groups", owner.token, nil).raw, &groups)
	if len(groups) != 1 {
		t.Errorf("owner must see the list: %v", groups)
	}
	expect(t, "member lists members", call(t, "GET", "/groups/"+gid+"/members", b.token, nil), 403)
	expect(t, "owner lists members", call(t, "GET", "/groups/"+gid+"/members", owner.token, nil), 200)
	expect(t, "member reads picture", call(t, "GET", "/groups/"+gid+"/avatar", b.token, nil), 404)

	// Being on the same list connects nobody: no key, no avatar, no messages, no moments.
	expect(t, "key of a list co-member", call(t, "GET", "/users/"+c.id+"/public-key", b.token, nil), 403)
	expect(t, "avatar of a list co-member", call(t, "GET", "/users/"+c.id+"/avatar", b.token, nil), 404)
	expect(t, "relay to a list co-member", relay(t, b, c.id), 403)
	expect(t, "moment to a list co-member through the list", sendMedia(t, b, c.id, gid), 403)
	expect(t, "moment to the owner through their list", sendMedia(t, b, owner.id, gid), 403)

	// The owner sends through the list — only to people on it who are still friends.
	expect(t, "owner sends through the list", sendMedia(t, owner, b.id, gid), 201)
	expect(t, "friend not on the list", sendMedia(t, owner, d.id, gid), 403)
	expect(t, "unfriend", call(t, "DELETE", "/friends/"+c.id, owner.token, nil), 204)
	expect(t, "on the list but no longer a friend", sendMedia(t, owner, c.id, gid), 403)

	// The recipient is not told which list was used.
	var inbox []map[string]any
	json.Unmarshal(call(t, "GET", "/media/inbox", b.token, nil).raw, &inbox)
	if len(inbox) != 1 || inbox[0]["group_id"] != nil || inbox[0]["group_name"] != nil {
		t.Errorf("inbox must not name the list: %v", inbox)
	}
}

func TestRelayQueueIsolation(t *testing.T) {
	victim, flooder, friend, late := register(t, "qvictim"), register(t, "qflood"), register(t, "qfriend"), register(t, "qlate")
	befriend(t, flooder, victim)
	befriend(t, friend, victim)
	befriend(t, late, victim)

	// A friend's message is waiting; another contact floods the queue.
	expect(t, "friend's message", relay(t, friend, victim.id), 201)
	for i := 0; i < 130; i++ {
		if r := relay(t, flooder, victim.id); r.code != 201 {
			t.Fatalf("flood %d: %d %s", i, r.code, r.raw)
		}
	}
	total, by := relayCount(t, victim)
	if by[friend.id] != 1 {
		t.Errorf("the friend's message was pushed out by someone else's flood (%v)", by)
	}
	if by[flooder.id] != 100 || total != 101 {
		t.Errorf("flooder must be capped at 100 own messages: total %d %v", total, by)
	}

	// Sealed sender: the shared bucket refuses when full instead of evicting.
	tok, hash := secret()
	expect(t, "set token", call(t, "PUT", "/users/me/delivery-token", victim.token, map[string]string{"token_hash": hash}), 204)
	sealed := func() resp {
		return paced(func() resp {
			j, _ := json.Marshal(map[string]any{"payload": b64(60)})
			return rawCall(t, "POST", "/sealed/relay", map[string]string{"X-Delivery-Token": tok}, bytes.NewReader(j), "application/json")
		})
	}
	expect(t, "friend's message before the sealed flood", relay(t, friend, victim.id), 201)
	for i := 0; i < 300; i++ {
		if r := sealed(); r.code != 201 {
			t.Fatalf("sealed %d: %d %s", i, r.code, r.raw)
		}
	}
	full := sealed()
	if full.code != 429 || full.body["code"] != "queue" {
		t.Errorf("full sealed bucket: %d %s", full.code, full.raw)
	}
	// Logged-in delivery still works while the sealed bucket is full (the app's fallback) …
	expect(t, "authenticated fallback", relay(t, late, victim.id), 201)
	// … until the whole queue (500) is full; then it is refused, not evicted.
	for i := 0; i < 100; i++ {
		relay(t, flooder, victim.id)
	}
	for i := 0; i < 98; i++ {
		relay(t, late, victim.id)
	}
	over := relay(t, friend, victim.id)
	if over.code != 429 || over.body["code"] != "queue" {
		t.Errorf("full queue: %d %s", over.code, over.raw)
	}
	total, by = relayCount(t, victim)
	if total != 500 || by[friend.id] != 1 || by[""] != 300 {
		t.Errorf("queue after flood: total %d %v", total, by)
	}
}

func TestSealedUploadNeedsTokenFirst(t *testing.T) {
	// A big body with an unknown token: refused without a media row or temp file being kept.
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("media_type", "image")
	w.WriteField("sealed_header", b64(120))
	fw, _ := w.CreateFormFile("encrypted_file", "media")
	fw.Write(bytes.Repeat([]byte("x"), 3<<20))
	w.Close()
	tok, _ := secret()
	r := rawCall(t, "POST", "/sealed/media", map[string]string{"X-Delivery-Token": tok}, &buf, w.FormDataContentType())
	if r.code != 404 || r.body["code"] != "token" {
		t.Errorf("unknown token: %d %s", r.code, r.raw)
	}
	r = rawCall(t, "POST", "/sealed/media", map[string]string{"X-Delivery-Token": "nonsense"}, strings.NewReader("x"), "multipart/form-data; boundary=x")
	expect(t, "malformed token", r, 400)
}

func TestLargeUploadGoesToDisk(t *testing.T) {
	a, b := register(t, "bigA"), register(t, "bigB")
	befriend(t, a, b)
	blob := bytes.Repeat([]byte("0123456789abcdef"), 3<<16) // 3 MB: beyond the in-memory part
	r := upload(t, "/media/send", a, map[string]string{
		"recipient_id": b.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "media_type": "video",
	}, blob)
	expect(t, "3 MB upload", r, 201)
	id := r.body["media_id"].(string)
	st, err := os.Stat(filepath.Join(testDir, id))
	if err != nil || st.Size() != int64(len(blob)) || st.Mode().Perm() != 0600 {
		t.Fatalf("stored file: %v %v", st, err)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/media/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+b.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got bytes.Buffer
	got.ReadFrom(res.Body)
	if !bytes.Equal(got.Bytes(), blob) {
		t.Errorf("download differs from upload (%d vs %d bytes)", got.Len(), len(blob))
	}
	// no upload temp files are left behind
	left, _ := filepath.Glob(filepath.Join(os.TempDir(), "multipart-*"))
	if len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
}

func TestFriendRequestLimit(t *testing.T) {
	u := register(t, "enum")
	var last resp
	for i := 0; i < 21; i++ {
		last = call(t, "POST", "/friends/request", u.token, map[string]string{"username": fmt.Sprintf("nobody_%s_%d", b64(3)[:3], i)})
		if i < 20 && last.code == 429 {
			t.Fatalf("limited too early at %d", i)
		}
	}
	expect(t, "21st friend request in a row", last, 429)
}

func TestGroupCapAndAvatarCleanup(t *testing.T) {
	u := register(t, "manyg")
	var first string
	for i := 0; i < 100; i++ {
		r := paced(func() resp { return call(t, "POST", "/groups", u.token, map[string]string{"name": fmt.Sprintf("g%d", i)}) })
		if r.code != 201 {
			t.Fatalf("group %d: %d %s", i, r.code, r.raw)
		}
		if i == 0 {
			first = r.body["id"].(string)
		}
	}
	over := paced(func() resp { return call(t, "POST", "/groups", u.token, map[string]string{"name": "one too many"}) })
	if over.code != 429 || over.body["code"] != "quota" {
		t.Errorf("101st group: %d %s", over.code, over.raw)
	}

	// A group picture goes away with the account.
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("avatar", "a.png")
	fw.Write([]byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 64)))
	w.Close()
	time.Sleep(time.Second) // (the rate limit bucket is empty after 100 groups)
	r := rawCall(t, "POST", "/groups/"+first+"/avatar", map[string]string{"Authorization": "Bearer " + u.token}, &buf, w.FormDataContentType())
	expect(t, "group picture", r, 204)
	pic := filepath.Join(testDir, "group-avatars", first)
	if _, err := os.Stat(pic); err != nil {
		t.Fatalf("picture not stored: %v", err)
	}
	expect(t, "delete account", paced(func() resp {
		return call(t, "POST", "/users/me/delete", u.token, map[string]string{"password": u.pw})
	}), 204)
	if _, err := os.Stat(pic); !os.IsNotExist(err) {
		t.Errorf("group picture survived the account: %v", err)
	}
}
