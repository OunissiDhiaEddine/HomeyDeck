package main

// The agent asks the server's /api/agent/poll for work: every 20 s while
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
	"time"
)

const (
	steamPollEvery   = 5 * time.Second
	defaultPollEvery = 20 * time.Second
	minPollEvery     = 1 * time.Second
	maxPollEvery     = 60 * time.Second
	requestTimeout   = 15 * time.Second
	minBackoff       = 2 * time.Second
	maxBackoff       = 60 * time.Second
)

// errNetworkDown means the server's name doesn't resolve yet, which is what
// the first minute after a restart looks like. It's retried quickly without
// growing the backoff.
var errNetworkDown = errors.New("network not ready")

type Client struct {
	cfg  Config
	http *http.Client

	// commands that power the PC down run after the reply has been sent
	afterReply func(action string)
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, afterReply: runDeferredAction}
}

// Run polls until ctx is cancelled, backing off while the server can't be reached.
func (c *Client) Run(ctx context.Context) {
	backoff := minBackoff
	quiet := false // already logged that the network is down
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
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
			return
		case <-time.After(wait):
		}
	}
}

type statusMsg struct {
	Hostname      string `json:"hostname"`
	SteamRunning  bool   `json:"steamRunning"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	AgentVersion  string `json:"agentVersion"`
}

type resultMsg struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

type pollReply struct {
	Command *struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	} `json:"command"`
	PollSeconds float64 `json:"pollSeconds"`
}

// session polls until a request fails.
func (c *Client) session(ctx context.Context) error {
	if err := c.networkReady(ctx); err != nil {
		return err
	}
	log.Printf("polling %s", c.cfg.ServerURL)
	hostname, _ := os.Hostname()
	steam := steamRunning()
	lastID := ""

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
		}, &reply)
		if err != nil {
			return err
		}

		if cmd := reply.Command; cmd != nil && cmd.ID != lastID {
			lastID = cmd.ID
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
	req.Header.Set("Authorization", "Bearer "+c.cfg.AgentKey)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		c.httpClient().CloseIdleConnections()
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return errors.New("server rejected the agent key (copy a new setup code and install again)")
	case resp.StatusCode != http.StatusOK:
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("server answered %s: %s", resp.Status, bytes.TrimSpace(msg))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16<<10))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(out)
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
