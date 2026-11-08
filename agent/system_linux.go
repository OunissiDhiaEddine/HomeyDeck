//go:build linux

// The Linux agent, made for Bazzite (Fedora Atomic) and other systemd desktops.
//
// It installs into the user's home only, so nothing is layered onto the
// read-only system image and no root is needed:
//
//	~/.local/share/homeydeck/                  the program, config.json, agent.log, icon
//	~/.config/systemd/user/homeydeck-agent.service   starts it at sign-in
//	~/.local/share/applications/homeydeck-agent.desktop   "HomeyDeck agent" in the app menu
//
// Opening "HomeyDeck agent" from the app menu offers to uninstall it, which
// removes all three.
package main

import (
	"bufio"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed icon/homeydeck-agent.png
var iconPNG []byte

const (
	exeName  = "homeydeck-agent"
	unitName = "homeydeck-agent.service"
	appID    = "homeydeck-agent" // the .desktop file's name

	canProtect   = false // no DPAPI here: config.json is 0600 instead
	appEntryName = "the app menu entry"
	againHint    = "Or copy it on this PC and open HomeyDeck agent again."
	removeHint   = "To remove it, open HomeyDeck agent from the app menu, or remove the PC in HomeyDeck."
)

// dataDir is ~/.local/share/homeydeck (program, config, log, icon).
func dataDir() string {
	if d := os.Getenv("HOMEYDECK_DATA_DIR"); d != "" {
		return d
	}
	return filepath.Join(xdgDir("XDG_DATA_HOME", ".local/share"), "homeydeck")
}

func xdgDir(env, fallback string) string {
	if d := os.Getenv(env); filepath.IsAbs(d) {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	return filepath.Join(home, fallback)
}

func unitPath() string {
	return filepath.Join(xdgDir("XDG_CONFIG_HOME", ".config"), "systemd", "user", unitName)
}
func desktopPath() string {
	return filepath.Join(xdgDir("XDG_DATA_HOME", ".local/share"), "applications", appID+".desktop")
}
func iconPath() string { return filepath.Join(dataDir(), "homeydeck-agent.png") }

// osName is the distribution's name from /etc/os-release, like "Bazzite".
var osName = sync.OnceValue(func() string {
	raw, _ := os.ReadFile("/etc/os-release")
	for _, line := range strings.Split(string(raw), "\n") {
		if v, ok := strings.CutPrefix(line, "NAME="); ok {
			if v = strings.Trim(v, `"'`); v != "" {
				return v
			}
		}
	}
	return "Linux"
})

// dryRun keeps tests (and curious developers) from launching Steam or
// suspending the machine they run on.
func dryRun() bool { return os.Getenv("HOMEYDECK_DRY_RUN") == "1" }

func attachConsole() {}

func hasConsole() bool { return isTerminal(os.Stdout) }

// singleInstance holds a lock on a file in dataDir for as long as it runs.
func singleInstance() (func(), error) {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dataDir(), "agent.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another copy is already running")
	}
	return func() { f.Close() }, nil
}

func uptime() time.Duration {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	secs, _ := strconv.ParseFloat(strings.Fields(string(raw) + " 0")[0], 64)
	return time.Duration(secs * float64(time.Second))
}

// --- Steam -------------------------------------------------------------------

func steamRunning() bool {
	steam, _ := appsRunning()
	return steam
}

// appsRunning reports whether Steam and Sunshine are running by reading each
// process's name in /proc. That covers the rpm, Flatpak and AppImage builds,
// and Steam in Game Mode.
func appsRunning() (steam, sunshine bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, false
	}
	for _, e := range entries {
		if c := e.Name()[0]; c < '0' || c > '9' {
			continue
		}
		comm, err := os.ReadFile("/proc/" + e.Name() + "/comm")
		if err != nil {
			continue
		}
		switch strings.TrimSpace(string(comm)) {
		case "steam":
			steam = true
		case "sunshine":
			sunshine = true
		}
		if steam && sunshine {
			break
		}
	}
	return steam, sunshine
}

