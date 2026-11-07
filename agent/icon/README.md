# Agent icon

The HomeyDeck logo, used by both agents.

- `homeydeck-agent.png` (256 px, rounded corners): embedded in the Linux agent, which installs it for its app menu entry and dialogs.
- `homeydeck.ico` (16 to 256 px): the Windows icon. `agent.rc` puts it in `../rsrc_windows_amd64.syso`, which `go build` links into `homeydeck-agent.exe` automatically.

To change the icon, replace both images, then rebuild the `.syso` from this folder with LLVM's resource compiler:

```sh
llvm-windres --target=pe-x86-64 -O coff agent.rc -o ../rsrc_windows_amd64.syso
```
