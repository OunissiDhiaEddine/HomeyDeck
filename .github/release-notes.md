Builds for HomeyDeck. Setup guide: [docs/setup.md](https://github.com/OunissiDhiaEddine/HomeyDeck/blob/main/docs/setup.md).

| File | What it is |
|---|---|
| `homeydeck-agent.exe` | Windows agent. Run `homeydeck-agent.exe install --server <url> --key <AGENT_KEY>` in PowerShell. |
| `HomeyDeck-macOS.zip` | Mac app (macOS 14+), ad-hoc signed. Unzip, move to Applications, then right-click → **Open** the first time (or run `xattr -cr /Applications/HomeyDeck.app`). |
| `HomeyDeck-iOS-unsigned.ipa` | iPhone app (iOS 17+), unsigned. Install with Sideloadly or AltStore using your Apple ID, or build from Xcode instead. |
