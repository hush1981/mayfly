package handlers

import (
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

func RunCleanup(pool *pgxpool.Pool, store storage.Storage) {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	cleanupExpired(pool, store)
	for range ticker.C {
		cleanupExpired(pool, store)
	}
}

func cleanupExpired(pool *pgxpool.Pool, store storage.Storage) {
	expired, err := models.GetExpiredUnviewed(pool)
	if err != nil {
		log.Printf("cleanup: query expired media: %v", err)
		return
	}

	// Opened moments whose row or file survived a failed delete are removed as well.
	if left, err := models.GetViewedLeftovers(pool); err == nil {
		expired = append(expired, left...)
	}

	for _, e := range expired {
		// Delete file first; if this fails, skip DB delete so we retry on the next run
		if err := store.Delete(e.StoragePath); err != nil {
			log.Printf("cleanup: delete media file: %v", err)
			continue
		}
		if err := models.DeleteMediaByID(pool, e.ID); err != nil {
			log.Printf("cleanup: delete media row: %v", err)
		}
	}

	if len(expired) > 0 {
		log.Printf("cleanup: purged %d expired media items", len(expired))
	}

	if ids, err := models.ExpiredStoryIDs(pool); err != nil {
		log.Printf("cleanup: query expired stories: %v", err)
	} else {
		purged := 0
		for _, id := range ids {
			if err := store.Delete(id); err != nil {
				log.Printf("cleanup: delete story file: %v", err)
				continue
			}
			if err := models.DeleteStoryByID(pool, id); err != nil {
				log.Printf("cleanup: delete story row: %v", err)
				continue
			}
			purged++
		}
		if purged > 0 {
			log.Printf("cleanup: purged %d expired stories", purged)
		}
	}

	if ids, err := models.FinishedGroupMediaIDs(pool); err != nil {
		log.Printf("cleanup: query group media: %v", err)
	} else {
		purged := 0
		for _, id := range ids {
			if err := store.Delete(id); err != nil {
				log.Printf("cleanup: delete group media file: %v", err)
				continue
			}
			if err := models.DeleteGroupMediaByID(pool, id); err == nil {
				purged++
			}
		}
		if purged > 0 {
			log.Printf("cleanup: purged %d group media items", purged)
		}
	}

	if n, err := models.PurgeOldRelayMessages(pool); err != nil {
		log.Printf("cleanup: purge relay messages: %v", err)
	} else if n > 0 {
		log.Printf("cleanup: purged %d undelivered relay messages", n)
	}
}
