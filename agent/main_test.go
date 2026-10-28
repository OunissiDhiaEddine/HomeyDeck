package main

import (
	"testing"
)

const testToken = "AAAAAAAAAAAAAAAAAAAAAA.0123456789abcdef0123456789abcdef0123456789a"

func TestValidateConfig(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		ok   bool
	}{
		{"https", Config{"https://homey-deck.vercel.app", testToken}, true},
		{"localhost http", Config{"http://127.0.0.1:3000", testToken}, true},
		{"remote http", Config{"http://example.com", testToken}, false},
		{"no token", Config{"https://example.com", ""}, false},
		{"v0.2 key", Config{"https://example.com", "0123456789abcdef0123456789abcdef0123456789"}, false},
		{"no host", Config{"https://", testToken}, false},
	}
	for _, c := range cases {
		if err := validateConfig(c.cfg); (err == nil) != c.ok {
			t.Errorf("%s: got err=%v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestParsePairCode(t *testing.T) {
	want := PairCode{Server: "https://homey-deck.vercel.app", Code: "K7P2XM9Q4T"}
	for _, text := range []string{
		"homeydeck-pair:homey-deck.vercel.app/K7P2X-M9Q4T",
		"  homeydeck-pair:homey-deck.vercel.app/K7P2X-M9Q4T\r\n",
		"homey-deck.vercel.app/k7p2x m9q4t",
		"https://homey-deck.vercel.app/K7P2X-M9Q4T",
	} {
		if got, err := parsePairCode(text); err != nil || got != want {
			t.Errorf("parsePairCode(%q) = %+v, %v", text, got, err)
		}
	}
	if got, err := parsePairCode("localhost:3000/K7P2X-M9Q4T"); err != nil || got.Server != "http://localhost:3000" {
		t.Errorf("localhost: got %+v, %v", got, err)
	}
	for _, text := range []string{"", "hello", "K7P2X-M9Q4T", "homey-deck.vercel.app/K7P2X", "http://example.com/K7P2X-M9Q4T", "homeydeck-setup:abc"} {
		if _, err := parsePairCode(text); err == nil {
			t.Errorf("accepted %q", text)
		}
	}
}

func TestConfigRoundTrip(t *testing.T) {
	t.Setenv("HOMEYDECK_DATA_DIR", t.TempDir())
	if _, err := loadConfig(); err != errNotPaired {
		t.Fatalf("empty dir: got %v, want errNotPaired", err)
	}
	cfg := Config{ServerURL: "https://homey-deck.vercel.app", Token: testToken}
	if err := saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if got, err := loadConfig(); err != nil || got != cfg {
		t.Fatalf("got %+v, %v", got, err)
	}
}
