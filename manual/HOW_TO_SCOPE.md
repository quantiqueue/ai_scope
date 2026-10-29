# How to scope

Back to the [README](../README.md) · [Manual](README.md)

## Supported scopes

| Scope | What it shows |
|---|---|
| **Hardware** (built in) | CPU, RAM, a GPU + VRAM + Power + PCIe tile per graphics card and a Disk tile per physical disk (active time, read / write speed), with 5-minute sparklines; GPU temperature, power draw / limit and PCIe bus traffic + link on NVIDIA cards |
| **Processes** (built in) | Your AI apps' own VRAM, GPU, CPU and RAM (AI processes), and the top 5 processes by CPU, RAM, I/O (read / write), and per graphics card GPU, VRAM and shared GPU memory, each with a 5-minute line per process |
| **Bionic** | LM Studio's Bionic: current request (live state, tok/s), loaded models, request history, installed models with VRAM fit |
| **Ollama** | Current request (live state, tok/s, thinking tokens), loaded models (GPU/CPU split), request history, installed models with VRAM fit |
| **ComfyUI** | Current job (step progress, speed, time left), run history with thumbnails, installed models (filter by type) |
| **Strata** | Current request (reading / thinking / answering, tok/s, prompt and context fill), loaded model (experts in VRAM, speculation), request history (reused prompt tokens, hit rate), installed models with Strata's own fit verdict |
| **llama.cpp** | A llama.cpp server (`llama serve` or `llama-server`): current request (tok/s, tokens, prompt, context), loaded models (quantization, size, context, slots, VRAM per card), installed models (a router's models folder), slots (busy / idle, context used), request history (estimated from the server's slots) |
| **Custom** | A custom scope is your own page made of lenses from any installed scope, e.g. ComfyUI's current job next to Strata's current request and your GPU tiles. |

