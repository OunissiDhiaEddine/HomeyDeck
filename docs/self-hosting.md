# Host your own HomeyDeck

This guide puts your own copy of HomeyDeck on your own free Vercel account. You don't need a terminal, and nothing asks for a credit card. It takes about 15 minutes, most of it in your router's settings.

Your copy is completely separate from anyone else's. Only you can create accounts on it. If you just want HomeyDeck for yourself, you never have to invite anyone.

**What you need**

- A Windows PC with a wired (Ethernet) connection. Wi-Fi cards usually can't be woken remotely.
- A free [GitHub](https://github.com/signup) account and a free [Vercel](https://vercel.com/signup) account. Sign up for Vercel with GitHub, so the two are already connected.
- Access to your router's settings page.

## 1. Deploy

You have two choices. Both give you the same app.

**Option A: the Deploy button (easiest).** Click it, and Vercel copies the app into a new repository in your GitHub account and deploys it.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FOunissiDhiaEddine%2FHomeyDeck%2Ftree%2Fmain%2Fweb&project-name=homeydeck&repository-name=homeydeck&env=ADMIN_USERNAME,ADMIN_PASSWORD&envDescription=The%20username%20and%20password%20for%20your%20HomeyDeck%20admin%20account&envLink=https%3A%2F%2Fgithub.com%2FOunissiDhiaEddine%2FHomeyDeck%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md%232-choose-your-admin-login)

**Option B: fork.** Choose this if you want to pull in future HomeyDeck updates with one click.

