package main

// The agent asks the server's /api/agent/poll for work: every 60 s while
// nobody is looking, and every 2 s while the app is open (the server says
// which). Between polls it uses no network at all.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	steamPollEvery   = 5 * time.Second
	defaultPollEvery = 60 * time.Second
	minPollEvery     = 1 * time.Second
	maxPollEvery     = 120 * time.Second
	requestTimeout   = 15 * time.Second
	minBackoff       = 2 * time.Second
	maxBackoff       = 60 * time.Second
)

// errNetworkDown means the server's name doesn't resolve yet, which is what
// the first minute after a restart looks like. It's retried quickly without
// growing the backoff.
var errNetworkDown = errors.New("network not ready")

// errRemoved means the server no longer knows this PC: it was removed from
// its HomeyDeck account. It's only believed after removedAfter answers in a row.
var errRemoved = errors.New("this PC was removed from its HomeyDeck account")

const removedAfter = 2

type Client struct {
	cfg  Config
	http *http.Client

	// commands that power the PC down run after the reply has been sent
	afterReply func(action string)
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, afterReply: runDeferredAction}
}

// Run polls until ctx is cancelled, backing off while the server can't be
// reached. It returns errRemoved if the PC was removed from its account.
func (c *Client) Run(ctx context.Context) error {
	backoff := minBackoff
	quiet := false // already logged that the network is down
	removed := 0
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, errRemoved) {
			if removed++; removed >= removedAfter {
				return err
			}
		} else {
			removed = 0
		}
		if time.Since(started) > time.Minute {
			backoff = minBackoff // it was working for a while, retry quickly
		}
		wait := backoff
		if errors.Is(err, errNetworkDown) {
			wait = minBackoff
			if !quiet {
				log.Printf("%v (checking every %s)", err, wait)
			}
			quiet = true
		} else {
			// Jitter keeps a flapping network from producing a perfectly regular storm.
			wait += time.Duration(rand.Int64N(int64(backoff / 2)))
			backoff = min(backoff*2, maxBackoff)
			quiet = false
			log.Printf("lost the server: %v (retrying in %s)", err, wait.Round(time.Second))
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	return ctx.Err()
}

