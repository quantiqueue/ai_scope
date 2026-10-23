#!/bin/sh
# AI_SCOPE installer for macOS and Linux.
#
#   curl -fsSL https://github.com/quantiqueue/ai_scope/releases/latest/download/install.sh | sh
#
# Installs to ~/.local/share/ai_scope (no sudo, nothing system-wide):
#   app/    the app (from the latest GitHub release)
#   node/   a private Node.js - only if this computer has no Node.js 18+
# and the command ~/.local/bin/ai_scope. Settings and history live in ~/.ai_scope.
# Run the same line again to update. Uninstall: ai_scope --uninstall
#
# Options (environment variables, e.g. `curl ... | AI_SCOPE_STARTUP=1 sh`):
#   AI_SCOPE_STARTUP=1        also start AI_SCOPE when you log in
#   AI_SCOPE_VERSION=v1.2.0   install a specific release instead of the latest
#   AI_SCOPE_TARBALL=path     install from a local ai_scope.tar.gz (testing)
#   AI_SCOPE_PRIVATE_NODE=1   always use a private Node.js, even if this computer has one
set -eu

REPO="${AI_SCOPE_REPO:-quantiqueue/ai_scope}"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ai_scope"
BIN_DIR="$HOME/.local/bin"
MIN_NODE=18

say()  { printf '  %s\n' "$*"; }
step() { printf '\033[36m> %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }; fetch_out() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO "$2" "$1"; }; fetch_out() { wget -qO- "$1"; }
else die "curl or wget is needed"; fi
command -v tar >/dev/null 2>&1 || die "tar is needed"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

printf '\n\033[36mAI_SCOPE installer\033[0m\n\n'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. download the app ---
step "Downloading AI_SCOPE"
if [ -n "${AI_SCOPE_TARBALL:-}" ]; then
  cp "$AI_SCOPE_TARBALL" "$TMP/app.tar.gz"; say "from $AI_SCOPE_TARBALL"
else
  if [ -n "${AI_SCOPE_VERSION:-}" ]; then URL="https://github.com/$REPO/releases/download/$AI_SCOPE_VERSION/ai_scope.tar.gz"
  else URL="https://github.com/$REPO/releases/latest/download/ai_scope.tar.gz"; fi
  say "$URL"
  fetch "$URL" "$TMP/app.tar.gz" || die "download failed"
fi
mkdir -p "$TMP/app"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/app"
[ -f "$TMP/app/bin/ai_scope.js" ] || die "the download doesn't look like AI_SCOPE"

# stop a running AI_SCOPE from this install
if command -v pkill >/dev/null 2>&1; then pkill -f "$ROOT/app/bin/ai_scope.js" 2>/dev/null && { say "Stopped the running AI_SCOPE."; sleep 1; } || true; fi

mkdir -p "$ROOT"
rm -rf "$ROOT/app"
mv "$TMP/app" "$ROOT/app"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/app/package.json" | head -n 1)"
say "Installed version $VERSION to $ROOT/app"

# --- 2. Node.js ---
step "Checking Node.js"
NODE=""
if [ "${AI_SCOPE_PRIVATE_NODE:-}" = "1" ]; then say "Using a private Node.js (AI_SCOPE_PRIVATE_NODE=1)"
elif command -v node >/dev/null 2>&1; then
  V="$(node -v 2>/dev/null | sed 's/^v//')"
  if [ "${V%%.*}" -ge "$MIN_NODE" ] 2>/dev/null; then NODE="$(command -v node)"; say "Using your Node.js $V ($NODE)"
  else say "Your Node.js $V is too old (needs $MIN_NODE+), using a private copy instead"; fi
fi
if [ -z "$NODE" ]; then
  if [ -x "$ROOT/node/bin/node" ]; then
    NODE="$ROOT/node/bin/node"; say "Using the private Node.js $("$NODE" -v) in $ROOT/node"
  else
    case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) die "unsupported system $(uname -s)" ;; esac
    case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
    # latest LTS: first entry in index.tab whose "lts" column isn't "-"
    NV="$(fetch_out https://nodejs.org/dist/index.tab | awk -F'\t' 'NR>1 && $10 != "-" { print $1; exit }')"
    [ -n "$NV" ] || die "could not find the current Node.js LTS version"
    FILE="node-$NV-$OS-$ARCH.tar.gz"
    say "Downloading Node.js $NV ($OS-$ARCH, about 55 MB)"
    fetch "https://nodejs.org/dist/$NV/$FILE" "$TMP/$FILE" || die "Node.js download failed"
    WANT="$(fetch_out "https://nodejs.org/dist/$NV/SHASUMS256.txt" | awk -v f="$FILE" '$2 == f { print $1 }')"
    [ -n "$WANT" ] && [ "$WANT" = "$(sha256 "$TMP/$FILE")" ] || die "Node.js download failed the checksum check - please try again"
    tar -xzf "$TMP/$FILE" -C "$TMP"
    rm -rf "$ROOT/node"; mkdir -p "$ROOT/node/bin"
    mv "$TMP/node-$NV-$OS-$ARCH/bin/node" "$ROOT/node/bin/node"
    NODE="$ROOT/node/bin/node"
    say "Saved to $ROOT/node (only AI_SCOPE uses it)"
  fi
fi

# --- 3. launcher ---
step "Adding the ai_scope command"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/ai_scope" <<LAUNCHER
#!/bin/sh
# AI_SCOPE launcher (created by install.sh). "ai_scope --help" for the options, "ai_scope --uninstall" to remove.
ROOT="$ROOT"
if [ "\${1:-}" = "--uninstall" ]; then exec sh "\$ROOT/app/install/uninstall.sh"; fi
NODE="\$ROOT/node/bin/node"
[ -x "\$NODE" ] || NODE="\$(command -v node || true)"
[ -n "\$NODE" ] || { echo "Node.js was not found. Run the AI_SCOPE installer again to get a private copy." >&2; exit 1; }
export AI_SCOPE_LAUNCHER="$BIN_DIR/ai_scope"
exec "\$NODE" "\$ROOT/app/bin/ai_scope.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/ai_scope"
say "$BIN_DIR/ai_scope"
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0; say "Note: $BIN_DIR is not on your PATH. Add this line to your ~/.zshrc or ~/.bashrc:"
     say "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# --- 4. optional: start at login ---
if [ "${AI_SCOPE_STARTUP:-}" = "1" ]; then
  step "Starting AI_SCOPE when you log in"
  "$BIN_DIR/ai_scope" --install-startup | sed 's/^/  /'
fi

CMD=ai_scope; [ "$ON_PATH" = 1 ] || CMD="$BIN_DIR/ai_scope"
printf '\n\033[32mAI_SCOPE %s is installed.\033[0m\n' "$VERSION"
say "Start it:   $CMD --open"
say "Options:    $CMD --help"
say "Uninstall:  $CMD --uninstall"
printf '\n'
