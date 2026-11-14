package handlers

import (
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Long polling for the relay queue: GET /relay?wait=25 blocks (up to 25 s) until something
// arrives for the user. Calls use this for their signalling, the chat while it is open.
// In memory and per process; nothing is stored.
type relayHub struct {
	mu      sync.Mutex
	waiters map[string]map[chan struct{}]struct{}
}

var hub = &relayHub{waiters: map[string]map[chan struct{}]struct{}{}}

// maxWaitersPerUser bounds open long polls per account (a client keeps one at a time).
const maxWaitersPerUser = 4

func (h *relayHub) subscribe(user string) (chan struct{}, func(), bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.waiters[user]
	if set == nil {
		set = map[chan struct{}]struct{}{}
		h.waiters[user] = set
	}
	if len(set) >= maxWaitersPerUser {
		return nil, func() {}, false
	}
	ch := make(chan struct{}, 1)
	set[ch] = struct{}{}
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(set, ch)
		if len(set) == 0 {
			delete(h.waiters, user)
		}
	}, true
}

func (h *relayHub) notify(user string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.waiters[user] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func notifyRelay(_ *pgxpool.Pool, user string) {
	hub.notify(user)
}
