//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue   = "HomeyDeck"
	exeName    = "homeydeck-agent.exe"
)

var (
	kernel32           = windows.NewLazySystemDLL("kernel32.dll")
	procAttachConsole  = kernel32.NewProc("AttachConsole")
	procGetTickCount64 = kernel32.NewProc("GetTickCount64")
	powrprof           = windows.NewLazySystemDLL("powrprof.dll")
	procSetSuspend     = powrprof.NewProc("SetSuspendState")
)

// dataDir is %LOCALAPPDATA%\HomeyDeck (config + log).
func dataDir() string {
	base, err := os.UserCacheDir() // %LOCALAPPDATA% on Windows
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "HomeyDeck")
}

// The agent is built as a GUI program so no console window ever appears.
// For the install/status commands we borrow the console of the terminal that
// launched us, if there is one.
func attachConsole() {
	const attachParentProcess = ^uintptr(0) // (DWORD)-1
	if r, _, _ := procAttachConsole.Call(attachParentProcess); r == 0 {
		return
	}
	if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = out, out
	}
	fmt.Println()
}

func singleInstance() (func(), error) {
	name, _ := windows.UTF16PtrFromString(`Local\HomeyDeckAgent`)
	h, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(h)
		return nil, errors.New("another copy is already running")
	}
	if err != nil {
		return nil, err
	}
	return func() { windows.CloseHandle(h) }, nil
}

func uptime() time.Duration {
	ms, _, _ := procGetTickCount64.Call()
	return time.Duration(ms) * time.Millisecond
}

// --- Steam -------------------------------------------------------------------

func steamRunning() bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "steam.exe") {
			return true
		}
	}
	return false
}

func launchSteam() error {
	if exe := steamExePath(); exe != "" {
		cmd := exec.Command(exe)
		cmd.Dir = filepath.Dir(exe)
		if err := cmd.Start(); err == nil {
			_ = cmd.Process.Release()
			return nil
		}
	}
	// Fall back to the steam:// protocol handler.
	cmd := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", "steam://open/main")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start Steam: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

func steamExePath() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Valve\Steam`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	exe, _, err := k.GetStringValue("SteamExe")
	if err != nil {
		return ""
	}
	exe = filepath.FromSlash(exe)
	if _, err := os.Stat(exe); err != nil {
		return ""
	}
	return exe
}

// --- power -------------------------------------------------------------------

func canSleep() error {
	if err := procSetSuspend.Find(); err != nil {
		return errors.New("sleep is not available on this PC")
	}
	return nil
}

func sleepNow() error {
	// SetSuspendState(hibernate=FALSE, force=FALSE, disableWakeEvent=FALSE).
	// Wake events must stay enabled or Wake-on-LAN would not work.
	r, _, err := procSetSuspend.Call(0, 0, 0)
	if r == 0 {
		return err
	}
	return nil
}

func reboot() error {
	cmd := exec.Command("shutdown.exe", "/r", "/t", "5", "/c", "Restart requested from HomeyDeck")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("shutdown.exe: %v %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// --- install -----------------------------------------------------------------

// installBinary copies the running exe to %LOCALAPPDATA%\HomeyDeck so the
// download can be deleted. Re-running install from the installed copy is fine.
func installBinary() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	dest := filepath.Join(dataDir(), exeName)
	if strings.EqualFold(filepath.Clean(self), filepath.Clean(dest)) {
		return dest, nil
	}

	stopOtherInstances() // an older copy may be holding the file open
	time.Sleep(500 * time.Millisecond)

	src, err := os.Open(self)
	if err != nil {
		return "", err
	}
	defer src.Close()
	tmp := dest + ".new"
	dst, err := os.Create(tmp)
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
	return dest, os.Rename(tmp, dest)
}

func enableAutostart(exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(runValue, `"`+exe+`"`)
}

func disableAutostart() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(runValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func autostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runValue)
	return err == nil
}

func startDetached(exe string) error {
	cmd := exec.Command(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func stopOtherInstances() {
	cmd := exec.Command("taskkill.exe", "/F", "/IM", exeName, "/FI", "PID ne "+strconv.Itoa(os.Getpid()))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	_ = cmd.Run()
}
