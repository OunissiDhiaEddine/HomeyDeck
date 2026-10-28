// HomeyDeck agent: a tiny background program for the Windows PC.
//
// It keeps one outbound WebSocket to the HomeyDeck server, reports whether
// Steam is running, and carries out launch_steam / sleep / reboot commands.
//
// Usage:
//
//	homeydeck-agent.exe install --server https://homeydeck.example.workers.dev --key <AGENT_KEY>
//	homeydeck-agent.exe uninstall
//	homeydeck-agent.exe status
//	homeydeck-agent.exe            (runs the agent; this is what starts at logon)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

// Set at build time with -ldflags "-X main.version=..."
var version = "dev"

type Config struct {
	ServerURL string `json:"server_url"`
	AgentKey  string `json:"agent_key"`
}

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "":
		run()
	case "install":
		attachConsole()
		exitOn(install(os.Args[2:]))
	case "uninstall":
		attachConsole()
		exitOn(uninstall())
	case "status":
		attachConsole()
		exitOn(printStatus())
	case "version", "--version", "-v":
		attachConsole()
		fmt.Println("homeydeck-agent", version)
	default:
		attachConsole()
		fmt.Fprintf(os.Stderr, "unknown command %q (expected install, uninstall, status or version)\n", cmd)
		os.Exit(2)
	}
}

func run() {
	logFile := openLog()
	defer logFile.Close()

	release, err := singleInstance()
	if err != nil {
		log.Printf("not starting: %v", err)
		return
	}
	defer release()

	cfg, err := loadConfig()
	if err != nil {
		log.Printf("not starting: %v (run `homeydeck-agent install` first)", err)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("homeydeck-agent %s starting, server %s", version, cfg.ServerURL)
	NewClient(cfg).Run(ctx)
	log.Printf("stopped")
}

// --- config ------------------------------------------------------------------

func configPath() string { return filepath.Join(dataDir(), "config.json") }

func loadConfig() (Config, error) {
	var cfg Config
	raw, err := os.ReadFile(configPath())
	if err != nil {
		return cfg, fmt.Errorf("reading config: %w", err)
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("parsing %s: %w", configPath(), err)
	}
	return cfg, validateConfig(cfg)
}

func validateConfig(cfg Config) error {
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || u.Host == "" {
		return errors.New("server URL is not valid")
	}
	if u.Scheme != "https" && !isLocalhost(u.Hostname()) {
		return errors.New("server URL must start with https:// (plain http is only allowed for localhost)")
	}
	if len(cfg.AgentKey) < 32 {
		return errors.New("agent key must be at least 32 characters")
	}
	return nil
}

func isLocalhost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func saveConfig(cfg Config) error {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(configPath(), raw, 0o600)
}

// --- commands ----------------------------------------------------------------

func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	server := fs.String("server", "", "HomeyDeck server URL, e.g. https://homeydeck.you.workers.dev")
	key := fs.String("key", "", "the AGENT_KEY you set on the server")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg := Config{ServerURL: strings.TrimRight(*server, "/"), AgentKey: *key}
	if cfg.ServerURL == "" && cfg.AgentKey == "" {
		// Re-installing (e.g. after an update) keeps the existing config.
		existing, err := loadConfig()
		if err != nil {
			return errors.New("pass --server and --key")
		}
		cfg = existing
	}
	if err := validateConfig(cfg); err != nil {
		return err
	}
	if err := saveConfig(cfg); err != nil {
		return fmt.Errorf("saving config: %w", err)
	}

	exe, err := installBinary()
	if err != nil {
		return fmt.Errorf("copying agent: %w", err)
	}
	if err := enableAutostart(exe); err != nil {
		return fmt.Errorf("enabling start at logon: %w", err)
	}
	if err := startDetached(exe); err != nil {
		return fmt.Errorf("starting agent: %w", err)
	}

	fmt.Println("HomeyDeck agent installed.")
	fmt.Println("  program:", exe)
	fmt.Println("  config: ", configPath())
	fmt.Println("  log:    ", logPath())
	fmt.Println("It is running now and will start hidden every time you sign in.")
	return nil
}

func uninstall() error {
	if err := disableAutostart(); err != nil {
		return fmt.Errorf("removing start at logon: %w", err)
	}
	stopOtherInstances()
	fmt.Println("HomeyDeck agent removed from startup and stopped.")
	fmt.Println("Your config is kept in", dataDir(), "- delete that folder to remove everything.")
	return nil
}

func printStatus() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	fmt.Println("server:        ", cfg.ServerURL)
	fmt.Println("steam running: ", steamRunning())
	fmt.Println("start at logon:", autostartEnabled())
	fmt.Println("log file:      ", logPath())
	return nil
}

// --- logging -----------------------------------------------------------------

const maxLogBytes = 1 << 20

func logPath() string { return filepath.Join(dataDir(), "agent.log") }

// openLog sends the standard logger to a small file, starting over once it
// grows past 1 MB so it can never fill the disk.
func openLog() io.Closer {
	_ = os.MkdirAll(dataDir(), 0o700)
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if info, err := os.Stat(logPath()); err == nil && info.Size() > maxLogBytes {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(logPath(), flags, 0o600)
	if err != nil {
		log.SetOutput(io.Discard)
		return io.NopCloser(nil)
	}
	log.SetOutput(f)
	return f
}

func exitOn(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
