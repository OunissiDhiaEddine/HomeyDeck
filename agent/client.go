package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	statusEvery    = 20 * time.Second // keep in step with STALE_AFTER_MS on the server
	steamPollEvery = 5 * time.Second
	pingEvery      = 30 * time.Second
	pingTimeout    = 10 * time.Second
	minBackoff     = 2 * time.Second
	maxBackoff     = 60 * time.Second
)

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
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = minBackoff // it was a healthy connection, retry quickly
		}
		log.Printf("disconnected: %v (retrying in %s)", err, backoff.Round(time.Second))

		// Jitter keeps a flapping network from producing a perfectly regular storm.
		wait := backoff + time.Duration(rand.Int64N(int64(backoff/2)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff = min(backoff*2, maxBackoff)
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
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	defer cancelDial()
	conn, resp, err := websocket.Dial(dialCtx, c.wsURL(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + c.cfg.AgentKey}},
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return errors.New("server rejected the agent key (check AGENT_KEY)")
		}
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
