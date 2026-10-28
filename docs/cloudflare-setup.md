# Cloudflare server setup

This guide sets up the HomeyDeck server from scratch on Cloudflare's free plan, from your own computer. It doesn't need GitHub Actions or any repository secrets. It takes about 15 minutes.

By the end you'll have:

- a server URL like `https://homeydeck.<your-subdomain>.workers.dev`
- an **APP_KEY**, which goes into the Mac/iPhone app
- an **AGENT_KEY**, which goes into the Windows agent

## What you need

- A Cloudflare account. The free plan is enough, and no card is needed.
- **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)). Check with `node -v`.
- This repository on your computer (`git clone https://github.com/OunissiDhiaEddine/HomeyDeck`).

## 1. Create a Cloudflare account

Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and verify your email. You don't need to add a website or domain. Skip that step if it's offered.

## 2. Choose your workers.dev subdomain

Every Cloudflare account gets one free subdomain, `<your-subdomain>.workers.dev`. Each Worker is served under it. HomeyDeck's Worker is called `homeydeck`, so its address will be `https://homeydeck.<your-subdomain>.workers.dev`.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), open **Workers & Pages** from the left sidebar (it may be grouped under **Compute**).
2. The first time you open it, Cloudflare asks you to pick a subdomain. Choose something you'll recognise. It applies to every Worker in your account.
3. To see or change it later, open **Workers & Pages** and select **Change** next to **Your subdomain**.

Give a new subdomain a few minutes before the URL resolves.

> If you change the subdomain later, your server URL changes too. You'll then need to update it in the app's Settings and re-run the agent's `install` command (step 8).

## 3. Generate the two keys

The app and the agent each need their own key. They must be **different** and **at least 32 characters** long, or the server refuses to work. Generate them with a secure random generator:

**macOS / Linux**

```sh
openssl rand -base64 48   # run once for APP_KEY
openssl rand -base64 48   # and again for AGENT_KEY
```

**Windows (PowerShell)**

```powershell
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Run it twice. Save both keys in your password manager now, labelled `HomeyDeck APP_KEY` and `HomeyDeck AGENT_KEY`. Cloudflare will hide them once they're set, so you can't read them back later.

## 4. Install the server's tools and sign in

```sh
cd server
npm install
npx wrangler login
```

`wrangler login` opens your browser. Approve the request, then come back to the terminal. To check which account you're signed in to:

```sh
npx wrangler whoami
```

## 5. Deploy the Worker

```sh
npx wrangler deploy
```

The first deploy creates the `homeydeck` Worker and its Durable Object, which is free on the SQLite-backed storage this project uses. At the end Wrangler prints your URL:

```
https://homeydeck.<your-subdomain>.workers.dev
```

Copy it. If Wrangler says you need to register a workers.dev subdomain first, go back to step 2.

## 6. Set the keys as Worker secrets

Secrets are stored encrypted by Cloudflare. They never appear in the code or the repo.

```sh
npx wrangler secret put APP_KEY     # paste the APP_KEY, press Enter
npx wrangler secret put AGENT_KEY   # paste the AGENT_KEY, press Enter
```

Each command updates the live Worker right away, so you don't need to deploy again. To confirm both are there (this shows names only, never values):

```sh
npx wrangler secret list
```

You can also see them in the dashboard under **Workers & Pages → homeydeck → Settings → Variables and Secrets**.

## 7. Check the server works

Replace the URL and key with yours.

**macOS / Linux**

```sh
curl https://homeydeck.<your-subdomain>.workers.dev/health
# {"ok":true}

curl -H "Authorization: Bearer <APP_KEY>" https://homeydeck.<your-subdomain>.workers.dev/api/status
# {"online":false,"steamRunning":false,...}   (online turns true once the agent is installed)
```

**Windows (PowerShell)**

```powershell
Invoke-RestMethod https://homeydeck.<your-subdomain>.workers.dev/health
Invoke-RestMethod https://homeydeck.<your-subdomain>.workers.dev/api/status -Headers @{ Authorization = "Bearer <APP_KEY>" }
```

| Response | Meaning |
|---|---|
| `{"ok":true}` from `/health` | The Worker is deployed. |
| `{"error":"server keys are not configured"}` | A secret is missing or shorter than 32 characters. Redo step 6. |
| `{"error":"unauthorized"}` | The key you sent doesn't match APP_KEY. |
| `{"error":"too many failed attempts, try again later"}` | 10 wrong keys from your IP address. It clears by itself after 15 minutes. |
| Can't resolve the host | The subdomain is new (wait a few minutes) or the URL has a typo. |

## 8. Put the keys into the app and the agent

**Mac / iPhone app:** open **Settings** (the gear icon), then:

- **Server:** paste the URL from step 5. `https://` is optional.
- **App key:** paste **APP_KEY**.
- Tap **Test connection**. It should say *Connected*. Then tap **Save**.

The key is stored in the device's Keychain. Set it once on each device.

**Windows agent:** in PowerShell (not as admin), in the folder with `homeydeck-agent.exe`:

```powershell
.\homeydeck-agent.exe install --server https://homeydeck.<your-subdomain>.workers.dev --key "<AGENT_KEY>"
```

Keep the quotes around the key. Within a few seconds `/api/status` should show `"online":true`, and the app should show the PC as online. See [setup.md](setup.md#3-install-the-agent-on-the-pc) for more on the agent.

## Changing or rotating a key

If a key may have leaked, or you just want new ones:

1. Generate a new key (step 3).
2. Set it: `npx wrangler secret put APP_KEY` (or `AGENT_KEY`). The old key stops working immediately.
3. Update where it's used:
   - **APP_KEY:** paste the new key into Settings on every Mac and iPhone.
   - **AGENT_KEY:** on the PC, run the `install` command from step 8 again with the new `--key`.

## Updating the server

After pulling new code:

```sh
cd server
npm install
npx wrangler deploy
```

Secrets stay as they are across deploys.

## Watching what the server does

```sh
npx wrangler tail
```

This streams live requests and errors until you press Ctrl+C. It's useful to watch while you press buttons in the app or start the agent.

## Optional: deploy from GitHub instead

`.github/workflows/deploy-server.yml` can deploy for you on every push to `main`. It needs four repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_KEY`, `AGENT_KEY`). When they aren't set, the workflow skips with a warning and doesn't fail, so you can ignore it if you deploy by hand.

If you've used it before and want to stop:

1. Delete the four secrets under the repo's **Settings → Secrets and variables → Actions**.
2. Revoke the Cloudflare API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).

The Worker and its secrets stay on Cloudflare, so nothing stops working.

## Free plan limits

Workers and Durable Objects each allow 100,000 requests a day on the free plan. The agent uses a few hundred a day. The app checks every 5 seconds while it's open and less often in the background, so one person's use stays far below the limit.
