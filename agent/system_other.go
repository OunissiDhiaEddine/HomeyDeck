//go:build !windows

// Stand-ins so the agent can be run and tested on macOS/Linux during
// development. Power actions are only logged, never performed.
package main

import (
	"log"
	"os"
	"path/filepath"
	"time"
)

var started = time.Now()

func dataDir() string {
	if d := os.Getenv("HOMEYDECK_DATA_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "HomeyDeck")
}

func attachConsole()                  {}
func singleInstance() (func(), error) { return func() {}, nil }
func uptime() time.Duration           { return time.Since(started) }
func steamRunning() bool              { return os.Getenv("HOMEYDECK_FAKE_STEAM") == "1" }
func launchSteam() error              { log.Printf("[dev] would launch Steam"); return nil }
func canSleep() error                 { return nil }
func sleepNow() error                 { log.Printf("[dev] would sleep"); return nil }
func reboot() error                   { log.Printf("[dev] would reboot"); return nil }
func installBinary() (string, error)  { return os.Executable() }
func enableAutostart(string) error    { return nil }
func disableAutostart() error         { return nil }
func autostartEnabled() bool          { return false }
func startDetached(string) error      { return nil }
func stopOtherInstances()             {}
