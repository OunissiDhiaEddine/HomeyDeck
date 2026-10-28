// HomeyDeck agent: a tiny background program for the Windows PC.
//
// It polls the HomeyDeck server over HTTPS, reports whether Steam is
// running, and carries out launch_steam / sleep / reboot commands.
//
// Installing needs no terminal: in HomeyDeck choose Add PC and copy the
// pairing code, then double-click homeydeck-agent.exe (or type the code into
// the box it shows). Double-clicking it again, or removing "HomeyDeck agent"
// in Windows Settings → Apps, uninstalls it and deletes everything it saved.
// It also uninstalls itself when the PC is removed from the account.
//
// The same things work from a terminal:
//
//	homeydeck-agent.exe install [--code homey-deck.vercel.app/K7P2X-M9Q4T]
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
	"regexp"
	"strings"
	"syscall"
)

// Set at build time with -ldflags "-X main.version=..."
var version = "dev"

const appName = "HomeyDeck"

// Config is what the agent keeps in %LOCALAPPDATA%\HomeyDeck\config.json.
// The token is encrypted with Windows DPAPI on disk.
type Config struct {
	ServerURL string `json:"server_url"`
	Token     string `json:"-"`
}

type configFile struct {
	ServerURL string `json:"server_url"`
	Token     string `json:"token_dpapi,omitempty"`
	AgentKey  string `json:"agent_key,omitempty"` // v0.2, before accounts
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

// interactive is what a double-click does: pair with the code on the
// clipboard, offer to uninstall when it's already set up, or ask for the code.
func interactive() {
	clip := readClipboard()
	if code, err := parsePairCode(clip); err == nil {
		if !messageBox(appName, fmt.Sprintf("Add this PC to HomeyDeck at %s?\n\nThe agent runs hidden in the background and starts when you sign in.", code.host()), mbYesNo) {
			return
		}
		pairInteractive(code, true)
		return
	}
	if strings.HasPrefix(clip, legacySetupPrefix) {
		messageBox(appName, "That's a setup code from an older HomeyDeck.\n\nSign in to HomeyDeck, open the menu and choose Add PC to get a pairing code.", mbInfo)
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

	typed := ""
	for {
		text, ok := inputBox(appName, "Type the pairing code from HomeyDeck (menu → Add PC), including the address before it, like homey-deck.vercel.app/K7P2X-M9Q4T.\n\nOr copy it on this PC and double-click homeydeck-agent.exe again.", typed)
		if !ok {
			return
		}
		code, err := parsePairCode(text)
		if err != nil {
			messageBox(appName, err.Error(), mbWarning)
			typed = text
			continue
		}
		pairInteractive(code, false)
		return
	}
}

func pairInteractive(code PairCode, fromClipboard bool) {
	cfg, err := pair(code)
	if fromClipboard {
		clearClipboard()
	}
	if err == nil {
		err = install(cfg)
	}
	if err != nil {
		messageBox(appName, "Couldn't add this PC: "+err.Error(), mbError)
		return
	}
	messageBox(appName, "This PC is now in HomeyDeck, and the agent is running.\n\nTo remove it, use Windows Settings → Apps, or double-click this file again.", mbInfo)
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
		log.Printf("not starting: %v (pair it first)", err)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("homeydeck-agent %s starting, server %s", version, cfg.ServerURL)
	if err := NewClient(cfg).Run(ctx); errors.Is(err, errRemoved) {
		log.Printf("this PC was removed from its HomeyDeck account, uninstalling")
		uninstallErr := uninstall()
		if uninstallErr != nil {
			log.Printf("uninstall: %v", uninstallErr)
		}
		messageBox(appName, "This PC was removed from your HomeyDeck account, so HomeyDeck uninstalled itself.\n\nTo add it again, choose Add PC in HomeyDeck.", mbInfo)
		return
	}
	log.Printf("stopped")
}

// --- config ------------------------------------------------------------------

const (
	pairPrefix        = "homeydeck-pair:"  // keep in step with PAIR_PREFIX in web/lib/pcs.js
	legacySetupPrefix = "homeydeck-setup:" // v0.2
)

// PairCode is a one-time code from HomeyDeck → Add PC, and the server it's for.
type PairCode struct {
	Server string
	Code   string
}

func (p PairCode) host() string {
	if u, err := url.Parse(p.Server); err == nil {
		return u.Host
	}
	return p.Server
}

var codeChars = regexp.MustCompile(`[^0-9A-Za-z]`)

// parsePairCode reads "homeydeck-pair:host/CODE", as copied from the app, or
// "host/CODE" as typed. The server is https unless it's this computer.
func parsePairCode(text string) (PairCode, error) {
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), pairPrefix))
	slash := strings.LastIndex(text, "/")
	if slash < 0 {
		return PairCode{}, errors.New("include the address before the code, like homey-deck.vercel.app/K7P2X-M9Q4T")
	}
	server, code := strings.TrimRight(text[:slash], "/"), strings.ToUpper(codeChars.ReplaceAllString(text[slash+1:], ""))
	if !strings.Contains(server, "://") {
		scheme := "https://"
		if u, err := url.Parse("http://" + server); err == nil && isLocalhost(u.Hostname()) {
			scheme = "http://"
		}
		server = scheme + server
	}
	if len(code) != 10 {
		return PairCode{}, errors.New("the pairing code should have 10 letters and digits, like K7P2X-M9Q4T")
	}
	if err := validateServer(server); err != nil {
		return PairCode{}, err
	}
	return PairCode{Server: server, Code: code}, nil
}

