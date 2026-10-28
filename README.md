# HomeyDeck

Wake, check and control your Windows gaming PC from your iPhone or Mac, from anywhere.

- **Wake** the PC with Wake-on-LAN through your router's DDNS address
- **See** whether it's on, how long it's been up, and whether Steam is running
- **Launch Steam** so it's ready for Remote Play
- **Sleep** or **restart** it remotely

## How it works

```
 iPhone / Mac app ──HTTPS──▶ Cloudflare Worker ◀──WebSocket── Windows agent
        │                     (free tier relay)                (hidden, on the PC)
        │
        └──UDP magic packet──▶ router DDNS:port ──▶ PC network card
```

- **`apple/`**: a SwiftUI app for iOS 17+ and macOS 14+. It sends the Wake-on-LAN packet itself and talks to the server for everything else.
- **`server/`**: a Cloudflare Worker with one Durable Object. It holds the agent's connection, remembers the last status and forwards commands. It runs on Cloudflare's free plan.
- **`agent/`**: a small Go program for Windows. It starts hidden at sign-in, keeps one outbound connection to the server (no ports to open), reports Steam status and carries out launch / sleep / restart.

## Security

There's no login screen, because it's a single-user setup. Instead:

- The app and the agent each use their own long random key (`APP_KEY`, `AGENT_KEY`), sent only over HTTPS/WSS and compared in constant time.
- The app keeps its key in the Keychain. The agent keeps its key in `%LOCALAPPDATA%\HomeyDeck\config.json`, which only your Windows account can read.
- After 10 failed attempts from an IP address, the server blocks that address for 15 minutes.
- The agent only accepts three commands (`launch_steam`, `sleep`, `reboot`). There's no remote shell, so even a leaked key can't run arbitrary code.
- The PC never accepts inbound connections for HomeyDeck. The only open port is the Wake-on-LAN UDP port you already forward.

## Setup

See **[docs/setup.md](docs/setup.md)** for the full walkthrough. In short:

1. Set up the Cloudflare server and keys: **[docs/cloudflare-setup.md](docs/cloudflare-setup.md)**
2. Build the agent (`agent/build.sh`) and run `homeydeck-agent.exe install --server <url> --key <AGENT_KEY>` on the PC
3. Open `apple/HomeyDeck.xcodeproj` in Xcode 16+, pick your team, run it, and fill in Settings

## Development

| Part   | Run locally                                     | Check                              |
|--------|-------------------------------------------------|------------------------------------|
| Server | `cd server && cp .dev.vars.example .dev.vars && npm run dev` | `npm run typecheck`  |
| Agent  | `go run .` (on macOS or Linux, power actions are only logged) | `go vet ./... && go test ./...` |
| App    | Open in Xcode, run on "My Mac" or a simulator   | Build in Xcode                     |

You can point a development agent at a local server with `install --server http://127.0.0.1:8787`. Plain HTTP is only allowed for localhost.
