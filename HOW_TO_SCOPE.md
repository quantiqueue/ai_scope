# How to scope

Back to the [README](README.md).

## Supported scopes

| Scope | What it shows |
|---|---|
| **Hardware** (built in) | CPU, RAM, and a GPU + VRAM tile per graphics card, with 5-minute sparklines; GPU temperature and power draw on NVIDIA cards |
| **Bionic** | LM Studio's Bionic: current request (live state, tok/s), loaded models, request history, installed models with VRAM fit |
| **Ollama** | Current request (live state, tok/s, thinking tokens), loaded models (GPU/CPU split), request history, installed models with VRAM fit |
| **ComfyUI** | Current job (step progress, speed, time left), run history with thumbnails, installed models (filter by type) |
| **Strata** | Current request (reading / thinking / answering, tok/s, prompt and context fill), loaded model (experts in VRAM, speculation), request history (reused prompt tokens, hit rate), installed models with Strata's own fit verdict |
| **Custom** | A custom scope is your own page made of lenses from any installed scope, e.g. ComfyUI's current job next to Strata's current request and your GPU tiles. |

- Click **+** to open the Scopes page. It has three sections: **Installable scopes** (install, settings, remove), **Built-in scopes** (Hardware) and **Custom scopes**. Click **Install** on a scope, check its settings (e.g. Bionic's data folder) and its tab is added. **Remove** takes the tab away and stops that scope; **Settings** changes an installed scope's settings. Click a scope to reopen a closed tab.
- Drag tabs to reorder them; close a tab with its **×**. Each browser remembers its own tabs and order.
- **While something runs**, each *Current request / Current job* card says what it's doing ("Running — reading prompt", "Running — sampling (+2 queued)") and shows a **System load** row (whole-computer GPU, VRAM, CPU and RAM). On Windows, ComfyUI's *Current job* card shows a **ComfyUI process** row instead: the GPU %, VRAM (per card), CPU and RAM used by ComfyUI's own process, read from Windows' GPU performance counters. When idle it tells you the next step ("Load a model in Strata to see live stats.").
- The request and run tables have a **Peak load** column: the highest GPU % and VRAM while each one ran (hover for CPU and RAM too).
- Model and publisher names link to their Hugging Face / Ollama / LM Studio catalog pages (opens a new tab).
- Tables page by 15.
- Scopes are listed in **`scopes.json`** (name, description, icon, the server modules that collect its data, and the settings asked at install). Installed scopes and their settings are saved in `~/.ai_scope/installed.json`.

## Custom scopes

A custom scope is your own page made of lenses from any installed scope, e.g. ComfyUI's current job next to Strata's current request and your GPU tiles.

- **Create**: Scopes page (**+**) → **Create Custom Scope**, give it a name. It opens as a new tab, ready to edit.
- **Edit**: click the **pencil** (top right of the page).
  - **+ Add lens** (top) adds a lens at the top of the page; the **+** on the left or right of a lens adds one right there. The Add lens dialog lists the lenses of every installed scope, grouped by scope.
  - **Drag** a lens by its grip to move it. A line shows where it will land: a vertical line puts it in that row, a horizontal line between rows starts a new row.
  - **Gear**: lens settings (the GPU lens: which card, and GPU usage, VRAM or both). **×** removes a lens.
  - Save with the **save** icon, or **Cancel**. Unsaved changes stay while you switch tabs.
- Each lens on a custom scope shows its scope as a chip (logo + name); click it to open that scope.
- **Rename** or **remove** a custom scope with its **Settings** / **Remove** on the Scopes page (removing it doesn't affect the scopes it borrows lenses from).
- Custom scopes are saved in `~/.ai_scope/custom-scopes.json`, so every browser and the app window see the same ones.
