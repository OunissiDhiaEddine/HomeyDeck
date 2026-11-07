HomeyDeck agents for Windows and Linux. Guide: [README](https://github.com/OunissiDhiaEddine/HomeyDeck#using-homeydeck).

**Windows** (`homeydeck-agent.exe`)

To install: in HomeyDeck, choose **Add PC** and copy the pairing code on the PC, then double-click `homeydeck-agent.exe` and click **Yes**. Without a copied code it asks you to type it.

To update: double-click the newer `homeydeck-agent.exe` and click **Yes**. It stays paired.

To remove: Windows **Settings → Apps → HomeyDeck agent → Uninstall**, double-click `homeydeck-agent.exe` again, or remove the PC in HomeyDeck. Each way deletes everything it saved.

**Linux, made for Bazzite** (`homeydeck-agent-linux`)

To install: in HomeyDeck, choose **Add PC** (or, on a dual-boot PC, open the PC's settings and choose **Dual boot? Add its other system**), tap **Copy Linux command** on the PC, and paste it into a terminal in Desktop Mode. It installs into your home folder only (no rpm-ostree layering, no root) and starts with a systemd user service at every sign-in, Game Mode included.

To update: paste this into a terminal. It stays paired.

```sh
f=$(mktemp) && curl -fsSLo "$f" https://github.com/OunissiDhiaEddine/HomeyDeck/releases/latest/download/homeydeck-agent-linux && chmod +x "$f" && "$f" install; rm -f "$f"
```

To remove: open **HomeyDeck agent** from the app menu and choose **Yes**, run `~/.local/share/homeydeck/homeydeck-agent uninstall`, or remove the PC in HomeyDeck. Each way deletes everything it saved.
