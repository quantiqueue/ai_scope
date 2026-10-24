# How to scope

Back to the [README](README.md).

## Supported scopes

| Scope | What it shows |
|---|---|
| **Hardware** (built in) | CPU, RAM, a GPU + VRAM tile per graphics card and a Disk tile per physical disk (active time, read / write speed), with 5-minute sparklines; GPU temperature and power draw on NVIDIA cards |
| **Processes** (built in, Windows) | Your AI apps' own VRAM, GPU, CPU and RAM (AI processes), and the top 5 processes by CPU, RAM, I/O (read / write), and per graphics card GPU, VRAM and shared GPU memory, each with a 5-minute line per process |
| **Bionic** | LM Studio's Bionic: current request (live state, tok/s), loaded models, request history, installed models with VRAM fit |
| **Ollama** | Current request (live state, tok/s, thinking tokens), loaded models (GPU/CPU split), request history, installed models with VRAM fit |
| **ComfyUI** | Current job (step progress, speed, time left), run history with thumbnails, installed models (filter by type) |
| **Strata** | Current request (reading / thinking / answering, tok/s, prompt and context fill), loaded model (experts in VRAM, speculation), request history (reused prompt tokens, hit rate), installed models with Strata's own fit verdict |
| **llama.cpp** | A llama.cpp server (`llama serve` or `llama-server`): current request (tok/s, tokens, prompt, context), loaded models (quantization, size, context, slots, VRAM per card), installed models (a router's models folder), slots (busy / idle, context used), request history (estimated from the server's slots) |
| **Custom** | A custom scope is your own page made of lenses from any installed scope, e.g. ComfyUI's current job next to Strata's current request and your GPU tiles. |

