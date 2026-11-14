//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

func upload(t *testing.T, path string, from user, fields map[string]string, blob []byte) resp {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		w.WriteField(k, v)
	}
	fw, _ := w.CreateFormFile("encrypted_file", "media")
	fw.Write(blob)
	w.Close()
	req, _ := http.NewRequest("POST", srv.URL+path, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+from.token)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	out := resp{code: r.StatusCode, raw: raw, hdr: r.Header}
	json.Unmarshal(raw, &out.body)
	return out
}

func keysJSON(entries ...string) string {
	var ks []map[string]string
	for _, id := range entries {
		ks = append(ks, map[string]string{"viewer_id": id, "envelope": b64(120)})
	}
	j, _ := json.Marshal(ks)
	return string(j)
}

func TestStories(t *testing.T) {
	owner, friend, other, stranger := register(t, "sto"), register(t, "stf"), register(t, "sto2"), register(t, "sts")
	befriend(t, owner, friend)
	befriend(t, owner, other)

	expect(t, "story to a non-friend", upload(t, "/stories", owner,
		map[string]string{"media_type": "image", "keys": keysJSON(friend.id, stranger.id)}, []byte("blob")), 403)
	expect(t, "story to myself", upload(t, "/stories", owner,
		map[string]string{"media_type": "image", "keys": keysJSON(owner.id)}, []byte("blob")), 400)
	expect(t, "story without viewers", upload(t, "/stories", owner,
		map[string]string{"media_type": "image", "keys": "[]"}, []byte("blob")), 400)
	expect(t, "audio story", upload(t, "/stories", owner,
		map[string]string{"media_type": "audio", "keys": keysJSON(friend.id)}, []byte("blob")), 400)

	r := upload(t, "/stories", owner, map[string]string{"media_type": "image", "keys": keysJSON(friend.id)}, []byte("story-blob"))
	expect(t, "post story", r, 201)
	id, _ := r.body["id"].(string)

	var list struct {
		Friends []map[string]any `json:"friends"`
		Mine    []map[string]any `json:"mine"`
	}
	l := call(t, "GET", "/stories", friend.token, nil)
	json.Unmarshal(l.raw, &list)
	if len(list.Friends) != 1 || list.Friends[0]["id"] != id || list.Friends[0]["envelope"] == "" {
		t.Fatalf("friend should see the story with an envelope: %s", l.raw)
	}
	if _, leaked := list.Friends[0]["storage_path"]; leaked {
		t.Error("storage_path leaked")
	}
	l = call(t, "GET", "/stories", other.token, nil)
	list.Friends = nil
	json.Unmarshal(l.raw, &list)
	if len(list.Friends) != 0 {
		t.Errorf("a friend that was not picked must not see the story: %s", l.raw)
	}
	l = call(t, "GET", "/stories", owner.token, nil)
	json.Unmarshal(l.raw, &list)
	if len(list.Mine) != 1 || list.Mine[0]["audience"].(float64) != 1 {
		t.Errorf("own stories: %s", l.raw)
	}

	d := call(t, "GET", "/stories/"+id, friend.token, nil)
	if d.code != 200 || string(d.raw) != "story-blob" {
		t.Errorf("viewer download: %d %s", d.code, d.raw)
	}
	expect(t, "download twice is fine", call(t, "GET", "/stories/"+id, friend.token, nil), 200)
	expect(t, "unpicked friend download", call(t, "GET", "/stories/"+id, other.token, nil), 404)
	expect(t, "stranger download", call(t, "GET", "/stories/"+id, stranger.token, nil), 404)
	expect(t, "owner download", call(t, "GET", "/stories/"+id, owner.token, nil), 200)
	expect(t, "foreign delete", call(t, "DELETE", "/stories/"+id, friend.token, nil), 404)

	// blocking cuts access immediately
	expect(t, "block", call(t, "POST", "/blocks", friend.token, map[string]string{"user_id": owner.id}), 204)
	expect(t, "download after block", call(t, "GET", "/stories/"+id, friend.token, nil), 404)

	expect(t, "owner deletes", call(t, "DELETE", "/stories/"+id, owner.token, nil), 204)
	expect(t, "gone", call(t, "GET", "/stories/"+id, owner.token, nil), 404)
}

