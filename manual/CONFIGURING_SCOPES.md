# Configuring scopes

Back to the [README](../README.md) · [Manual](README.md)

## Ollama request stats (relay on port 11435)

Ollama only reports token speed and timings to the app that sent the request, so AI_SCOPE runs a small relay at **`http://127.0.0.1:11435`** that forwards everything to Ollama and records the stats on the way.
Apps that talk to Ollama directly (11434) still work normally, they just don't appear in the Requests table.

| Where | How |
|---|---|
| PowerShell | `$env:OLLAMA_HOST="127.0.0.1:11435"` then `ollama run qwen3.5:4b` |
| cmd | `set OLLAMA_HOST=127.0.0.1:11435` then `ollama run qwen3.5:4b` |
| Mac / Linux terminal | `export OLLAMA_HOST=127.0.0.1:11435` |
| VS Code (Continue, Cline, Copilot…) | In the extension's Ollama settings, change the address from `http://localhost:11434` to `http://127.0.0.1:11435` |
| Other apps / scripts | Ollama URL `http://127.0.0.1:11435` (or `.../v1` for OpenAI-style clients) |

The terminal settings apply to that window only. The same help, with **Copy** buttons, is behind the **?** in the Ollama scope's header and next to its Requests table. If Ollama answers requests that don't go through the relay, the Ollama scope shows an amber warning, so you know they weren't recorded.

## Scope settings (asked when installing)

| Scope | Settings |
|---|---|
| Bionic | Data folder (default `%USERPROFILE%\.lmstudio`, which LM Studio's Bionic uses), server URL (empty = try `:1234`, then `:1235`), models folder (empty = inside the data folder) |
| ComfyUI | URL (empty = try `:8188`, then `:8000`) |
| Ollama | URL (default `http://127.0.0.1:11434`), relay port (default `11435`) |
| Strata | Strata app URL (empty = `http://127.0.0.1:47831`, shown in Strata under *Connect Strata to an app*) |
| llama.cpp | Server URL (empty = try `:9931` for `llama serve`, then `:8080` for `llama-server`) |
