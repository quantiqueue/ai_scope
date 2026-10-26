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
| Strata | Strata app URL (empty = `http://127.0.0.1:47831`, shown in Strata under *Connect Strata to an app*) |
| llama.cpp | Server URL (empty = try `:9931` for `llama serve`, then `:8080` for `llama-server`) |
