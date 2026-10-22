# App logos (fallback copies)

AI_SCOPE shows each app's logo on its tab, on the Scopes page and on custom-scope chips. It reads the logo from the
app's own install folder at runtime (`logos.js`); the files here are only used when that isn't possible (app not
installed on this PC, moved, or a new version stores it differently). The logos belong to their projects and are
used only to show which app a scope watches.

| File | App | Copied from (Windows, 2026-10-22) |
|---|---|---|
| `ollama.png` | Ollama | `%LOCALAPPDATA%\Programs\Ollama\app.ico` (largest PNG image) |
| `lmstudio.png` | LM Studio | `%LOCALAPPDATA%\Programs\Bionic\resources\icon.ico` (largest PNG image) |
| `comfyui.png` | ComfyUI (Comfy Desktop) | `%LOCALAPPDATA%\Programs\Comfy Desktop\resources\app.asar` → `assets/Comfy_Logo_x256.png` |
| `strata-light.svg` | Strata (for light backgrounds) | `%LOCALAPPDATA%\Programs\Strata\host\dist\brand\strata-mark-light.svg` (metadata block removed) |
| `strata-dark.svg` | Strata (for dark backgrounds) | `%LOCALAPPDATA%\Programs\Strata\host\dist\brand\strata-mark-dark.svg` (metadata block removed) |

To refresh them, extract the logos the same way `logos.js` does and replace the files.
