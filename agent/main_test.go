package main

import "testing"

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

func TestWebSocketURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://h.example.dev": "wss://h.example.dev/agent/connect",
		"http://127.0.0.1:8787": "ws://127.0.0.1:8787/agent/connect",
	} {
		if got := (&Client{cfg: Config{ServerURL: in}}).wsURL(); got != want {
			t.Errorf("wsURL(%q) = %q, want %q", in, got, want)
		}
	}
}
