# Where the data comes from

Back to the [README](README.md).

| App | Source | Notes |
|---|---|---|
| Bionic | API of Bionic's local server at `http://127.0.0.1:1234` (or 1235) + its server logs in `%USERPROFILE%\.lmstudio\apps\bionic\server-logs` | Bionic's local server must be running (Local Server screen). Every app using it is recorded. Bionic doesn't report GPU offload. |
| Ollama | API at `http://127.0.0.1:11434` | Request stats only for apps that go through the AI_SCOPE relay — see [Configuring scopes](CONFIGURING_SCOPES.md#ollama-request-stats-relay-on-port-11435). |
| ComfyUI | API at `http://127.0.0.1:8188` (or 8000) | Runs are saved to `~/.ai_scope/comfy-runs.jsonl`. |
| Strata | The Strata desktop app at `http://127.0.0.1:47831` (its own monitor data) | The Strata app must be running. Requests are saved to `~/.ai_scope/strata-requests.jsonl`. |
| llama.cpp | The server's `/props`, `/models`, `/slots` and (with `--metrics`) `/metrics` at `http://127.0.0.1:9931` (`llama serve`) or `:8080` (`llama-server`) | Request history is estimated from the slots (llama.cpp keeps no per-request timings); exact for requests that ran alone when the server has `--metrics`. Requests are saved to `~/.ai_scope/llamacpp-requests.jsonl`. |
| Hardware | Node `os` + `nvidia-smi` (comes with the NVIDIA driver), or Windows GPU counters for AMD/Intel | GPU temperature and power are NVIDIA only. |
