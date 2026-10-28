package main

import (
	"context"
	"encoding/json"
	"errors"
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

// A fake server hands out one command; the agent should run it once, report
// the result, echo fastUntil back, and keep polling.
func TestPollSessionRunsCommandOnce(t *testing.T) {
	var mu sync.Mutex
	polls, results, echoed := 0, []map[string]any{}, false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/api/agent/poll":
			polls++
			if body["fastUntil"] == float64(12345) {
				echoed = true
			}
			// The same command twice: the agent must not run it again.
			w.Write([]byte(`{"commands":[{"id":"11111111-1111-1111-1111-111111111111","action":"launch_steam"}],"pollSeconds":1,"fastUntil":12345}`))
		case "/api/agent/result":
			results = append(results, body)
		}
	}))
	defer srv.Close()

	c := &Client{cfg: Config{ServerURL: srv.URL, Token: testToken}, afterReply: func(string) {}}
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	c.session(ctx)

	mu.Lock()
	defer mu.Unlock()
	if polls < 2 || !echoed {
		t.Fatalf("polled %d times (echoed fastUntil: %v), want at least 2 with it echoed", polls, echoed)
	}
	if len(results) != 1 || results[0]["ok"] != true || results[0]["action"] != "launch_steam" {
		t.Fatalf("results = %v, want one ok launch_steam", results)
	}
}

// When the PC is removed from its account, Run gives up with errRemoved
// after hearing it twice, so the agent can uninstall itself.
func TestRunStopsWhenRemoved(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"ok":false,"error":"this PC was removed","code":"pc_removed"}`))
	}))
	defer srv.Close()
	c := &Client{cfg: Config{ServerURL: srv.URL, Token: testToken}, afterReply: func(string) {}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Run(ctx); !errors.Is(err, errRemoved) {
		t.Fatalf("Run = %v, want errRemoved", err)
	}
}

func TestPair(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["code"] != "K7P2XM9Q4T" {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"ok":false,"error":"that pairing code is wrong, used or expired"}`))
			return
		}
		w.Write([]byte(`{"ok":true,"token":"` + testToken + `"}`))
	}))
	defer srv.Close()

	cfg, err := pair(PairCode{Server: srv.URL, Code: "K7P2XM9Q4T"})
	if err != nil || cfg.Token != testToken || cfg.ServerURL != srv.URL {
		t.Fatalf("got %+v, %v", cfg, err)
	}
	if _, err := pair(PairCode{Server: srv.URL, Code: "WRONGWRONG"}); err == nil || err.Error() != "That pairing code is wrong, used or expired." {
		t.Fatalf("bad code: got %v", err)
	}
}
