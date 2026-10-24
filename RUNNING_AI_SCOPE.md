# Running AI_SCOPE

Back to the [README](README.md).

## After installing

On **Windows** the installer also adds **AI_SCOPE** to the Start Menu, asks whether you want a desktop shortcut, and starts it right away. The shortcuts run AI_SCOPE in the background (no console window) and open the dashboard in its own app window (Edge or Chrome in app mode); opening the shortcut again just brings the window back.

The dashboard opens on its **Home** page; from there, install the scopes you use on the Scopes page (**+**). In a browser it's at **http://localhost:9000** (`ai_scope --open` opens it for you).

- **Update**: run the same install line again. Your settings, custom scopes and history are kept.
- **Uninstall**: `ai_scope --uninstall` (asks whether to keep your settings and history; also removes the shortcuts).
- **Stop**: click **Stop AI_SCOPE** on the Scopes page (shown on this computer only), or run `ai_scope --stop`.
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

By default only this computer can open the dashboard (`127.0.0.1`). With `--host 0.0.0.0` the console also prints the network address(es) to use from other devices.

AI_SCOPE only answers when it's opened by this computer's own name or address (`localhost`, its network address, or its computer name such as `snow` / `snow.local`), so a malicious web page can't reach it through a look-alike name. Behind a reverse proxy or another host name, list the extra names in `AI_SCOPE_ALLOWED_HOSTS` (comma-separated), e.g. `AI_SCOPE_ALLOWED_HOSTS=dash.example.lan`.

`--install-startup` remembers the other flags you pass with it (e.g. `ai_scope --host 0.0.0.0 --install-startup`). On Windows it adds `ai_scope.cmd` to your Startup folder (opens a minimized *AI_SCOPE* window; close it to stop). On macOS it adds a LaunchAgent, on Linux a desktop autostart entry.