func configPath() string { return filepath.Join(dataDir(), "config.json") }

var errNotPaired = errors.New("this PC isn't paired with HomeyDeck yet")

func loadConfig() (Config, error) {
	var file configFile
	raw, err := os.ReadFile(configPath())
	if err != nil {
		return Config{}, errNotPaired
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return Config{}, fmt.Errorf("parsing %s: %w", configPath(), err)
	}
	if file.Token == "" {
		return Config{}, errNotPaired // a v0.2 install, from before accounts
	}
	sealed, err := base64.StdEncoding.DecodeString(file.Token)
	if err != nil {
		return Config{}, errNotPaired
	}
	token, err := unprotect(sealed)
	if err != nil {
		return Config{}, fmt.Errorf("reading the saved token: %w", err)
	}
	cfg := Config{ServerURL: file.ServerURL, Token: string(token)}
	return cfg, validateConfig(cfg)
}

func validateServer(server string) error {
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return errors.New("the server address is not valid")
	}
	if u.Scheme != "https" && !isLocalhost(u.Hostname()) {
		return errors.New("the server address must start with https:// (plain http is only allowed for localhost)")
	}
	return nil
}

func validateConfig(cfg Config) error {
	if err := validateServer(cfg.ServerURL); err != nil {
		return err
	}
	if len(cfg.Token) < 40 || !strings.Contains(cfg.Token, ".") {
		return errNotPaired
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
	sealed, err := protect([]byte(cfg.Token))
	if err != nil {
		return fmt.Errorf("encrypting the token: %w", err)
	}
	raw, _ := json.MarshalIndent(configFile{ServerURL: cfg.ServerURL, Token: base64.StdEncoding.EncodeToString(sealed)}, "", "  ")
	return os.WriteFile(configPath(), raw, 0o600)
}

// --- commands ----------------------------------------------------------------

func installFromArgs(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	codeText := fs.String("code", "", "pairing code from HomeyDeck → Add PC, like homey-deck.vercel.app/K7P2X-M9Q4T")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var cfg Config
	switch {
	case *codeText != "":
		code, err := parsePairCode(*codeText)
		if err != nil {
			return err
		}
		if cfg, err = pair(code); err != nil {
			return err
		}
	default:
		// No code given: use a copied one, or keep the existing pairing (an update).
		if code, err := parsePairCode(readClipboard()); err == nil {
			clearClipboard()
			if cfg, err = pair(code); err != nil {
				return err
			}
		} else if existing, err := loadConfig(); err == nil {
			cfg = existing
		} else {
			return errors.New("copy a pairing code from HomeyDeck → Add PC first, or pass --code")
		}
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
