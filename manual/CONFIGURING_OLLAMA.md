# Configuring Ollama (the request stats relay)

Back to the [README](../README.md) · [Manual](README.md)

## Why a relay

Ollama reports token speed, token counts and load time only to the app that sent the request, so AI_SCOPE can't see them by asking Ollama. Instead, AI_SCOPE runs a small **relay** at **`http://127.0.0.1:11435`**: it forwards every request to Ollama (`http://127.0.0.1:11434`) and records the stats on the way.

- Apps pointed at the relay work exactly as before, and their requests appear in the Ollama scope's **Requests** table and *Current request* card.
- Apps that talk to Ollama directly (`11434`) still work normally; they just aren't recorded.
- The rest of the Ollama scope (loaded models, installed models) comes from Ollama itself and works without the relay.

## Quick start

Point the app at **`http://127.0.0.1:11435`** instead of `http://localhost:11434`. That's all.

## Setting it up

| Where | How |
|---|---|
| PowerShell | `$env:OLLAMA_HOST="127.0.0.1:11435"` then `ollama run qwen3.5:4b` |
| cmd | `set OLLAMA_HOST=127.0.0.1:11435` then `ollama run qwen3.5:4b` |
| macOS / Linux terminal | `export OLLAMA_HOST=127.0.0.1:11435` then `ollama run qwen3.5:4b` |
| VS Code (Continue, Cline, Copilot, …) | In the extension's Ollama settings, change the address / API base from `http://localhost:11434` to `http://127.0.0.1:11435` |
| Other apps and scripts | Ollama URL `http://127.0.0.1:11435`, or `http://127.0.0.1:11435/v1` for OpenAI-style clients |

The terminal lines apply to that window only. The same list, with **Copy** buttons, is behind the **?** in the Ollama scope's header and next to its Requests table.

## Making it permanent

`OLLAMA_HOST` is read by the `ollama` command **and by the Ollama server itself** (it's the address the server listens on). So set it only where you run commands, not for your whole account:

- **PowerShell**: add `$env:OLLAMA_HOST="127.0.0.1:11435"` to your profile (`notepad $PROFILE`). New PowerShell windows use the relay; the Ollama app isn't affected.
- **macOS / Linux**: add `export OLLAMA_HOST=127.0.0.1:11435` to `~/.zshrc` or `~/.bashrc`. Don't start `ollama serve` from such a shell (it would try to listen on 11435, the relay's port); the Ollama app is started outside your shell and isn't affected.
- **Avoid `setx OLLAMA_HOST …` (Windows) and system-wide variables**: the Ollama app would pick it up the next time it starts and try to listen on 11435. If you've set it that way, remove it in PowerShell with `[Environment]::SetEnvironmentVariable('OLLAMA_HOST', $null, 'User')` and restart Ollama.

Either way: **while AI_SCOPE isn't running, nothing answers on 11435**, so `ollama run` in those windows fails with a connection error. Start AI_SCOPE, or clear the variable for that window (`Remove-Item Env:OLLAMA_HOST` in PowerShell, `unset OLLAMA_HOST` in macOS / Linux shells).

## Checking it works

- Send a request through the relay (e.g. `ollama run qwen3.5:4b "hi"` in a window set up as above). It shows on the *Current request* card while it runs and then in the **Requests** table.
- The Ollama scope's header says whether the relay is listening (e.g. "proxy on :11435").
- If Ollama answers a request that didn't go through the relay, the Ollama scope shows an **amber warning** on the *Current request* card and above the Requests table ("… didn't go through the AI_SCOPE relay, so it isn't recorded"), with a link to the setup help. It's spotted from Ollama loading a model or keeping it loaded longer without a request passing through the relay, so it shows for 15 minutes or until a request comes through the relay again.

## What can't be recorded

- **The Ollama app's own chat window** always talks to `11434` directly.
- **OpenAI-style requests** (`/v1/...`): token counts and generation speed are recorded, but not prompt speed or load time (Ollama doesn't report them on that API).
- **Requests running while AI_SCOPE restarts** are lost or incomplete.
- **Other devices**: the relay only listens on this PC (`127.0.0.1`), so apps on other computers or phones can't use it, even when AI_SCOPE itself is opened with `--host 0.0.0.0`.

## Settings

Set when installing the Ollama scope (Scopes page → Ollama → **Settings** to change them later):

| Setting | Default | Notes |
|---|---|---|
| URL | `http://127.0.0.1:11434` | Where Ollama runs; the relay forwards to it. |
| Relay port | `11435` | Change it if something else uses 11435, then use the new port in your apps. |

Requests recorded through the relay are saved in `~/.ai_scope/ollama-requests.jsonl`.

## Troubleshooting

- **"The AI_SCOPE proxy could not start: port 11435 already in use"**: another program (or a second AI_SCOPE) uses the port. Close it, or pick another relay port in the Ollama scope's Settings.
- **No requests listed**: the app isn't using the relay. Check its Ollama address (`11435`, not `11434`), and in a terminal that `OLLAMA_HOST` is set in *that* window.
- **`set OLLAMA_HOST=…` does nothing in PowerShell**: `set` is the cmd syntax; in PowerShell use `$env:OLLAMA_HOST="127.0.0.1:11435"`.
- **`ollama` commands fail with a connection error**: AI_SCOPE isn't running (nothing on 11435). Start it, or clear `OLLAMA_HOST` for that window (see [Making it permanent](#making-it-permanent)).
- **Ollama runs on another computer or port**: set the Ollama scope's URL to it; your apps still point at the relay on this PC.