func TestGroupChats(t *testing.T) {
	a, b, c, x := register(t, "gca"), register(t, "gcb"), register(t, "gcc"), register(t, "gcx")
	befriend(t, a, b)
	befriend(t, b, c) // c is not a friend of a

	g := call(t, "POST", "/groups", a.token, map[string]string{"name": "Chat", "kind": "chat"})
	expect(t, "create chat", g, 201)
	gid := g.body["id"].(string)
	expect(t, "bad kind", call(t, "POST", "/groups", a.token, map[string]string{"name": "X", "kind": "foo"}), 400)

	expect(t, "invite non-friend", call(t, "POST", "/groups/"+gid+"/members", a.token, map[string]string{"user_id": c.id}), 403)
	expect(t, "invite friend", call(t, "POST", "/groups/"+gid+"/members", a.token, map[string]string{"user_id": b.id}), 204)
	expect(t, "invite twice", call(t, "POST", "/groups/"+gid+"/members", a.token, map[string]string{"user_id": b.id}), 409)

	// invited is not a member yet
	expect(t, "invited cannot rename", call(t, "PUT", "/groups/"+gid, b.token, map[string]string{"name": "Mine"}), 403)
	expect(t, "invited may look at members", call(t, "GET", "/groups/"+gid+"/members", b.token, nil), 200)
	expect(t, "invited cannot invite", call(t, "POST", "/groups/"+gid+"/members", b.token, map[string]string{"user_id": c.id}), 403)
	m := upload(t, "/groups/"+gid+"/media", a, map[string]string{"media_type": "image"}, []byte("x"))
	expect(t, "media while alone", m, 201)
	if m.body["recipients"].(float64) != 0 {
		t.Errorf("invited user must not get media: %s", m.raw)
	}
	expect(t, "outsider cannot join", call(t, "POST", "/groups/"+gid+"/join", x.token, nil), 404)
	expect(t, "accept", call(t, "POST", "/groups/"+gid+"/join", b.token, nil), 204)

	// any member can rename and invite their own friends
	expect(t, "member renames", call(t, "PUT", "/groups/"+gid, b.token, map[string]string{"name": "Ours"}), 204)
	expect(t, "member invites own friend", call(t, "POST", "/groups/"+gid+"/members", b.token, map[string]string{"user_id": c.id}), 204)
	expect(t, "c joins", call(t, "POST", "/groups/"+gid+"/join", c.token, nil), 204)

	// a and c are not friends, but share the chat: relay works
	expect(t, "relay between co-members", call(t, "POST", "/relay", a.token, map[string]any{
		"recipient_id": c.id, "ephemeral_public_key": b64(32), "nonce": b64(24), "payload": b64(64)}), 201)

	m = upload(t, "/groups/"+gid+"/media", a, map[string]string{"media_type": "video"}, []byte("group-blob"))
	expect(t, "group media", m, 201)
	mid := m.body["media_id"].(string)
	if m.body["recipients"].(float64) != 2 {
		t.Errorf("two recipients expected: %s", m.raw)
	}
	expect(t, "outsider download", call(t, "GET", "/group-media/"+mid, x.token, nil), 404)
	d := call(t, "GET", "/group-media/"+mid, b.token, nil)
	if d.code != 200 || string(d.raw) != "group-blob" {
		t.Errorf("member download: %d %s", d.code, d.raw)
	}
	expect(t, "b viewed", call(t, "POST", "/group-media/"+mid+"/viewed", b.token, nil), 204)
	expect(t, "b cannot download again", call(t, "GET", "/group-media/"+mid, b.token, nil), 404)
	expect(t, "c still can", call(t, "GET", "/group-media/"+mid, c.token, nil), 200)
	expect(t, "c viewed", call(t, "POST", "/group-media/"+mid+"/viewed", c.token, nil), 204)
	expect(t, "gone after everyone", call(t, "GET", "/group-media/"+mid, c.token, nil), 404)

	// group picture by a non-owner member is allowed in chats
	var groups []map[string]any
	gl := call(t, "GET", "/groups", b.token, nil)
	json.Unmarshal(gl.raw, &groups)
	found := false
	for _, x := range groups {
		if x["id"] == gid {
			found = true
			if x["kind"] != "chat" || x["my_status"] != "member" || x["name"] != "Ours" {
				t.Errorf("group listing: %v", x)
			}
		}
	}
	if !found {
		t.Error("chat missing in b's list")
	}

	// owner leaves → ownership moves on, chat stays
	expect(t, "owner leaves", call(t, "DELETE", "/groups/"+gid+"/members/"+a.id, a.token, nil), 204)
	expect(t, "b renames after owner left", call(t, "PUT", "/groups/"+gid, b.token, map[string]string{"name": "Still"}), 204)
	expect(t, "a is out", call(t, "PUT", "/groups/"+gid, a.token, map[string]string{"name": "Back"}), 403)
	expect(t, "new owner deletes", call(t, "DELETE", "/groups/"+gid, b.token, nil), 204)
	expect(t, "deleted", call(t, "GET", "/groups/"+gid+"/members", c.token, nil), 403)
}

func TestBroadcastListDelete(t *testing.T) {
	a, b := register(t, "bla"), register(t, "blb")
	befriend(t, a, b)
	g := call(t, "POST", "/groups", a.token, map[string]string{"name": "List"})
	expect(t, "create list (old client, no kind)", g, 201)
	gid := g.body["id"].(string)
	if g.body["kind"] != "list" {
		t.Errorf("default kind: %s", g.raw)
	}
	expect(t, "owner adds directly", call(t, "POST", "/groups/"+gid+"/members", a.token, map[string]string{"user_id": b.id}), 204)
	expect(t, "member cannot rename a list", call(t, "PUT", "/groups/"+gid, b.token, map[string]string{"name": "X"}), 403)
	expect(t, "member cannot delete", call(t, "DELETE", "/groups/"+gid, b.token, nil), 403)
	expect(t, "list media endpoint refused", upload(t, "/groups/"+gid+"/media", a, map[string]string{"media_type": "image"}, []byte("x")), 400)
	expect(t, "owner deletes", call(t, "DELETE", "/groups/"+gid, a.token, nil), 204)
	expect(t, "gone", call(t, "GET", "/groups/"+gid+"/members", a.token, nil), 403)
}