- Click **+** to open the Scopes page. It has three sections: **Installable scopes** (install, settings, remove), **Built-in scopes** (Hardware, Processes) and **Custom scopes**. Click **Install** on a scope, check its settings (e.g. Bionic's data folder) and its tab is added. **Remove** takes the tab away and stops that scope; **Settings** changes an installed scope's settings. Click a scope to reopen a closed tab.
- Drag tabs to reorder them; close a tab with its **×**. Each browser remembers its own tabs and order.
- **While something runs**, each *Current request / Current job* card says what it's doing ("Running — reading prompt", "Running — sampling (+2 queued)") and shows a **System load** row (whole-computer GPU, VRAM, CPU and RAM). On Windows, ComfyUI's *Current job* card shows a **ComfyUI process** row instead, and the Bionic, Ollama, Strata and llama.cpp *Current request* cards a **Bionic / Ollama / Strata / llama.cpp process** row: the GPU %, VRAM (per card), CPU and RAM used by the app's own process (for these, the process that runs the model: llama-server for Bionic and Ollama, strata.exe for Strata, llama.exe or llama-server.exe for llama.cpp), read from Windows' GPU performance counters. Their *Loaded in memory* / *Loaded model* tables also show how much of the model sits on each graphics card. When idle it tells you the next step ("Load a model in Strata to see live stats.").
- The request and run tables have a **Peak load** column: the highest GPU % and VRAM while each one ran (hover for CPU and RAM too).
- Model and publisher names link to their Hugging Face / Ollama / LM Studio catalog pages (opens a new tab).
- Request, run and installed-model tables show 5 rows per page (change it with the lens's cog: Rows per page).
- Scopes are listed in **`scopes.json`** (name, description, icon, the server modules that collect its data, and the settings asked at install). Installed scopes and their settings are saved in `~/.ai_scope/installed.json`.

## Disk tiles (Hardware)

One **Disk** tile per physical disk, named like Task Manager ("Disk 1 (C:)"): **active time** (how busy the disk was) as the big number, read and write speed, and a 5-minute chart with a read line and a dashed write line, scaled to the busiest moment (hover for the values at a time). Read from Windows' disk counters every 2 s (Linux: `/proc/diskstats`). The request and run tables' **Peak load** hover also shows the highest disk read while each ran. In a custom scope, pick the disk with the lens's cog.

## Processes scope

Built in, Windows only for now. Read from Windows' performance counters (the same numbers as Task Manager), every 5 s, and only while a Processes lens is on screen.

- **AI processes**: one row per installed AI scope (Bionic, Ollama, ComfyUI, Strata) with the VRAM, GPU, CPU and RAM of its own process: the one that runs the model (Bionic, Ollama, Strata) or ComfyUI's python. VRAM is all graphics cards added up and GPU the busiest card; hover for each card.
- **Top I/O**: the 5 processes reading and writing the most (MB/s, Read and Write columns) — shows which app is loading a model. Windows counts *all* of a process's I/O here (disk, network and devices together); a per-process disk-only number needs admin rights.
- **Top CPU, Top RAM, Top GPU, Top VRAM, Top shared GPU memory**: the 5 processes using the most, with the program's icon, a 5-minute line (hover for the value at a time; kept while the page is open) and the value. GPU, VRAM and shared GPU memory are per graphics card.
- **Cog** settings: **Rows** — per app (all processes of a program added together, e.g. "chrome.exe ×27") or per process; **Show the Windows desktop process (dwm.exe)** on the GPU lenses — off by default, because Windows counts the window surfaces dwm draws under dwm *and* under the app that made them, so its number is mostly other apps' memory again. For the same reason the VRAM rows can add up to more than the card's total on the Hardware page.
- Settings chosen on the Processes page are saved in `~/.ai_scope/lens-settings.json`.

## llama.cpp scope

For a llama.cpp server: `llama serve -m <model.gguf>` (the `llama` launcher, port 9931) or a `llama-server` build (port 8080). Leave the URL empty to find either one. Router mode (`llama serve --models-dir <folder>`: every GGUF in the folder, loaded when a request names it) works too.

- AI_SCOPE reads the server's `/props` (model) and `/slots` (what each slot is doing) — every ½ s, and every ¼ s while a slot is busy. `/slots` is on by default; if the server was started with `--no-slots`, the scope can't see requests.
- llama.cpp keeps no timings of finished requests, so the **Requests** table is built from those looks: prompt, cached and output tokens are counted, while tok/s, first token and duration are estimates (marked ≈). Requests shorter than a look show as **quick** with only their total tokens.
- **Loaded in memory** shows the running model — in router mode every loaded one, each with its own VRAM per graphics card (each runs in its own process). **Installed models** lists a router's models folder (size, parameters, quantization, trained context, image / video input); for models that haven't been loaded yet, parameters and quantization come from the file name. AI_SCOPE reads a router's loaded models on their own ports and never asks about an unloaded one, because asking the router about a model makes it load that model.
- **Slots** shows each parallel slot (`--parallel`; in router mode, of every loaded model): busy or idle, its task, and how much of its context the conversation in it uses.
- **With `--metrics`** (start the server with it): a request that ran alone on its model gets **exact** generation speed, prompt speed, first token and duration from the server's own counters (no ≈); *Loaded in memory* gets a **Since load** column (tokens generated and average speed; prompt and cached tokens on hover); and *Current request* shows requests **waiting for a free slot**.
- Requests are saved in `~/.ai_scope/llamacpp-requests.jsonl`. Not supported yet: servers started with `--api-key` (the scope says the server needs a key).

## Custom scopes

A custom scope is your own page made of lenses from any installed scope, e.g. ComfyUI's current job next to Strata's current request and your GPU tiles.

- **Create**: Scopes page (**+**) → **Create Custom Scope**, give it a name. It opens as a new tab, ready to edit.
- **Edit**: click the **pencil** (top right of the page).
  - **+ Add lens** (top) adds a lens at the top of the page; the **+** on the left or right of a lens adds one right there. The Add lens dialog lists the lenses of every installed scope, grouped by scope.
  - **Drag** a lens by its grip to move it. A line shows where it will land: a vertical line puts it in that row, a horizontal line between rows starts a new row.
  - **×** removes a lens.
  - Save with the **save** icon, or **Cancel**. Unsaved changes stay while you switch tabs.
- **Lens settings**: lenses that have settings show a **cog** in the top-right corner of the lens (e.g. the GPU lens: which card, and GPU usage, VRAM or both). In edit mode the change is saved with the page; otherwise it's saved right away.
- Each lens on a custom scope shows its scope as a chip (logo + name); click it to open that scope.
- **Rename** or **remove** a custom scope with its **Settings** / **Remove** on the Scopes page (removing it doesn't affect the scopes it borrows lenses from).
- Custom scopes are saved in `~/.ai_scope/custom-scopes.json`, so every browser and the app window see the same ones.