1. On the [HomeyDeck repository](https://github.com/OunissiDhiaEddine/HomeyDeck), click **Fork**, then **Create fork**.
2. In Vercel, click **Add New… → Project** and **Import** your fork.
3. Next to **Root Directory**, click **Edit**, choose **`web`**, and click **Continue**.
4. Open **Environment Variables** and add the two from step 2 below.
5. Click **Deploy**.

## 2. Choose your admin login

Vercel asks for two values (with a fork, you add them yourself as in Option B step 4):

| Name | Value |
|---|---|
| `ADMIN_USERNAME` | the username you'll sign in with: 3 to 32 letters, digits, `_` or `-` |
| `ADMIN_PASSWORD` | a strong password of at least 10 characters. Use your password manager's generator and save it there |

Your admin account is created the first time you sign in with these. After that you'll delete `ADMIN_PASSWORD` from Vercel (step 6), and HomeyDeck will remind you.

The first deploy works, but the app will say the server isn't set up yet. The next two steps fix that.

## 3. Add the database

HomeyDeck keeps a little state in Upstash Redis. The free plan is plenty and needs no card.

1. In your Vercel project, open the **Storage** tab.
2. Click **Create Database** (or **Browse Marketplace**), choose **Upstash for Redis**, and click **Continue**.
3. Pick the **Free** plan and a region close to you, name it `homeydeck`, and click **Create**.
4. When it asks which project to connect, choose your HomeyDeck project and click **Connect**. Vercel adds the database's settings to the project for you.

## 4. Add the encryption key

HomeyDeck encrypts each PC's MAC address and home address before saving them, using a key that only Vercel holds.

1. Open your site (the address Vercel shows on the project's page, like `homeydeck-abc.vercel.app`). The sign-in page shows **Finish setting up this server** with a freshly made `DATA_KEY`. Click **Copy**.
2. In Vercel, open **Settings → Environment Variables**, add `DATA_KEY` with that value, and click **Save**. Keep a copy in your password manager too: if it's lost, everyone has to re-enter their PCs' wake details.

## 5. Redeploy

Vercel only picks up new settings on a new deployment. Open the **Deployments** tab, click **⋯** on the top deployment, then **Redeploy**.

When it's done, open `https://<your-site>/api/health`. You should see `"database":true`, `"dataKey":true` and `"admin":true`.

## 6. Sign in

1. Open your site and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. In Vercel, go to **Settings → Environment Variables** and delete `ADMIN_PASSWORD`. Your account already exists, so it's no longer needed, and leaving it there is a risk.

To install HomeyDeck as an app:

- **iPhone or iPad**: open your site in Safari, tap **Share → Add to Home Screen**, and open it from there.
- **Mac**: open it in Safari and choose **File → Add to Dock**, or use Chrome's install button in the address bar.
- **Android**: open it in Chrome and tap **Install app**.

An app added to the Home Screen keeps its own sign-in, so sign in once more inside it.

## 7. Prepare the PC and router for Wake-on-LAN

Skip this if you only want status, Steam and sleep/restart, not Wake.

**On the PC**

1. In the BIOS/UEFI settings, turn on **Wake on LAN** (sometimes called "Power On by PCI-E" or "Resume by LAN").
2. In Windows, open **Device Manager → Network adapters**, double-click your Ethernet adapter, and:
   - on **Power Management**, tick **Allow this device to wake the computer** and **Only allow a magic packet to wake the computer**;
   - on **Advanced**, set **Wake on Magic Packet** to **Enabled**.
3. Turn off Fast startup: **Control Panel → Power Options → Choose what the power buttons do → Change settings that are currently unavailable**, then untick **Turn on fast startup**. Waking from a full shutdown is unreliable with it on.
4. Find the MAC address: **Settings → Network & internet → Ethernet**, under **Physical address (MAC)**.

**On the router**

1. Give the PC a fixed local IP (often called "DHCP reservation" or "static lease").
2. Forward a UDP port (for example `9`) to that IP. Some routers can't forward to a sleeping PC; if Wake doesn't work, forward the port to your network's broadcast address (like `192.168.1.255`) if the router allows it.
3. Set up dynamic DNS (DDNS) so your home has a stable name, like `myhome.ddns.net`. Many routers have this built in; otherwise use a free service such as No-IP or Duck DNS. If your home IP never changes, you can use the IP instead.

## 8. Add your PC

1. In HomeyDeck, tap **Add PC** (or the gear icon, then **Add PC**).
2. Enter a name, the MAC address, your DDNS name and the UDP port, then tap **Next**. You can leave the wake fields blank and add them later.
3. On the Windows PC, download `homeydeck-agent.exe` (the link is on that screen) and copy the pairing code shown in HomeyDeck. The easiest way is to open your site in a browser on the PC and click **Copy pairing code** there.
4. Double-click `homeydeck-agent.exe` and click **Yes**. If you didn't copy the code on the PC, it asks you to type it, like `homeydeck-abc.vercel.app/K7P2X-M9Q4T`.

The agent installs itself for your Windows user, starts hidden, and starts again whenever you sign in to Windows. HomeyDeck shows the PC as online within a few seconds. Turn on automatic sign-in in Windows if you want Steam ready right after waking the PC from a full shutdown.

Each account can have up to 3 PCs. To change that, add `MAX_PCS_PER_USER` in Vercel (`0` means no limit) and redeploy.

## Inviting people

Open the gear menu, then **Admin: invites and users**, and tap **New invite**. Send the code to the person; they open your site, tap **Have an invite code? Create an account**, and pick their own username and password. Each code works once.

There's no email, so if someone forgets their password, tap **Reset** next to their name. They get a temporary password and must choose a new one when they sign in.

Vercel's free Hobby plan is for personal, non-commercial use, so don't charge for access.

## Free plan limits

An always-on PC checks in every 30 seconds, which costs one Vercel function call and one Upstash command each time: about 86,000 of each a month. The free plans allow 1,000,000 function calls and 500,000 Upstash commands a month, so about 5 always-on PCs fit, and more if they sleep. Having the app open adds a little on top.

You can see your usage in Vercel under **Usage**, and in the Upstash console.

## Troubleshooting

| Problem | What to do |
|---|---|
| The sign-in page says the server isn't set up | Follow steps 3 to 5, and don't forget to redeploy. |
| "Wrong username or password" for the admin | Check `ADMIN_USERNAME` and `ADMIN_PASSWORD` in Vercel, redeploy, and try again. They only work until the account exists. |
| The PC stays offline | Make sure the agent is running: double-clicking `homeydeck-agent.exe` should offer to uninstall it. Check `%LOCALAPPDATA%\HomeyDeck\agent.log`. |
| The agent says the code is wrong or expired | Codes work once, for 10 minutes. Add the PC again for a new one. |
| Wake does nothing | Wake from the network usually only works over mobile data or from outside your home, unless your router supports NAT loopback. Recheck step 7, especially Fast startup and the port forward. |
| Lost the admin password | In the Upstash console, open the database's **Data Browser**, find the key `uname:<your admin name>` and delete it. Set `ADMIN_PASSWORD` in Vercel again, redeploy, and sign in: a new admin account is created. Your old PCs need pairing again. |

## Updating

- **Fork (Option B)**: on your fork's GitHub page, click **Sync fork → Update branch**. Vercel redeploys on its own.
- **Deploy button (Option A)**: your repository is a copy, so updates don't arrive by themselves. To update, copy the changed files from `web/` in the HomeyDeck repository into yours on GitHub, or deploy again with Option B and move your PCs over.

The Windows agent works with any HomeyDeck server. To update it, download the newest `homeydeck-agent.exe`, double-click it and click **Yes**. It stays paired.

## Removing HomeyDeck

- On the PC: **Settings → Apps → HomeyDeck agent → Uninstall**, or remove the PC in HomeyDeck and the agent uninstalls itself.
- In Vercel: **Settings → General → Delete Project**, and delete the Upstash database under **Storage**.
