# Configuring scopes

Back to the [README](../README.md) · [Manual](README.md)

## Ollama request stats (relay on port 11435)

Ollama reports token speed and timings only to the app that sent the request, so AI_SCOPE records them through a small relay at **`http://127.0.0.1:11435`**: point your apps there instead of `11434`. Setup for each tool, making it permanent, checking it works and troubleshooting: **[Configuring Ollama](CONFIGURING_OLLAMA.md)**.

## Scope settings (asked when installing)

| Scope | Settings |
|---|---|
| Bionic | Data folder (default `%USERPROFILE%\.lmstudio`, which LM Studio's Bionic uses), server URL (empty = try `:1234`, then `:1235`), models folder (empty = inside the data folder) |
| ComfyUI | URL (empty = try `:8188`, then `:8000`) |
| Ollama | URL (default `http://127.0.0.1:11434`), relay port (default `11435`) |
| Strata | Strata app URL (empty = `http://127.0.0.1:47831`, shown in Strata under *Connect Strata to an app*); **Strata source** (Auto / Strata app only / Strata CLI only - Auto reads the desktop app when it is running and falls back to a headless `strata launch`); Strata CLI URL (empty = the port from Strata's own launch profile and runtime files, else `http://127.0.0.1:8080` - set it when you launch with `--port` or on another address); Strata API key (optional, only for a launch that has one - a LAN or tunnel launch gets a key by default, a plain `127.0.0.1` launch has none. It is sent as `Authorization: Bearer` to that server's `/metrics` and `/v1/status`, and AI_SCOPE never reads a key out of Strata's own files. Like llama.cpp's key it is a **secret** field: stored server-side only, the page and `/api/scopes` show just "set") |
| llama.cpp | Server URL (empty = try `:9931` for `llama serve`, then `:8080` for `llama-server`), API key (optional; sent as `Authorization: Bearer` for a server started with `--api-key`; an **API key** is a secret field - stored server-side only, the page and `/api/scopes` show just "set", never the value), Models folder (optional; the folder given to `--models-dir` when the server runs on this PC - AI_SCOPE reads each unloaded router model's GGUF file there for its size, fit and Hugging Face link; ignored for a remote server) |
