package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestPollInterval(t *testing.T) {
	for in, want := range map[float64]time.Duration{
		0:    defaultPollEvery,
		2:    2 * time.Second,
		0.1:  minPollEvery,
		3600: maxPollEvery,
	} {
		if got := pollInterval(in); got != want {
			t.Errorf("pollInterval(%v) = %v, want %v", in, got, want)
		}
	}
}

// A fake Vercel server hands out one command; the agent should run it once,
// report the result, and keep polling.
func TestPollSessionRunsCommandOnce(t *testing.T) {
	const key = "0123456789abcdef0123456789abcdef"
	var mu sync.Mutex
	polls, results := 0, []map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/agent/poll":
			polls++
			// The same command twice: the agent must not run it again.
			w.Write([]byte(`{"command":{"id":"11111111-1111-1111-1111-111111111111","action":"launch_steam"},"pollSeconds":1}`))
		case "/api/agent/result":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			results = append(results, body)
		}
	}))
	defer srv.Close()

	c := &Client{cfg: Config{ServerURL: srv.URL, AgentKey: key}, afterReply: func(string) {}}
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	c.session(ctx)

	mu.Lock()
	defer mu.Unlock()
	if polls < 2 {
		t.Fatalf("polled %d times, want at least 2", polls)
	}
	if len(results) != 1 || results[0]["ok"] != true || results[0]["action"] != "launch_steam" {
		t.Fatalf("results = %v, want one ok launch_steam", results)
	}
}
