# Setting up HomeyDeck

Plan on about 20 minutes. You need a free Cloudflare account, Go 1.21 or newer to build the agent (it downloads the exact Go version it needs), and Xcode 16+ on your Mac.

## 1. Generate two keys

You need one key for the app and one for the agent. They must be different, and each must be at least 32 characters.

```sh
openssl rand -base64 48   # APP_KEY
openssl rand -base64 48   # AGENT_KEY
```

Keep them in your password manager. You'll paste APP_KEY into the app and AGENT_KEY into the agent.

## 2. Deploy the server

Follow **[cloudflare-setup.md](cloudflare-setup.md)**. It walks through the Cloudflare account, choosing your workers.dev subdomain, deploying, setting APP_KEY and AGENT_KEY as secrets, and checking the server works. In short:

```sh
cd server
npm install
npx wrangler login                 # opens a browser to sign in to Cloudflare
npx wrangler deploy                # prints https://homeydeck.<you>.workers.dev
npx wrangler secret put APP_KEY    # paste the app key
npx wrangler secret put AGENT_KEY  # paste the agent key
curl https://homeydeck.<you>.workers.dev/health   # {"ok":true}
```

Deploying from GitHub Actions is optional. See [Optional: deploy from GitHub instead](cloudflare-setup.md#optional-deploy-from-github-instead).

## 3. Install the agent on the PC

Download `homeydeck-agent.exe` from the latest [GitHub release](https://github.com/OunissiDhiaEddine/HomeyDeck/releases), or build it from any machine with Go:

```sh
./agent/build.sh 1.0.0          # macOS/Linux → agent/dist/homeydeck-agent.exe
# or on Windows:  .\agent\build.ps1 -Version 1.0.0
```

Copy `homeydeck-agent.exe` to the PC. Then open **PowerShell (not as admin)** in that folder and run:

```powershell
.\homeydeck-agent.exe install --server https://homeydeck.<you>.workers.dev --key "<AGENT_KEY>"
```

That command does four things:

- copies the agent to `%LOCALAPPDATA%\HomeyDeck\homeydeck-agent.exe`
- saves the config next to it
- adds it to startup for your Windows account (`HKCU\...\Run`, so no admin rights are needed)
- starts it right away, with no window and no tray icon

After that you can delete the downloaded exe. Some other useful commands:

```powershell
& "$env:LOCALAPPDATA\HomeyDeck\homeydeck-agent.exe" status      # quick self-check
& "$env:LOCALAPPDATA\HomeyDeck\homeydeck-agent.exe" uninstall   # remove from startup and stop it
Get-Content "$env:LOCALAPPDATA\HomeyDeck\agent.log" -Tail 20    # see what it's doing
```

To update the agent, run `install` again with the new exe. You can leave out `--server` and `--key`, and it keeps your existing config.

The agent runs in your user session, so it starts when you sign in to Windows. If you want Steam Remote Play to work right after waking from a full shutdown, turn on automatic sign-in for your Windows account (for example with Sysinternals Autologon).

### Make sure Wake-on-LAN works from sleep

- **Device Manager:** open your network adapter, then **Power Management**, and tick *Allow this device to wake the computer* and *Only allow a magic packet to wake the computer*.
- **Advanced tab:** set *Wake on Magic Packet* to Enabled.
- **Waking from shutdown:** turn off *Fast startup* (Control Panel → Power Options → Choose what the power buttons do). Also enable Wake-on-LAN / *Power On By PCI-E* in the BIOS.
- Sleep uses the standard Windows sleep. On PCs with *Modern Standby* (S0), Wake-on-LAN from sleep depends on the network card. If waking from sleep is unreliable, test from a full shutdown to rule the router out.

## 4. Run the Mac and iPhone app

**Prebuilt:** each GitHub release has `HomeyDeck-macOS.zip` (ad-hoc signed; right-click → **Open** the first time) and `HomeyDeck-iOS-unsigned.ipa` (install it with Sideloadly or AltStore, which sign it with your Apple ID). Then skip to step 5 below.

**From Xcode:**

1. Open `apple/HomeyDeck.xcodeproj` in Xcode 16 or newer.
2. Select the **HomeyDeck** target, then **Signing & Capabilities**, and choose your **Team** (your Apple ID works).
3. If Xcode says the bundle identifier is taken, change `io.github.ounissidhiaeddine.homeydeck` to anything unique.
4. Pick **My Mac** or your iPhone as the run destination and press **Run**.
5. In the app, open **Settings** and fill in:
   - **Server:** your Worker URL and APP_KEY. Tap *Test connection*.
   - **Wake-on-LAN:** your DDNS hostname, the UDP port you forwarded, and the PC's MAC address. You can get the MAC by running `getmac /v` on the PC; use the *Physical Address* of the wired adapter.

On a Mac, HomeyDeck runs only while its window is open. Closing the window quits the app.

**iPhone signing:** with a free Apple ID, apps you install on an iPhone stop working after 7 days, and you reinstall from Xcode to renew them. A paid Apple Developer account ($99 a year) gives you 1-year builds, and you can also use TestFlight.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| App says *rejected your app key* | APP_KEY in the app doesn't match the server secret. |
| *Too many failed attempts* | 10 wrong keys from your IP. It clears by itself after 15 minutes. A misconfigured agent on the same network can also cause this, so check its log. |
| PC shows offline while it's on | Check `agent.log`. A 401 means the agent key is wrong. The agent retries with backoff of up to 1 minute. |
| Wake works away from home but not on home Wi-Fi | Your router may not support NAT loopback (sending to its own public address from inside). Try it on mobile data, or turn on "NAT loopback/hairpin" in the router. |
| Takes up to a minute to show offline after sleep | Expected. The server marks the PC offline when it misses status reports for 60 seconds. |
