# HomeyDeck

Wake, check and control your Windows gaming PC from your iPhone or Mac, from anywhere.

- **Wake** the PC with Wake-on-LAN through your router's DDNS address
- **See** whether it's on, how long it's been up, and whether Steam is running
- **Launch Steam** so it's ready for Remote Play
- **Sleep** or **restart** it remotely

Everything runs on free plans with no card: Vercel Hobby for the server and app, and Upstash Redis (added from Vercel) for a little state.

## How it works

```
 HomeyDeck app (PWA) ──HTTPS──▶ Vercel ◀──HTTPS polling── Windows agent
                                  │                         (hidden, on the PC)
                                  └──UDP magic packet──▶ router DDNS:port ──▶ PC network card
```

- **`web/`**: the Vercel project. `public/` is the installable web app, `api/` the server functions, and `lib/` their shared code. There is no build step and there are no dependencies.
- **`agent/`**: a small Go program for Windows. It starts hidden at sign-in, asks the server for work every 20 seconds (every 2 seconds while the app is open), reports Steam status, and carries out launch / sleep / restart. It never accepts inbound connections.

## Setup

### 1. Make two keys

You need one key for the app and one for the agent. Each must be at least 32 random characters, and they must be different. The easiest way is your password manager's generator (48 characters, letters and digits). Keep both in the password manager.

### 2. Configure Vercel

In the Vercel project (Root Directory `web`, Deployment Protection's Vercel Authentication turned off):

1. **Storage**: create an **Upstash for Redis** database on the **Free** plan and connect it to the project. Vercel adds its settings for you.
2. **Settings → Environment Variables**: add these for Production and Preview:

   | Name | Value |
   |---|---|
   | `APP_KEY` | the app key |
   | `AGENT_KEY` | the agent key |
   | `WOL_MAC` | the PC's network card MAC address, like `AA:BB:CC:DD:EE:FF` |
   | `WOL_HOST` | your router's DDNS name |
   | `WOL_PORT` | the UDP port your router forwards for Wake-on-LAN |

3. **Deployments**: redeploy the latest deployment so it picks up the variables.
4. Open `https://<your-project>.vercel.app/api/health`. Every value should be `true`:
   `{"ok":true,"poll":true,"keys":true,"database":true,"wake":true}`

### 3. Install the app

- **iPhone**: open your Vercel address in Safari, tap **Share → Add to Home Screen**, then open HomeyDeck from the Home Screen, tap the gear and paste the app key.
- **Mac**: open the address in Safari and choose **File → Add to Dock** (or install it from Chrome's address bar), then paste the app key the same way.

The key is stored only on that device. An app added to the Home Screen keeps its own storage, so paste the key inside the installed app, not just in Safari.

### 4. Install the agent on the PC

No terminal needed:

1. On the PC, open your Vercel address in a browser, paste the app key in **Settings**, and click **Copy setup code**.
2. Download `homeydeck-agent.exe` from the [latest release](https://github.com/OunissiDhiaEddine/HomeyDeck/releases/latest) (the same Settings screen links to it).
3. Double-click it and click **Yes**. It copies itself to `%LOCALAPPDATA%\HomeyDeck`, starts hidden, and starts again every time you sign in. It clears the setup code from the clipboard afterwards.

The setup code holds the address you copied it from. Copy it from your production address (`<project>.vercel.app`), not a preview link, so the agent keeps working after future deploys.

To **remove** it, use Windows **Settings → Apps → HomeyDeck agent → Uninstall**, or double-click `homeydeck-agent.exe` again. Either way it stops the agent, removes it from startup and deletes `%LOCALAPPDATA%\HomeyDeck`, so nothing is left behind.

To **update** it, copy the setup code again and double-click the new exe.

## Security

There's no login screen, because it's a single-user setup. Instead:

- The app and the agent each use their own long random key, sent only over HTTPS and compared in constant time. The app key can't act as the agent, or the other way round.
- After 10 failed key attempts from an IP address, the server refuses that address for 15 minutes.
- The agent only accepts three commands (`launch_steam`, `sleep`, `reboot`). There's no remote shell, so even a leaked key can't run arbitrary code.
- A command the PC doesn't pick up within 40 seconds is dropped, so a "restart" can never run hours later.
- The PC never accepts inbound connections for HomeyDeck. The only open port is the Wake-on-LAN UDP port you already forward.
- The setup code contains the agent key, which is why only someone with the app key can get one.

## Free plan budget

With the PC on all day, the agent makes about 4,300 requests a day (about 3 database commands each). That is roughly 130,000 Vercel function calls and 390,000 Upstash commands a month, inside the free limits of 1,000,000 and 500,000. While the PC is asleep it costs nothing, and having the app open adds a little.

## Development

| Part | Run locally | Check |
|---|---|---|
| Server + app | `cd web && APP_KEY=… AGENT_KEY=… npm run dev` (uses an in-memory database) | `npm test` |
| Agent | `go run . run` (on macOS or Linux, power actions are only logged) | `go vet ./... && go test ./...` |

Build the agent with `agent/build.sh <version>` (or `agent\build.ps1` on Windows). Point a development agent at a local server with `install --server http://127.0.0.1:3000 --key <AGENT_KEY>`. Plain HTTP is only allowed for localhost.
