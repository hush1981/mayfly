package handlers

import (
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"

	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/push"
)

// Wake-ups are throttled per recipient: a push endpoint is a URL the account chose itself,
// so without a limit a few senders could make this server fire requests at a third party
// many times per second. One wake-up is enough anyway — the phone then fetches everything
// that is waiting. Burst 10, then one per second.
type wakeThrottle struct {
	mu   sync.Mutex
	m    map[string]*wakeEntry
	last time.Time // last sweep
}

type wakeEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

var wakes = &wakeThrottle{m: map[string]*wakeEntry{}}

func (w *wakeThrottle) allow(user string) bool {
	now := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()
	if now.Sub(w.last) > 5*time.Minute {
		for k, e := range w.m {
			if now.Sub(e.seen) > 5*time.Minute {
				delete(w.m, k)
			}
		}
		w.last = now
	}
	e := w.m[user]
	if e == nil {
		e = &wakeEntry{lim: rate.NewLimiter(1, 10)}
		w.m[user] = e
	}
	e.seen = now
	return e.lim.Allow()
}

// wakeUsers sends the content-free UnifiedPush wake-up to each user (in the background).
// The phone then syncs and decides itself what to show.
func wakeUsers(pool *pgxpool.Pool, userIDs ...string) {
	var todo []string
	for _, id := range userIDs {
		if wakes.allow(id) {
			todo = append(todo, id)
		}
	}
	if len(todo) == 0 {
		return
	}
	go func() {
		for _, id := range todo {
			ep, err := models.GetPushEndpoint(pool, id)
			if err != nil || ep == "" {
				continue
			}
			if gone, _ := push.Wake(ep); gone {
				models.ClearPushEndpointIf(pool, id, ep)
			}
		}
	}()
}
