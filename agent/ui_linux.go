//go:build linux

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	mbInfo    = 0x40
	mbWarning = 0x30
	mbError   = 0x10
	mbYesNo   = 0x04
)

func isTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// interactiveTerminal is true when someone ran the agent in a terminal, so
// questions are asked there instead of in a window.
func interactiveTerminal() bool { return isTerminal(os.Stdin) && isTerminal(os.Stdout) }

// messageBox asks in the terminal, or with KDE's kdialog or GNOME's zenity
// (Bazzite has one or the other). With mbYesNo it reports whether Yes was
// chosen; otherwise it returns true once dismissed.
func messageBox(title, text string, flags uintptr) bool {
	yesNo := flags&mbYesNo != 0
	if interactiveTerminal() {
		fmt.Println()
		fmt.Println(text)
		if !yesNo {
			return true
		}
		fmt.Print("[y/N] ")
		line, _ := stdin.ReadString('\n')
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "y")
	}

	var args []string
	switch {
	case have("kdialog"):
		kind := "--msgbox"
		switch {
		case yesNo && flags&mbWarning != 0:
			kind = "--warningyesno"
		case yesNo:
			kind = "--yesno"
		case flags&mbError == mbError:
			kind = "--error"
		case flags&mbWarning == mbWarning:
			kind = "--sorry"
		}
		args = []string{"kdialog", "--title", title, "--icon", iconPath(), kind, text}
	case have("zenity"):
		kind := "--info"
		switch {
		case yesNo:
			kind = "--question"
		case flags&mbError == mbError:
			kind = "--error"
		case flags&mbWarning == mbWarning:
			kind = "--warning"
		}
		args = []string{"zenity", kind, "--title", title, "--window-icon", iconPath(), "--no-markup", "--text", text}
	case !yesNo && have("notify-send"):
		args = []string{"notify-send", "--app-name", title, "--icon", iconPath(), title, text}
	default:
		log.Printf("[%s] %s", title, text)
		return !yesNo
	}
	err := exec.Command(args[0], args[1:]...).Run()
	if err != nil {
		log.Printf("[%s] %s", title, text)
	}
	return !yesNo || err == nil
}

// inputBox asks for one line of text. ok is false when cancelled.
func inputBox(title, prompt, initial string) (string, bool) {
	if interactiveTerminal() {
		fmt.Println()
		fmt.Println(prompt)
		fmt.Print("> ")
		line, err := stdin.ReadString('\n')
		line = strings.TrimSpace(line)
		return line, err == nil && line != ""
	}
	var cmd *exec.Cmd
	switch {
	case have("kdialog"):
		cmd = exec.Command("kdialog", "--title", title, "--icon", iconPath(), "--inputbox", prompt, initial)
	case have("zenity"):
		cmd = exec.Command("zenity", "--entry", "--title", title, "--window-icon", iconPath(), "--text", prompt, "--entry-text", initial)
	default:
		log.Printf("[%s] %s (run this in a terminal to type it)", title, prompt)
		return "", false
	}
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err == nil
}

func have(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// readClipboard returns the clipboard's text, or "" if there is none or no
// clipboard tool is installed (wl-paste on Wayland, xclip or xsel on X11).
func readClipboard() string {
	for _, argv := range [][]string{
		{"wl-paste", "--no-newline", "--type", "text/plain"},
		{"xclip", "-o", "-selection", "clipboard"},
		{"xsel", "--clipboard", "--output"},
	} {
		if !have(argv[0]) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).Output()
		cancel()
		if err == nil && len(out) <= 4096 {
			return strings.TrimSpace(string(out))
		}
	}
	return ""
}

func clearClipboard() {
	if have("wl-copy") {
		_ = exec.Command("wl-copy", "--clear").Run()
	}
}
