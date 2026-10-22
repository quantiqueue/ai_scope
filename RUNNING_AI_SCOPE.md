# Running AI_SCOPE

Back to the [README](README.md).

## After installing

On **Windows** the installer also adds **AI_SCOPE** to the Start Menu, asks whether you want a desktop shortcut, and starts it right away. The shortcuts run AI_SCOPE in the background (no console window) and open the dashboard in its own app window (Edge or Chrome in app mode); opening the shortcut again just brings the window back.

The dashboard opens on its **Home** page; from there, install the scopes you use on the Scopes page (**+**). In a browser it's at **http://localhost:9000** (`ai-scope --open` opens it for you).

- **Update**: run the same install line again. Your settings, custom scopes and history are kept.
- **Uninstall**: `ai-scope --uninstall` (asks whether to keep your settings and history; also removes the shortcuts).
- **Stop**: click **Stop AI_SCOPE** on the Scopes page (shown on this computer only), or run `ai-scope --stop`.
- **Start at login**: `ai-scope --install-startup`, or install with `$env:AI_SCOPE_STARTUP="1"` (Windows) / `curl ... | AI_SCOPE_STARTUP=1 sh`.
- **Desktop shortcut without the question** (Windows): install with `$env:AI_SCOPE_DESKTOP="1"` (or `"0"` for none).
- **Want to read the script first?** Download [install.ps1](https://github.com/quantiqueue/ai_scope/releases/latest/download/install.ps1) or [install.sh](https://github.com/quantiqueue/ai_scope/releases/latest/download/install.sh), look it over, then run it.

| Installed to | Windows | macOS / Linux |
|---|---|---|
| App (+ private Node.js if needed) | `%LOCALAPPDATA%\ai-scope` | `~/.local/share/ai-scope` |
| `ai-scope` command | `%LOCALAPPDATA%\ai-scope\bin` (added to your PATH) | `~/.local/bin/ai-scope` |
| Settings, custom scopes and history | `%USERPROFILE%\.ai_scope` | `~/.ai_scope` |

## Options

    ai-scope --app                # run in the background and open the dashboard in its own window
    ai-scope --stop               # stop AI_SCOPE running in the background
    ai-scope --open               # run in this console and open the dashboard in your browser
    ai-scope --port 9100          # use another port (default 9000)
    ai-scope --host 0.0.0.0       # also reachable from phones/PCs on your network
    ai-scope --data-dir D:\aiscope  # keep settings and history somewhere else
    ai-scope --install-startup    # start automatically when you log in
    ai-scope --uninstall-startup  # undo that
    ai-scope --help

Started without `--app`, AI_SCOPE runs in that console window: keep it open while you use it, and close it (or press **Ctrl+C**) to stop. With `--app` (and the Windows shortcuts) it runs in the background and writes its output to `ai-scope.log` in the data folder.

By default only this computer can open the dashboard (`127.0.0.1`). With `--host 0.0.0.0` the console also prints the network address(es) to use from other devices.

`--install-startup` remembers the other flags you pass with it (e.g. `ai-scope --host 0.0.0.0 --install-startup`). On Windows it adds `ai-scope.cmd` to your Startup folder (opens a minimized *AI_SCOPE* window; close it to stop). On macOS it adds a LaunchAgent, on Linux a desktop autostart entry.
