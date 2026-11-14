//go:build integration

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/hush1981/mayfly/server/internal/handlers"
)

func rawCall(t *testing.T, method, path string, headers map[string]string, body io.Reader, contentType string) resp {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
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

func secret() (string, string) {
	b := make([]byte, 32)
	rand.Read(b)
	h := sha256.Sum256(b)
	return base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(h[:])
}

func sealedMedia(t *testing.T, token, unsendHash string) resp {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("media_type", "image")
	w.WriteField("sealed_header", b64(120))
	if unsendHash != "" {
		w.WriteField("unsend_hash", unsendHash)
	}
	fw, _ := w.CreateFormFile("encrypted_file", "media")
	fw.Write([]byte("sealed-ciphertext"))
	w.Close()
	return rawCall(t, "POST", "/sealed/media", map[string]string{"X-Delivery-Token": token}, &buf, w.FormDataContentType())
}

func TestSealedSender(t *testing.T) {
	alice, bob := register(t, "salice"), register(t, "sbob")
	befriend(t, alice, bob)
	tok, hash := secret()
	expect(t, "register token", call(t, "PUT", "/users/me/delivery-token", bob.token, map[string]string{"token_hash": hash}), 204)
	expect(t, "same token for someone else", call(t, "PUT", "/users/me/delivery-token", alice.token, map[string]string{"token_hash": hash}), 409)
	expect(t, "bad hash", call(t, "PUT", "/users/me/delivery-token", alice.token, map[string]string{"token_hash": "abc"}), 400)

	t.Run("relay without login, no sender stored", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"payload": b64(200), "notify": true})
		r := rawCall(t, "POST", "/sealed/relay", map[string]string{"X-Delivery-Token": tok}, bytes.NewReader(body), "application/json")
		expect(t, "sealed relay", r, 201)
		list := call(t, "GET", "/relay", bob.token, nil)
		var msgs []map[string]any
		json.Unmarshal(list.raw, &msgs)
		if len(msgs) != 1 || msgs[0]["sender_id"] != "" {
			t.Fatalf("want one sealed message without sender, got %s", list.raw)
		}
		call(t, "POST", "/relay/ack", bob.token, map[string]any{"ids": []string{msgs[0]["id"].(string)}})
		unknown, _ := secret()
		r = rawCall(t, "POST", "/sealed/relay", map[string]string{"X-Delivery-Token": unknown}, bytes.NewReader(body), "application/json")
		if r.code != 404 || r.body["code"] != "token" {
			t.Errorf("unknown token: %d %s", r.code, r.raw)
		}
		expect(t, "garbage token", rawCall(t, "POST", "/sealed/relay", map[string]string{"X-Delivery-Token": "x"}, bytes.NewReader(body), "application/json"), 400)
	})

	t.Run("media inbox carries the sealed header; unsend needs the secret", func(t *testing.T) {
		us, uh := secret()
		r := sealedMedia(t, tok, uh)
		expect(t, "sealed media", r, 201)
		id, _ := r.body["media_id"].(string)
		inbox := call(t, "GET", "/media/inbox", bob.token, nil)
		var items []map[string]any
		json.Unmarshal(inbox.raw, &items)
		found := false
		for _, it := range items {
			if it["id"] == id {
				found = true
				if it["sender_id"] != "" || it["sender_username"] != "" || it["sealed_header"] == nil {
					t.Errorf("sealed inbox item leaks or lacks fields: %v", it)
				}
			}
		}
		if !found {
			t.Fatalf("sealed moment not in inbox: %s", inbox.raw)
		}
		wrong, _ := secret()
		expect(t, "unsend wrong secret", rawCall(t, "DELETE", "/sealed/media/"+id, map[string]string{"X-Unsend-Token": wrong}, nil, ""), 204)
		expect(t, "still there", call(t, "GET", "/media/"+id, bob.token, nil), 200)
		expect(t, "unsend", rawCall(t, "DELETE", "/sealed/media/"+id, map[string]string{"X-Unsend-Token": us}, nil, ""), 204)
		expect(t, "gone", call(t, "GET", "/media/"+id, bob.token, nil), 404)
	})

	t.Run("rotating the token invalidates the old one", func(t *testing.T) {
		_, h2 := secret()
		call(t, "PUT", "/users/me/delivery-token", bob.token, map[string]string{"token_hash": h2})
		r := sealedMedia(t, tok, "")
		if r.code != 404 {
			t.Errorf("old token after rotation: %d", r.code)
		}
	})
}

func TestLongPollAndFriendRemoval(t *testing.T) {
	alice, bob := register(t, "lalice"), register(t, "lbob")
	befriend(t, alice, bob)
	done := make(chan resp, 1)
	start := time.Now()
	go func() { done <- call(t, "GET", "/relay?wait=10", bob.token, nil) }()
	time.Sleep(500 * time.Millisecond)
	expect(t, "relay", call(t, "POST", "/relay", alice.token, map[string]any{
		"recipient_id": bob.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(64),
	}), 201)
	select {
	case r := <-done:
		var msgs []map[string]any
		json.Unmarshal(r.raw, &msgs)
		if len(msgs) != 1 || time.Since(start) > 5*time.Second {
			t.Errorf("long poll: %d messages after %s", len(msgs), time.Since(start))
		}
	case <-time.After(12 * time.Second):
		t.Fatal("long poll did not return")
	}

	expect(t, "remove friend", call(t, "DELETE", "/friends/"+alice.id, bob.token, nil), 204)
	expect(t, "no longer friends", call(t, "POST", "/relay", alice.token, map[string]any{
		"recipient_id": bob.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(64),
	}), 403)
}

func TestICE(t *testing.T) {
	u := register(t, "ice")
	r := call(t, "GET", "/calls/ice", u.token, nil)
	if r.code != 200 || r.body["relay"] != false {
		t.Errorf("no TURN configured: %d %s", r.code, r.raw)
	}
	expect(t, "needs login", call(t, "GET", "/calls/ice", "", nil), 401)

	os.Setenv("TURN_URLS", "turn:turn.example:3478?transport=udp")
	os.Setenv("TURN_SECRET", "0123456789abcdef0123456789abcdef")
	h := handlers.NewCallsHandlerFromEnv()
	os.Unsetenv("TURN_URLS")
	os.Unsetenv("TURN_SECRET")
	if h == nil {
		t.Fatal("no handler")
	}
}

func TestLimits(t *testing.T) {
	r := call(t, "GET", "/limits", "", nil)
	if r.code != 200 || r.body["group_members"] != float64(64) || r.body["pending_moments_per_group"] != float64(200) ||
		r.body["story_mb"] != float64(300) || r.body["pending_moments_per_sender"] != float64(100) {
		t.Errorf("limits: %d %s", r.code, r.raw)
	}
}
