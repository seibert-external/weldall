package weldall

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// ReplayStore records one-time values (DPoP proof IDs, ID-JAG IDs, skills
// assertion IDs) until they expire. Consume must be atomic across every
// replica that serves the resource: it returns true on first use and false
// on a replay. A shared store (for example Redis SET NX with an expiry) is
// required when more than one replica runs.
type ReplayStore interface {
	Consume(ctx context.Context, key string, expiresAt time.Time) (bool, error)
}

type disabledReplayStore struct{}

func (disabledReplayStore) Consume(context.Context, string, time.Time) (bool, error) {
	return true, nil
}

// ReplayDisabled turns replay protection off. Proofs and assertions can then
// be replayed within their lifetime; skill publication refuses it.
var ReplayDisabled ReplayStore = disabledReplayStore{}

// InMemoryOptions configures InMemory.
type InMemoryOptions struct {
	MaxEntries      int // default 10000
	SuppressWarning bool
	Now             func() time.Time
}

var inMemoryWarning sync.Once

// InMemory returns a process-local ReplayStore. It is only safe for a single
// replica; it logs a one-time warning unless SuppressWarning is set. When it
// is full it fails closed: Consume returns an error and requests are refused.
func InMemory(options InMemoryOptions) (ReplayStore, error) {
	maxEntries := options.MaxEntries
	if maxEntries == 0 {
		maxEntries = 10_000
	}
	if maxEntries < 1 {
		return nil, configError("maxEntries must be a positive integer")
	}
	if !options.SuppressWarning {
		inMemoryWarning.Do(func() {
			slog.Warn("weldall: InMemory() replay protection is process-local and is not safe for horizontally scaled deployments")
		})
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &inMemoryReplayStore{maxEntries: maxEntries, now: now, values: map[string]time.Time{}}, nil
}

type inMemoryReplayStore struct {
	mu         sync.Mutex
	maxEntries int
	now        func() time.Time
	values     map[string]time.Time
}

func (s *inMemoryReplayStore) Consume(_ context.Context, key string, expiresAt time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for candidate, expiry := range s.values {
		if !expiry.After(now) {
			delete(s.values, candidate)
		}
	}
	if key == "" || !expiresAt.After(now) {
		return false, nil
	}
	if _, used := s.values[key]; used {
		return false, nil
	}
	if len(s.values) >= s.maxEntries {
		return false, errors.New("replay store capacity reached")
	}
	s.values[key] = expiresAt
	return true, nil
}

// consumeReplay records namespace:key, mapping a store failure to a 503 and a
// replay to replayErr marked with ReasonReplayDetected.
func consumeReplay(ctx context.Context, store ReplayStore, namespace, key string, expiresAt time.Time, replayErr *AuthError) error {
	if store == nil {
		return newAuthError("temporarily_unavailable", "replay protection unavailable", http.StatusServiceUnavailable)
	}
	if _, disabled := store.(disabledReplayStore); disabled {
		return nil
	}
	first, err := store.Consume(ctx, namespace+":"+key, expiresAt)
	if err != nil {
		return newAuthError("temporarily_unavailable", "replay protection unavailable", http.StatusServiceUnavailable)
	}
	if !first {
		replay := *replayErr
		replay.Reason = ReasonReplayDetected
		return &replay
	}
	return nil
}
