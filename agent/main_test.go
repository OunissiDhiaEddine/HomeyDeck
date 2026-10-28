package main

import (
	"encoding/base64"
	"testing"
)

func TestValidateConfig(t *testing.T) {
	key := "0123456789abcdef0123456789abcdef"
	cases := []struct {
		name string
		cfg  Config
		ok   bool
	}{
		{"https", Config{"https://homeydeck.example.workers.dev", key}, true},
		{"localhost http", Config{"http://127.0.0.1:8787", key}, true},
		{"remote http", Config{"http://example.com", key}, false},
		{"short key", Config{"https://example.com", "short"}, false},
		{"no host", Config{"https://", key}, false},
	}
	for _, c := range cases {
		if err := validateConfig(c.cfg); (err == nil) != c.ok {
			t.Errorf("%s: got err=%v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestParseSetupCode(t *testing.T) {
	key := "0123456789abcdef0123456789abcdef"
	code := func(json string) string { return setupPrefix + base64.RawURLEncoding.EncodeToString([]byte(json)) }

	cfg, err := parseSetupCode("  " + code(`{"server":"https://homey-deck.vercel.app/","key":"`+key+`"}`) + "\n")
	if err != nil || cfg != (Config{"https://homey-deck.vercel.app", key}) {
		t.Fatalf("got %+v, %v", cfg, err)
	}
	for name, text := range map[string]string{
		"empty":      "",
		"other text": "hello",
		"damaged":    setupPrefix + "%%%",
		"http":       code(`{"server":"http://example.com","key":"` + key + `"}`),
		"short key":  code(`{"server":"https://example.com","key":"short"}`),
	} {
		if _, err := parseSetupCode(text); err == nil {
			t.Errorf("%s: accepted %q", name, text)
		}
	}
}