// steamCommand is how to start Steam: the system one (Bazzite's), or the Flatpak.
func steamCommand() []string {
	if p, err := exec.LookPath("steam"); err == nil {
		return []string{p}
	}
	for _, dir := range []string{"/var/lib/flatpak/app/com.valvesoftware.Steam", filepath.Join(xdgDir("XDG_DATA_HOME", ".local/share"), "flatpak/app/com.valvesoftware.Steam")} {
		if _, err := os.Stat(dir); err == nil {
			return []string{"flatpak", "run", "com.valvesoftware.Steam"}
		}
	}
	return nil
}

// launchSteam opens the normal Steam library window, not Big Picture.
func launchSteam() error {
	if dryRun() {
		log.Printf("[dry run] would launch Steam")
		return nil
	}
	argv := steamCommand()
	if argv == nil {
		return errors.New("Steam isn't installed")
	}
	argv = append(argv, "steam://open/main")
	// In a unit of its own, Steam keeps running when the agent stops or
	// updates, and it gets the desktop session's display variables.
	if _, err := exec.LookPath("systemd-run"); err == nil {
		unit := fmt.Sprintf("homeydeck-steam-%d", time.Now().Unix())
		cmd := exec.Command("systemd-run", append([]string{"--user", "--collect", "--quiet", "--unit", unit, "--"}, argv...)...)
		if out, err := cmd.CombinedOutput(); err == nil {
			return nil
		} else {
			log.Printf("systemd-run: %v %s", err, strings.TrimSpace(string(out)))
		}
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start Steam: %w", err)
	}
	return cmd.Process.Release()
}

// --- power -------------------------------------------------------------------

// logindAllows asks logind whether this user may suspend or reboot without a
// password prompt, so the app hears "not allowed" instead of silence.
func logindAllows(method string) error {
	out, err := exec.Command("busctl", "--system", "call", "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", method).Output()
	if err != nil {
		return nil // can't ask; try anyway
	}
	switch answer := strings.Trim(strings.TrimPrefix(strings.TrimSpace(string(out)), "s "), `"`); answer {
	case "yes":
		return nil
	case "challenge":
		return errors.New("this Linux user isn't allowed to do that without a password")
	default:
		return fmt.Errorf("Linux says it can't (%s)", answer)
	}
}

func canSleep() error { return logindAllows("CanSuspend") }

func sleepNow() error {
	if dryRun() {
		log.Printf("[dry run] would suspend")
		return nil
	}
	return systemctl(false, "suspend")
}

// reboot checks it's allowed, then restarts a moment later so the reply to
// the app gets out first.
func reboot() error {
	if err := logindAllows("CanReboot"); err != nil {
		return err
	}
	go func() {
		time.Sleep(2 * time.Second)
		if dryRun() {
			log.Printf("[dry run] would reboot")
			return
		}
		if err := systemctl(false, "reboot"); err != nil {
			log.Printf("reboot failed: %v", err)
		}
	}()
	return nil
}

// --- Wake-on-LAN check -------------------------------------------------------

// wakeHint says how to turn Wake-on-LAN on when the network card has it off,
// which is common on Linux. Empty when it's on or can't be told.
func wakeHint() string {
	iface := defaultInterface()
	if iface == "" {
		return ""
	}
	if _, err := os.Stat("/sys/class/net/" + iface + "/wireless"); err == nil {
		return fmt.Sprintf("Note: this PC is on Wi-Fi (%s). Wake-on-LAN needs a network cable.", iface)
	}
	on, err := magicPacketWake(iface)
	if err != nil || on {
		return ""
	}
	return fmt.Sprintf("Wake-on-LAN is off for %s, so HomeyDeck can't wake this PC while Linux is asleep or off. To turn it on, run this once, then restart:\n\n"+
		"  nmcli connection modify \"$(nmcli -g GENERAL.CONNECTION device show %s)\" 802-3-ethernet.wake-on-lan magic", iface, iface)
}

// defaultInterface is the network interface with the default IPv4 route.
func defaultInterface() string {
	raw, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n")[1:] {
		f := strings.Fields(line)
		if len(f) > 3 && f[1] == "00000000" {
			if flags, _ := strconv.ParseUint(f[3], 16, 32); flags&1 != 0 { // RTF_UP
				return f[0]
			}
		}
	}
	return ""
}

// --- install -----------------------------------------------------------------

