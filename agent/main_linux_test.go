//go:build linux

package main

import (
	"os"
	"strings"
	"testing"
)

func TestLinuxBasics(t *testing.T) {
	if uptime() <= 0 {
		t.Error("uptime should come from /proc/uptime")
	}
	if osName() == "" {
		t.Error("osName is empty")
	}
	// The test binary itself is a process; its name must not count as Steam.
	if steam, sunshine := appsRunning(); steam || sunshine {
		t.Logf("steam=%v sunshine=%v (running on a machine that has them?)", steam, sunshine)
	}
}

func TestLinuxSingleInstance(t *testing.T) {
	t.Setenv("HOMEYDECK_DATA_DIR", t.TempDir())
	release, err := singleInstance()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := singleInstance(); err == nil {
		t.Fatal("a second copy got the lock")
	}
	release()
	again, err := singleInstance()
	if err != nil {
		t.Fatalf("lock not released: %v", err)
	}
	again()
}

func TestLinuxTokenFileIsPrivate(t *testing.T) {
	t.Setenv("HOMEYDECK_DATA_DIR", t.TempDir())
	if err := saveConfig(Config{ServerURL: "https://homey-deck.vercel.app", Token: testToken}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(configPath())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config.json mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}
	raw, _ := os.ReadFile(configPath())
	if !strings.Contains(string(raw), `"token"`) || strings.Contains(string(raw), "token_dpapi") {
		t.Fatalf("config.json = %s", raw)
	}
}

// Without kdialog or zenity (Fedora Workstation), the app menu entry opens a
// terminal that waits before closing, so uninstalling still works.
func TestLinuxMenuEntryWithoutDialogTools(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	t.Setenv("HOMEYDECK_DATA_DIR", dir)
	t.Setenv("PATH", t.TempDir())
	if err := registerUninstaller("/opt/x/homeydeck-agent"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(desktopPath())
	for _, want := range []string{"Terminal=true", `Exec=env HOMEYDECK_PAUSE=1 "/opt/x/homeydeck-agent"`, "Icon=" + iconPath()} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("entry lacks %q:\n%s", want, raw)
		}
	}
}
