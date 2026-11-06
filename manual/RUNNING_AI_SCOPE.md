# Running AI_SCOPE

Back to the [README](../README.md) · [Manual](README.md)

## After installing

On **Windows** the installer also adds **AI_SCOPE** to the Start Menu, asks whether you want a desktop shortcut, and starts it right away. The shortcuts run AI_SCOPE in the background (no console window) and open the dashboard in its own app window (Edge or Chrome in app mode); opening the shortcut again just brings the window back.

The dashboard opens on its **Home** page (that's **Settings → General → Default Page**, changeable to any scope); from there, install the scopes you use on the Scopes page (**+**). In a browser it's at **http://localhost:9000** (`ai_scope --open` opens it for you).

- **Settings**: the **cog at the top right** opens the Settings dialog — **General** (Default Page), **Appearance** (theme), **Engine** (Process Refresh Rate: how often the per-process numbers behind the Processes lenses and the app process rows are read, 5 s by default; 2–60 s; while an installed app is up and has numbers to show, AI_SCOPE samples them at 2 s whatever this says), **Server** (Network Access, Start at login, Allowed host names, Stop / Restart) and **About**. Each section is a plain JSON file in the data folder, so the same settings serve every browser and the app window; only per-browser things like open tabs and their order live in the browser.
- **Update**: run the same install line again. Your settings, custom scopes and history are kept.
- **Uninstall**: `ai_scope --uninstall` (asks whether to keep your settings and history; also removes the shortcuts).
- **Stop**: **Settings → Server → Stop AI_SCOPE** (the cog at the top right; that section is only offered on this computer), run `ai_scope --stop`, or use **Quit AI_SCOPE** on the tray icon (Windows).
- **Start at login**: `ai_scope --install-startup`, or install with `$env:AI_SCOPE_STARTUP="1"` (Windows) / `curl ... | AI_SCOPE_STARTUP=1 sh`.
- **Desktop shortcut without the question** (Windows): install with `$env:AI_SCOPE_DESKTOP="1"` (or `"0"` for none).
- **Want to read the script first?** Download [install.ps1](https://github.com/quantiqueue/ai_scope/releases/latest/download/install.ps1) or [install.sh](https://github.com/quantiqueue/ai_scope/releases/latest/download/install.sh), look it over, then run it.

| Installed to | Windows | macOS / Linux |
|---|---|---|
| App (+ private Node.js if needed) | `%LOCALAPPDATA%\ai_scope` | `~/.local/share/ai_scope` |
| `ai_scope` command | `%LOCALAPPDATA%\ai_scope\bin` (added to your PATH) | `~/.local/bin/ai_scope` |
| Settings, custom scopes and history | `%USERPROFILE%\.ai_scope` | `~/.ai_scope` |

## Options

    ai_scope --app                # run in the background and open the dashboard in its own window
    ai_scope --stop               # stop AI_SCOPE running in the background
    ai_scope --open               # run in this console and open the dashboard in your browser
    ai_scope --port 9100          # use another port (default 9000)
    ai_scope --host 0.0.0.0       # also reachable from phones/PCs on your network
    ai_scope --data-dir D:\aiscope  # keep settings and history somewhere else
    ai_scope --install-startup    # start automatically when you log in
    ai_scope --uninstall-startup  # undo that
    ai_scope --help

Started without `--app`, AI_SCOPE runs in that console window: keep it open while you use it, and close it (or press **Ctrl+C**) to stop. With `--app` (and the Windows shortcuts) it runs in the background and writes its output to `ai_scope.log` in the data folder.

## System tray (Windows)

While an AI_SCOPE is running you'll have the **AI_SCOPE icon in the system tray** (by the clock; Windows often starts new tray icons hidden in the `^` overflow — drag it out once if you want it always in view). Clicking it opens a menu: the version and port on a read-only first line, then

- **Open App** — the same window the Start Menu shortcut opens (Edge or Chrome in app mode; if that window is already open the browser brings it forward), and
- **Quit AI_SCOPE** — stops the server, exactly like `ai_scope --stop`. Your app window stays open and the page shows that it can't reach AI_SCOPE; start it again from the shortcut or the command line and it reconnects.

The icon belongs to the running AI_SCOPE itself, so it appears however that was started — the shortcut, `ai_scope`, `ai_scope --app`, or the login item — and it goes away when that AI_SCOPE stops. Every running AI_SCOPE gets its own icon labelled with its port, so two of them (say 9000 and 9100) are easy to tell apart. Nothing to turn on or off: there's no tray setting. The tray is Windows only; on macOS and Linux nothing about starting or stopping changes.

By default only this computer can open the dashboard (`127.0.0.1`). With `--host 0.0.0.0` the console also prints the network address(es) to use from other devices. The same switch is in the Settings dialog (**Settings → Server → Network Access**), and a setting saved there wins over the launch flags from then on: **Network Access** turns it on or off and says whether a restart is owed (**Restart Now** in the same section); a `--host` flag only matters until you first touch that switch.

AI_SCOPE only answers when it's opened by this computer's own name or address (`localhost`, its network address, or its computer name such as `snow` / `snow.local`), so a malicious web page can't reach it through a look-alike name. Behind a reverse proxy or another host name, add the extra names under **Settings → Server → Allowed host names** (the cog at the top right, comma-separated, e.g. `dash.example.lan`) — they're saved in the data folder and apply right away. (The old `AI_SCOPE_ALLOWED_HOSTS` environment variable is gone; if you used it, type those names into this row once.)

`--install-startup` remembers the other flags you pass with it (e.g. `ai_scope --host 0.0.0.0 --install-startup`). On Windows it adds `ai_scope.cmd` to your Startup folder (opens a minimized *AI_SCOPE* window; close it to stop). On macOS it adds a LaunchAgent, on Linux a desktop autostart entry.