// installBinary copies the running program to ~/.local/share/homeydeck so the
// download can be deleted. Re-running install from the installed copy is fine.
func installBinary() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	dest := filepath.Join(dataDir(), exeName)
	if filepath.Clean(self) == dest {
		return dest, nil
	}
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return "", err
	}
	src, err := os.Open(self)
	if err != nil {
		return "", err
	}
	defer src.Close()
	tmp := dest + ".new"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return "", err
	}
	if err := dst.Close(); err != nil {
		return "", err
	}
	// Renaming over the old copy is safe while it runs.
	return dest, os.Rename(tmp, dest)
}

func runningInstalledCopy() bool {
	self, err := os.Executable()
	return err == nil && filepath.Clean(self) == filepath.Join(dataDir(), exeName)
}

// enableAutostart writes a systemd user service, which starts the agent when
// this user signs in (Bazzite signs in by itself, into Game Mode or the desktop).
func enableAutostart(exe string) error {
	unit := fmt.Sprintf(`[Unit]
Description=HomeyDeck agent
Documentation=https://github.com/OunissiDhiaEddine/HomeyDeck

[Service]
ExecStart=%q run
Restart=on-failure
RestartSec=10
Nice=10

[Install]
WantedBy=default.target
`, exe)
	if err := os.MkdirAll(filepath.Dir(unitPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(unitPath(), []byte(unit), 0o644); err != nil {
		return err
	}
	if err := systemctl(true, "daemon-reload"); err != nil {
		return err
	}
	return systemctl(true, "enable", unitName)
}

func disableAutostart() error {
	if _, err := os.Stat(unitPath()); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	_ = systemctl(true, "disable", unitName)
	if err := os.Remove(unitPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return systemctl(true, "daemon-reload")
}

func autostartEnabled() bool { return systemctl(true, "is-enabled", "--quiet", unitName) == nil }

// registerUninstaller adds "HomeyDeck agent", with the HomeyDeck icon, to the
// app menu. Opening it offers to update or uninstall the agent.
func registerUninstaller(exe string) error {
	if err := os.WriteFile(iconPath(), iconPNG, 0o644); err != nil {
		return err
	}
	// Without kdialog or zenity (Fedora Workstation ships neither), the entry
	// opens a terminal instead, which waits for Enter before it closes.
	execLine, terminal := fmt.Sprintf("%q", exe), "false"
	if !have("kdialog") && !have("zenity") {
		execLine, terminal = fmt.Sprintf("env HOMEYDECK_PAUSE=1 %q", exe), "true"
	}
	entry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=HomeyDeck agent
Comment=Wake and control this PC from HomeyDeck. Open to remove it.
Exec=%s
Icon=%s
Terminal=%s
Categories=Utility;
StartupNotify=false
`, execLine, iconPath(), terminal)
	if err := os.MkdirAll(filepath.Dir(desktopPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(desktopPath(), []byte(entry), 0o644)
}

func unregisterUninstaller() error {
	if err := os.Remove(desktopPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func removeDataDir() error { return os.RemoveAll(dataDir()) }

// startDetached (re)starts the service, which picks up a freshly copied program.
func startDetached(string) error { return systemctl(true, "restart", unitName) }

// stopOtherInstances stops the service, unless this is the service itself
// uninstalling (it simply exits afterwards).
func stopOtherInstances() {
	if insideService() {
		return
	}
	_ = systemctl(true, "stop", unitName)
}

func insideService() bool {
	raw, _ := os.ReadFile("/proc/self/cgroup")
	return strings.Contains(string(raw), "/"+unitName)
}

// systemctl runs systemctl, for the user's own services when user is true.
func systemctl(user bool, args ...string) error {
	if user {
		args = append([]string{"--user"}, args...)
	}
	out, err := exec.Command("systemctl", args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("systemctl %s: %s", strings.Join(args, " "), msg)
	}
	return nil
}

// Linux keeps the token in a 0600 file instead of encrypting it.
func protect(data []byte) ([]byte, error)   { return data, nil }
func unprotect(data []byte) ([]byte, error) { return data, nil }

// stdin is shared by every prompt so typed-ahead lines aren't lost.
var stdin = bufio.NewReader(os.Stdin)