type statusMsg struct {
	Hostname      string `json:"hostname"`
	SteamRunning  bool   `json:"steamRunning"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	AgentVersion  string `json:"agentVersion"`
	FastUntil     int64  `json:"fastUntil,omitempty"`
}

type resultMsg struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

type pollReply struct {
	Commands []struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	} `json:"commands"`
	PollSeconds float64 `json:"pollSeconds"`
	// The server's time until which it wants fast polling. The agent sends it
	// back with the next poll, which lets the server keep each poll to one
	// database command.
	FastUntil int64 `json:"fastUntil"`
}

// session polls until a request fails.
func (c *Client) session(ctx context.Context) error {
	if err := c.networkReady(ctx); err != nil {
		return err
	}
	log.Printf("polling %s", c.cfg.ServerURL)
	hostname, _ := os.Hostname()
	steam := steamRunning()
	var fastUntil int64
	done := map[string]bool{} // command IDs already carried out

	timer := time.NewTimer(0) // first poll right away
	defer timer.Stop()
	steamTick := time.NewTicker(steamPollEvery)
	defer steamTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-steamTick.C:
			// Report a Steam change right away instead of at the next poll.
			if now := steamRunning(); now != steam {
				steam = now
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(0)
			}
			continue
		case <-timer.C:
		}

		var reply pollReply
		err := c.post(ctx, "/api/agent/poll", statusMsg{
			Hostname:      hostname,
			SteamRunning:  steam,
			UptimeSeconds: int64(uptime().Seconds()),
			AgentVersion:  version,
			FastUntil:     fastUntil,
		}, &reply)
		if err != nil {
			return err
		}
		fastUntil = reply.FastUntil

		for _, cmd := range reply.Commands {
			if done[cmd.ID] {
				continue
			}
			if len(done) > 100 {
				clear(done)
			}
			done[cmd.ID] = true
			log.Printf("command %s", cmd.Action)
			res := resultMsg{ID: cmd.ID, Action: cmd.Action, OK: true}
			if err := runAction(cmd.Action); err != nil {
				res.OK, res.Error = false, err.Error()
				log.Printf("command %s failed: %v", cmd.Action, err)
			}
			if err := c.post(ctx, "/api/agent/result", res, nil); err != nil {
				return err
			}
			if res.OK {
				c.afterReply(cmd.Action)
			}
			steam = steamRunning()
		}
		timer.Reset(pollInterval(reply.PollSeconds))
	}
}

func pollInterval(seconds float64) time.Duration {
	if seconds <= 0 {
		return defaultPollEvery
	}
	return min(max(time.Duration(seconds*float64(time.Second)), minPollEvery), maxPollEvery)
}

// networkReady checks that the server's name resolves.
func (c *Client) networkReady(ctx context.Context) error {
	u, err := url.Parse(c.cfg.ServerURL)
	if err != nil || u.Hostname() == "" || isLocalhost(u.Hostname()) {
		return nil
	}
	lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := net.DefaultResolver.LookupHost(lctx, u.Hostname()); err != nil {
		return fmt.Errorf("%w: %v", errNetworkDown, err)
	}
	return nil
}

// One client reused across polls, so the TLS connection stays open between
// fast polls. Idle connections are dropped after 30 s, so a connection that
// went stale while the PC slept is never reused.
func (c *Client) httpClient() *http.Client {
	if c.http == nil {
		c.http = &http.Client{Timeout: requestTimeout, Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
			IdleConnTimeout:     30 * time.Second,
			MaxIdleConns:        2,
		}}
	}
	return c.http
}

func (c *Client) post(ctx context.Context, path string, body any, out any) error {
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.ServerURL+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		c.httpClient().CloseIdleConnections()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
		if json.Unmarshal(raw, &e) != nil || e.Error == "" {
			e.Error = string(bytes.TrimSpace(raw))
		}
		if resp.StatusCode == http.StatusUnauthorized && e.Code == "pc_removed" {
			return errRemoved
		}
		return &serverError{status: resp.StatusCode, msg: e.Error}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16<<10))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(out)
}

type serverError struct {
	status int
	msg    string
}

func (e *serverError) Error() string {
	return fmt.Sprintf("server answered %d: %s", e.status, e.msg)
}

// pair trades a one-time pairing code for this PC's token.
func pair(code PairCode) (Config, error) {
	c := NewClient(Config{ServerURL: code.Server})
	hostname, _ := os.Hostname()
	var reply struct {
		Token string `json:"token"`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := c.post(ctx, "/api/agent/pair", map[string]string{"code": code.Code, "hostname": hostname}, &reply)
	var se *serverError
	if errors.As(err, &se) {
		return Config{}, errors.New(sentence(se.msg)) // the server's message is written for people
	}
	if err != nil {
		return Config{}, fmt.Errorf("couldn't reach %s: %w", code.host(), err)
	}
	cfg := Config{ServerURL: code.Server, Token: reply.Token}
	return cfg, validateConfig(cfg)
}

func sentence(s string) string {
	if s == "" {
		return s
	}
	s = strings.ToUpper(s[:1]) + s[1:]
	if !strings.HasSuffix(s, ".") {
		s += "."
	}
	return s
}

// runAction does the part of a command that must succeed before we answer.
// Sleep happens afterwards (see runDeferredAction) so the reply gets out first.
func runAction(action string) error {
	switch action {
	case "launch_steam":
		if steamRunning() {
			return nil
		}
		return launchSteam()
	case "reboot":
		return reboot() // Windows waits a few seconds before restarting
	case "sleep":
		return canSleep()
	default:
		return errors.New("unknown action")
	}
}

func runDeferredAction(action string) {
	if action != "sleep" {
		return
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		if err := sleepNow(); err != nil {
			log.Printf("sleep failed: %v", err)
		}
	}()
}
