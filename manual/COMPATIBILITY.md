# Compatibility

Back to the [README](../README.md) · [Manual](README.md)

AI_SCOPE isn't tied to particular app versions. It reads what the apps already offer (their APIs, logs and processes), so earlier and later versions than the ones below will most likely work too.

This page is not a list of supported versions. It records the app versions each AI_SCOPE release was **last checked with**: a known-good point to compare against if something stops working. Some of what AI_SCOPE reads isn't promised by the apps (Bionic's server-log lines, the Strata desktop app's monitor data, ComfyUI's log and queue endpoints, how Ollama and llama.cpp run their models in separate processes), so now and then an app update can change it and break part of a scope.

## AI_SCOPE 0.3.0

**Checked on:** Windows 11 Pro 24H2 (build 26100), NVIDIA GeForce RTX 5060 Ti + RTX 3060 Ti (driver 617.42), Node.js 18.8. Checked 2026-10-26.

| App | Last checked with | Notes |
|---|---|---|
| Bionic (LM Studio) | 1.1.9+6 | Its local server's API and its server logs (`~/.lmstudio/apps/bionic/server-logs`); the model runs in a child `llama-server`. |
| Ollama | 0.40.6 | Request stats through the AI_SCOPE relay ([Configuring Ollama](CONFIGURING_OLLAMA.md)); the model runs in a child `llama-server`. |
| ComfyUI | 0.42.1 (Comfy Desktop 1.1.8; Python 3.13, PyTorch 2.12.1 + CUDA 13.0) | Queue, history and log endpoints; the job runs in ComfyUI's own python process. |
| Strata | 0.2.1 (desktop app; Strata Control 0.1.46.2, engine 0.1.48) | The desktop app's monitor data at `http://127.0.0.1:47831`; the model runs in `strata.exe`. |
| llama.cpp | `llama` 0.7.0-dev (build b11706) | `llama serve`, including router mode and `--metrics`. Plain `llama-server` builds use the same API. |

**Linux and macOS:** checked in a Linux virtual machine and with simulated macOS system output.

## If a scope stops working after an app update

- Compare the app's version with the table above. If yours is newer, the update may have changed something AI_SCOPE reads.
- [Report it on GitHub](https://github.com/quantiqueue/ai_scope/issues) with the app and its version, your system, and what the scope shows.
- Sections for earlier AI_SCOPE releases stay on this page, so you can see what an older release was last checked with.
