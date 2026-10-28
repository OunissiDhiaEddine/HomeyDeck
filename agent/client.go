package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	statusEvery    = 20 * time.Second // keep in step with STALE_AFTER_MS on the server
	steamPollEvery = 5 * time.Second
	pingEvery      = 30 * time.Second
	pingTimeout    = 10 * time.Second
	dialTimeout    = 15 * time.Second
	minBackoff     = 2 * time.Second
	maxBackoff     = 30 * time.Second
)

// errNetworkDown means the server's name doesn't resolve yet, which is what
// the first minute after a restart looks like. It's retried quickly without
// growing the backoff.
var errNetworkDown = errors.New("network not ready")

type Client struct {
	cfg Config

	// commands that power the PC down run after the reply has been sent
	afterReply func(action string)
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, afterReply: runDeferredAction}
}

// Run connects and reconnects until ctx is cancelled.
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
			backoff = minBackoff // it was a healthy connection, retry quickly
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
			log.Printf("disconnected: %v (retrying in %s)", err, wait.Round(time.Second))
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (c *Client) wsURL() string {
	u := c.cfg.ServerURL
	u = strings.Replace(u, "https://", "wss://", 1)
	u = strings.Replace(u, "http://", "ws://", 1)
	return u + "/agent/connect"
}

type inbound struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Action string `json:"action"`
}

type statusMsg struct {
	Type          string `json:"type"`
	Hostname      string `json:"hostname"`
	SteamRunning  bool   `json:"steamRunning"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	AgentVersion  string `json:"agentVersion"`
}

type resultMsg struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func (c *Client) session(ctx context.Context) error {
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(16 << 10)
	log.Printf("connected")

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var writeMu sync.Mutex
	send := func(v any) error {
		raw, _ := json.Marshal(v)
		writeMu.Lock()
		defer writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
		defer wcancel()
		return conn.Write(wctx, websocket.MessageText, raw)
	}

	hostname, _ := os.Hostname()
	steam := steamRunning()
	sendStatus := func() error {
		return send(statusMsg{
			Type:          "status",
			Hostname:      hostname,
			SteamRunning:  steam,
			UptimeSeconds: int64(uptime().Seconds()),
			AgentVersion:  version,
		})
	}
	if err := sendStatus(); err != nil {
		return err
	}

	errc := make(chan error, 2)

	// Writer: periodic status, immediate status when Steam starts or stops, pings.
	go func() {
		statusTick := time.NewTicker(statusEvery)
		steamTick := time.NewTicker(steamPollEvery)
		pingTick := time.NewTicker(pingEvery)
		defer statusTick.Stop()
		defer steamTick.Stop()
		defer pingTick.Stop()
		lastTick := time.Now().Round(0) // wall clock, so time spent asleep counts
		for {
			var err error
			select {
			case <-ctx.Done():
				return
			case <-statusTick.C:
				err = sendStatus()
			case <-steamTick.C:
				// A long gap between ticks means Windows was asleep. The old
				// socket is almost certainly dead, so reconnect right away
				// instead of waiting for a ping to time out.
				gap := time.Since(lastTick)
				lastTick = time.Now().Round(0)
				if gap > 3*steamPollEvery {
					err = errors.New("resumed from sleep")
					break
				}
				if now := steamRunning(); now != steam {
					steam = now
					err = sendStatus()
				}
			case <-pingTick.C:
				pctx, pcancel := context.WithTimeout(ctx, pingTimeout)
				err = conn.Ping(pctx)
				pcancel()
			}
			if err != nil {
				errc <- err
				return
			}
		}
	}()

	// Reader: commands from the server.
	go func() {
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				errc <- err
				return
			}
			var msg inbound
			if json.Unmarshal(raw, &msg) != nil || msg.Type != "command" {
				continue
			}
			log.Printf("command %s", msg.Action)
			res := resultMsg{Type: "result", ID: msg.ID, OK: true}
			if err := runAction(msg.Action); err != nil {
				res.OK, res.Error = false, err.Error()
				log.Printf("command %s failed: %v", msg.Action, err)
			}
			if err := send(res); err != nil {
				errc <- err
				return
			}
			if res.OK {
				c.afterReply(msg.Action)
			}
		}
	}()

	err = <-errc
	return err
}

// dial opens the WebSocket on a fresh connection every time, so nothing from
// a previous attempt (a half-open socket from before a restart or sleep, a
// stale pooled connection) can be reused. On failure it says which step got
// stuck, which tells a DNS, firewall or server problem apart.
func (c *Client) dial(ctx context.Context) (*websocket.Conn, error) {
	host := ""
	if u, err := url.Parse(c.cfg.ServerURL); err == nil {
		host = u.Hostname()
	}
	if host != "" && !isLocalhost(host) {
		lctx, lcancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := net.DefaultResolver.LookupHost(lctx, host)
		lcancel()
		if err != nil {
			return nil, fmt.Errorf("%w: %v", errNetworkDown, err)
		}
	}

	var step atomic.Value
	step.Store("starting")
	trace := &httptrace.ClientTrace{
		DNSStart:          func(httptrace.DNSStartInfo) { step.Store("resolving the server name") },
		ConnectStart:      func(_, addr string) { step.Store("connecting to " + addr) },
		TLSHandshakeStart: func() { step.Store("TLS handshake") },
		WroteRequest:      func(httptrace.WroteRequestInfo) { step.Store("waiting for the server to answer") },
	}

	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		TLSClientConfig:     &tls.Config{NextProtos: []string{"http/1.1"}},
	}
	defer transport.CloseIdleConnections()

	dctx, cancel := context.WithTimeout(httptrace.WithClientTrace(ctx, trace), dialTimeout)
	defer cancel()
	conn, resp, err := websocket.Dial(dctx, c.wsURL(), &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: transport},
		HTTPHeader: http.Header{"Authorization": {"Bearer " + c.cfg.AgentKey}},
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return nil, errors.New("server rejected the agent key (check AGENT_KEY)")
		}
		if resp != nil {
			return nil, fmt.Errorf("server answered %s", resp.Status)
		}
		return nil, fmt.Errorf("%v (stuck at: %s)", err, step.Load())
	}
	return conn, nil
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
