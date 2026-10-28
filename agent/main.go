// HomeyDeck agent: a tiny background program for the Windows PC.
//
// It polls the HomeyDeck server over HTTPS, reports whether Steam is
// running, and carries out launch_steam / sleep / reboot commands.
//
// Installing needs no terminal: copy the setup code from the HomeyDeck app
// (Settings → Set up this PC), then double-click homeydeck-agent.exe.
// Double-clicking it again, or removing "HomeyDeck agent" in Windows
// Settings → Apps, uninstalls it and deletes everything it saved.
//
// The same things work from a terminal:
//
//	homeydeck-agent.exe install [--server https://you.vercel.app --key <AGENT_KEY>]
//	homeydeck-agent.exe uninstall
//	homeydeck-agent.exe status
//	homeydeck-agent.exe run       (what starts hidden at sign-in)
package main

import (
	"context"
	"encoding/base64"
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

const appName = "HomeyDeck"

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
		interactive()
	case "run":
		run()
	case "install":
		attachConsole()
		exitOn(installFromArgs(os.Args[2:]))
	case "uninstall":
		// Windows Settings → Apps runs this; it asks for confirmation itself.
		attachConsole()
		err := uninstall()
		if !hasConsole() {
			if err != nil {
				messageBox(appName, "Couldn't remove HomeyDeck: "+err.Error(), mbError)
			} else {
				messageBox(appName, "HomeyDeck was removed from this PC.", mbInfo)
			}
		}
		exitOn(err)
	case "status":
		attachConsole()
		exitOn(printStatus())
	case "version", "--version", "-v":
		attachConsole()
		fmt.Println("homeydeck-agent", version)
	default:
		attachConsole()
		fmt.Fprintf(os.Stderr, "unknown command %q (expected install, uninstall, status, run or version)\n", cmd)
		os.Exit(2)
	}
}

// interactive is what a double-click does: install from the setup code on
// the clipboard, or offer to uninstall when there's no code and it's installed.
func interactive() {
	if cfg, err := parseSetupCode(readClipboard()); err == nil {
		host := cfg.ServerURL
		if u, err := url.Parse(cfg.ServerURL); err == nil {
			host = u.Host
		}
		if !messageBox(appName, fmt.Sprintf("Install the HomeyDeck agent for %s?\n\nIt runs hidden in the background and starts when you sign in.", host), mbYesNo) {
			return
		}
		clearClipboard() // the code holds the agent key
		if err := install(cfg); err != nil {
			messageBox(appName, "Install failed: "+err.Error(), mbError)
			return
		}
		messageBox(appName, "HomeyDeck is installed and running.\n\nTo remove it, use Windows Settings → Apps, or double-click this file again.", mbInfo)
		return
	}

	if _, err := loadConfig(); err == nil {
		if messageBox(appName, "HomeyDeck is installed on this PC.\n\nUninstall it and delete all of its files?", mbYesNo|mbWarning) {
			if err := uninstall(); err != nil {
				messageBox(appName, "Couldn't remove HomeyDeck: "+err.Error(), mbError)
			} else {
				messageBox(appName, "HomeyDeck was removed from this PC.", mbInfo)
			}
		}
		return
	}

	messageBox(appName, "To install, first copy the setup code:\n\n1. Open HomeyDeck in a browser on this PC\n2. Settings → Set up this PC → Copy setup code\n3. Double-click this file again", mbInfo)
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
		log.Printf("not starting: %v (install it first)", err)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("homeydeck-agent %s starting, server %s", version, cfg.ServerURL)
	NewClient(cfg).Run(ctx)
	log.Printf("stopped")
}

// --- config ------------------------------------------------------------------

const setupPrefix = "homeydeck-setup:" // keep in step with SETUP_PREFIX in web/lib/hub.js

// parseSetupCode reads the code the app's "Copy setup code" button makes.
func parseSetupCode(text string) (Config, error) {
	var cfg Config
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, setupPrefix) {
		return cfg, errors.New("not a setup code")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(text[len(setupPrefix):], "="))
	if err != nil {
		return cfg, errors.New("the setup code is damaged, copy it again")
	}
	var code struct {
		Server string `json:"server"`
		Key    string `json:"key"`
	}
	if err := json.Unmarshal(raw, &code); err != nil {
		return cfg, errors.New("the setup code is damaged, copy it again")
	}
	cfg = Config{ServerURL: strings.TrimRight(code.Server, "/"), AgentKey: code.Key}
	return cfg, validateConfig(cfg)
}

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

func installFromArgs(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	server := fs.String("server", "", "HomeyDeck server URL, e.g. https://homey-deck.vercel.app")
	key := fs.String("key", "", "the AGENT_KEY you set on the server")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg := Config{ServerURL: strings.TrimRight(*server, "/"), AgentKey: *key}
	if cfg.ServerURL == "" && cfg.AgentKey == "" {
		// No flags: use a copied setup code, or keep the existing config (an update).
		if fromCode, err := parseSetupCode(readClipboard()); err == nil {
			cfg = fromCode
			clearClipboard()
		} else if existing, err := loadConfig(); err == nil {
			cfg = existing
		} else {
			return errors.New("copy the setup code from the app first, or pass --server and --key")
		}
	}
	if err := validateConfig(cfg); err != nil {
		return err
	}
	if err := install(cfg); err != nil {
		return err
	}
	fmt.Println("HomeyDeck agent installed and running. It starts hidden every time you sign in.")
	fmt.Println("Remove it from Windows Settings → Apps, or run: homeydeck-agent uninstall")
	return nil
}

func install(cfg Config) error {
	if err := saveConfig(cfg); err != nil {
		return fmt.Errorf("saving config: %w", err)
	}
	exe, err := installBinary()
	if err != nil {
		return fmt.Errorf("copying agent: %w", err)
	}
	if err := enableAutostart(exe); err != nil {
		return fmt.Errorf("enabling start at sign-in: %w", err)
	}
	if err := registerUninstaller(exe); err != nil {
		return fmt.Errorf("adding to Windows Settings → Apps: %w", err)
	}
	if err := startDetached(exe); err != nil {
		return fmt.Errorf("starting agent: %w", err)
	}
	return nil
}

// uninstall stops the agent, removes it from startup and from Settings → Apps,
// and deletes %LOCALAPPDATA%\HomeyDeck (the program, its config and its log).
func uninstall() error {
	stopOtherInstances()
	var errs []error
	if err := disableAutostart(); err != nil {
		errs = append(errs, fmt.Errorf("removing start at sign-in: %w", err))
	}
	if err := unregisterUninstaller(); err != nil {
		errs = append(errs, fmt.Errorf("removing from Settings → Apps: %w", err))
	}
	if err := removeDataDir(); err != nil {
		errs = append(errs, fmt.Errorf("deleting files: %w", err))
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	fmt.Println("HomeyDeck agent removed, along with all of its files.")
	return nil
}

func printStatus() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	fmt.Println("server:         ", cfg.ServerURL)
	fmt.Println("steam running:  ", steamRunning())
	fmt.Println("start at sign-in:", autostartEnabled())
	fmt.Println("log file:       ", logPath())
	return nil
}

// --- logging -----------------------------------------------------------------

const maxLogBytes = 256 << 10

func logPath() string { return filepath.Join(dataDir(), "agent.log") }

// openLog sends the standard logger to a small file, starting over once it
// grows past 256 KB so it can never fill the disk.
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