- Click **+** to open the Scopes page. It has three sections: **Installable scopes** (install, settings, remove), **Built-in scopes** (Hardware, Processes) and **Custom scopes**. Click **Install** on a scope, check its settings (e.g. Bionic's data folder) and its tab is added. **Remove** takes the tab away and stops that scope; **Settings** changes an installed scope's settings. Click a scope to reopen a closed tab.
- Drag tabs to reorder them; close a tab with its **×**. Each browser remembers its own tabs and order.
- **While something runs**, each *Current request / Current job* card says what it's doing ("Running — reading prompt", "Running — sampling (+2 queued)") and shows a **System load** row (whole-computer GPU, VRAM, CPU and RAM). Where AI_SCOPE can find the app's own process, ComfyUI's *Current job* card shows a **ComfyUI process** row instead, and the Bionic, Ollama, Strata and llama.cpp *Current request* cards a **Bionic / Ollama / Strata / llama.cpp process** row: the GPU %, VRAM (per card), CPU and RAM used by the app's own process (for these, the process that runs the model: llama-server for Bionic and Ollama, strata.exe for Strata, llama.exe or llama-server.exe for llama.cpp). GPU and VRAM per process come from Windows' GPU performance counters, or on Linux from `nvidia-smi` (NVIDIA cards); macOS shows CPU and RAM only. On Linux and macOS an app running as another user (e.g. Ollama's Linux service) is found by its process name. Their *Loaded in memory* / *Loaded model* tables also show how much of the model sits on each graphics card. When idle it tells you the next step ("Load a model in Strata to see live stats.").
- The request and run tables have a **Peak load** column: the highest GPU % and VRAM while each one ran (hover for CPU and RAM too).
- On the **Bionic and Strata pages**, the same measurements also appear as **their own Hardware tiles** — GPU / VRAM / RAM / CPU / I/O for that app's processes, laid out like the Hardware scope's (see [App Hardware tiles](#app-hardware-tiles-hardware-mirror-lenses)).
- Model and publisher names link to their Hugging Face / Ollama / LM Studio catalog pages (opens a new tab).
- Request, run and installed-model tables show 5 rows per page (change it with the lens's cog: **Rows per page**, see [Lens settings](#lens-settings-cog)).
- Scopes are listed in **`scopes.json`** (name, description, icon, the server modules that collect its data, and the settings asked at install). Installed scopes and their settings are saved in `~/.ai_scope/installed.json`.

## Editing pages and lens settings

Every page can be rearranged: the built-in Hardware and Processes scopes, the app scopes (Bionic, Ollama, ComfyUI, Strata, llama.cpp) and your custom scopes.

- Click the **pencil** (top right of the page) to edit. While editing:
  - **+ Add lens** (top of the page) adds a lens at the top; the **+** on the left or right of a lens adds one right there. On a scope's own page the Add lens dialog offers that scope's lenses; on a custom scope it lists the lenses of every installed scope, grouped by scope. A lens can be added more than once.
  - **Drag** a lens by its grip to move it. A line shows where it will land: a vertical line puts it in that row, a horizontal line between rows starts a new row.
  - **×** removes a lens; the **cog** next to it opens the lens's settings (see below).
- **Save** with the save icon, or **Cancel**. Unsaved changes stay while you switch tabs, but are lost if the page reloads.
- On a scope's own page, **Reset to default** brings back its built-in layout. Until you save a page it shows that default, which on Hardware and Processes follows your graphics cards and disks; a saved page keeps its lenses (a card that's gone shows "GPU n not found").
- Saved pages are kept in `~/.ai_scope/scope-layouts.json` (scope pages) and `~/.ai_scope/custom-scopes.json` (custom scopes), so every browser and the app window see the same ones. Lenses added in a newer AI_SCOPE version don't appear on a page you saved: add them in edit mode, or Reset to default.

### Lens settings (cog)

The cog shows in edit mode, in each lens's edit bar. Every lens has:

- **Width**: Quarter, Half or Full of the page. The page is 4 columns wide (2 below about 1100 px, where Quarter shows as half; 1 on a phone).
- **Columns** (tables): show or hide each column; the first column always shows.

Some lenses also have:

- **Rows per page** (request, run and installed-model tables; default 5).
- **Show process stats** (the *Current request* / *Current job* cards): the app's process row, or System load (on by default).
- Their own settings, e.g. the Hardware GPU lens's card and GPU usage / VRAM / both, the Disk tile's disk, the Processes lenses' rows (per app or per process), graphics card and dwm.exe (see [Processes scope](#processes-scope)), and an app's Hardware tiles — the GPU tile's graphics card and GPU usage / VRAM, the RAM tile's Working / Committed (see [App Hardware tiles](#app-hardware-tiles-hardware-mirror-lenses)).

The change is saved with the page when you save.

## Hardware on each system

CPU and RAM tiles work everywhere. GPU and VRAM tiles come from `nvidia-smi` for NVIDIA cards (Windows and Linux) and from Windows' own counters for AMD and Intel cards on Windows; temperature, power draw and PCIe traffic / link are NVIDIA only. A Mac shows no GPU or Disk tiles yet. The **Power** tile per card charts the draw as a share of the card's power limit (watts on hover); cards that don't report power show it as not available. The **PCIe** tile charts bus traffic (RX / TX MB/s — model loads spike it) and names the card's link (current vs what it could use at most; current drops while a card is idle).

## App Hardware tiles (Hardware Mirror Lenses)

The **Bionic** and **Strata** pages carry a set of tiles that mirror the Hardware scope's measurement types, but measure **that app's own processes**: a **GPU** and **VRAM** tile per graphics card, **RAM (Working)** and **RAM (Committed)**, a **CPU** tile and an **I/O** tile. They read the same counters the Processes scope uses, from the process that runs the app's model plus its helpers (for a model in a child process, that child and its workers).

- These can differ from the **Hardware** scope by design: one measures the app, the other the whole card.
- The sub line says what the app is doing: "**Bionic Offline**", "**No Model Loaded**", "**Loading…**", "**Unloading…**", "**Load failed**" — during a load the tiles read 0 until the load's own processes are measurable, and an old sample shows the big number as **n/a** rather than a frozen last value. Hovering a tile's line shows both the app's and the Hardware scope's value at that time.
- Cog settings: the GPU tile's **Graphics card** and **Show** (GPU usage / VRAM), the RAM tile's **Show** (Working / Committed). Committed compares the app's committed memory against the PC's commit ceiling (the same ceiling the Hardware RAM tile can show), which is what runs out when a model won't fit — not free RAM.
- **Power and PCIe are not mirrored**: those are measurements of the card, not of a process. Other app scopes (Ollama, ComfyUI, llama.cpp) currently show their process numbers in the *Current request / Current job* card's process row.
- On a **custom scope** page you can place these tiles next to Hardware's. New tiles only appear on a page you haven't saved, or after **Reset to default**.

## Disk tiles (Hardware)

One **Disk** tile per physical disk, named like Task Manager ("Disk 1 (C:)"): **active time** (how busy the disk was) as the big number, read and write speed, and a 5-minute chart with a read line and a dashed write line, scaled to the busiest moment (hover for the values at a time). Read from Windows' disk counters every 2 s (Linux: `/proc/diskstats`; not on macOS yet). The request and run tables' **Peak load** hover also shows the highest disk read while each ran. Pick the disk with the lens's cog (edit mode).

## Processes scope

Built in. Read every 5 s while a Processes lens is on screen, every 30 s otherwise:

- **Windows**: the same numbers as Task Manager (its process list for CPU, RAM and I/O, its GPU performance counters for VRAM, GPU % and shared GPU memory).
- **Linux**: `/proc` for CPU, RAM and disk I/O; with an NVIDIA card, `nvidia-smi` for VRAM and GPU % per process. No shared GPU memory lenses; other users' processes show no I/O unless AI_SCOPE runs as root; GPU lenses for AMD / Intel cards aren't there yet.
- **macOS**: `ps` for CPU and RAM. macOS gives no per-process GPU numbers or I/O, so those lenses (and the AI processes lens's VRAM / GPU columns) are left out.

Lenses a system can't fill don't appear on the page or in the Add lens dialog. The sampler starts with AI_SCOPE and keeps running, so the lenses show numbers as soon as you open them (a few seconds after AI_SCOPE starts) and their 5-minute lines are already filled.

- **AI processes**: one row per installed AI scope (Bionic, Ollama, ComfyUI, Strata, llama.cpp) with the VRAM, GPU, CPU and RAM of its own process: the one that runs the model (Bionic, Ollama, Strata, llama.cpp) or ComfyUI's python. VRAM is all graphics cards added up and GPU the busiest card; hover for each card.
- **Top I/O**: the 5 processes reading and writing the most (MB/s, Read and Write columns) — shows which app is loading a model. On Windows this is *all* of a process's I/O (disk, network and devices together; a per-process disk-only number needs admin rights); on Linux it's disk reads and writes.
- **Top CPU, Top RAM, Top GPU, Top VRAM, Top shared GPU memory**: the 5 processes using the most, with the program's icon (Windows; a plain icon elsewhere), a 5-minute line (hover for the value at a time) and the value. Right after AI_SCOPE starts, the CPU, GPU and I/O lenses say *Measuring…* for a second or two. GPU, VRAM and shared GPU memory are per graphics card.
- **Cog** settings (edit mode, see [Lens settings](#lens-settings-cog)): **Rows** — per app (all processes of a program added together, e.g. "chrome.exe ×27") or per process; **Show the Windows desktop process (dwm.exe)** on the GPU lenses (Windows only) — off by default, because Windows counts the window surfaces dwm draws under dwm *and* under the app that made them, so its number is mostly other apps' memory again. For the same reason the VRAM rows can add up to more than the card's total on the Hardware page.
- Changes to the Processes page are saved with the page in `~/.ai_scope/scope-layouts.json`.

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
- **Edit** with the **pencil**, like any page (see [Editing pages and lens settings](#editing-pages-and-lens-settings)); the Add lens dialog lists the lenses of every installed scope. A new, empty custom scope opens in edit mode. There's no Reset to default.
- **Lens settings**: the **cog** in each lens's edit bar (see [Lens settings](#lens-settings-cog)).
- Each lens on a custom scope shows its scope as a chip (logo + name); click it to open that scope.
- **Rename** or **remove** a custom scope with its **Settings** / **Remove** on the Scopes page (removing it doesn't affect the scopes it borrows lenses from).
- Custom scopes are saved in `~/.ai_scope/custom-scopes.json`, so every browser and the app window see the same ones.
