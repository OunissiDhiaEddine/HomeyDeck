# HomeyDeck for Steam Deck (Decky Loader)

The HomeyDeck app in the Steam Deck's Quick Access menu (the `···` button), so you can wake your gaming PC and check it before starting Remote Play, without leaving Game Mode.

It shows the same screen as the HomeyDeck app: the PC's status, whether Steam and Sunshine are running, **Launch** for Steam, and **Wake**, **Sleep** and **Restart**. With more than one PC, a picker at the top switches between them.

It signs in to your existing HomeyDeck server with your usual username and password. Creating an account, adding and pairing PCs, wake settings, invites and admin stay in the HomeyDeck app.

## Install

1. Install [Decky Loader](https://decky.xyz) on the Steam Deck if you haven't.
2. Open the Quick Access menu → Decky (the plug icon) → the gear → **General**, and turn on **Developer mode**.
3. In the new **Developer** tab, choose **Install Plugin from URL** and enter
   `https://github.com/OunissiDhiaEddine/HomeyDeck/releases/download/decky-v0.1.0/HomeyDeck.zip`
   (or download `HomeyDeck.zip` from the [releases](https://github.com/OunissiDhiaEddine/HomeyDeck/releases) and use **Install Plugin from ZIP File**).
4. Open **HomeyDeck** in the Decky list and sign in. The server is `homeydeck.vercel.app` unless you host your own.

To update, install the newer zip the same way. To remove it, use Decky's plugin list.

## How it works

- `main.py` is the plugin's Python side. It makes the same HTTPS calls as the web app (`/api/session`, `/api/status`, `/api/command`) using only Python's standard library, and keeps the session cookie in Decky's settings folder for this plugin (`~/homebrew/settings/HomeyDeck/settings.json`, readable only by you). Signing out deletes it.
- `src/index.tsx` is the Quick Access panel. It never sees the cookie. It checks the PC every 4 seconds for 90 seconds after you open it or press something, then every 30 seconds, and stops when the menu closes.
- Nothing on the server or the agents changes for the plugin. It is one more signed-in device, like a phone.

## Develop

```sh
cd decky
npm install
npm run build        # dist/index.js
npm run typecheck
npm test             # runs main.py against web/scripts/dev.js (needs node and redis-server)
./package.sh         # out/HomeyDeck.zip, the file Decky installs
```

The **Decky plugin** GitHub workflow builds and tests it on every change under `decky/`. Run it by hand with a tag like `decky-v0.1.0` to publish the zip as a release. That release is never marked "latest", so the agents' download links keep pointing at the agent release.
