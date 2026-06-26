#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the local KeyHive environment, install the minimum runtime pieces,
# and hand off to the interactive Python installer once the basics are ready.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_DIR/.venv"
REQ_FILE="$SCRIPT_DIR/requirements.txt"

color() {
  if [ -t 1 ]; then printf '\033[%sm' "$1"; fi
}

reset() {
  if [ -t 1 ]; then printf '\033[0m'; fi
}

info() {
  printf "%s==>%s %s\n" "$(color 36)" "$(reset)" "$*"
}

warn() {
  printf "%sWARN%s %s\n" "$(color 33)" "$(reset)" "$*" >&2
}

die() {
  printf "%sERR %s %s\n" "$(color 31)" "$(reset)" "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

ensure_node_command() {
  # Debian-derived hosts often provide `nodejs` but not `node`. The rest of the
  # setup expects `node`, so create the compatibility symlink when possible.
  if have node || ! have nodejs; then
    return
  fi

  local nodejs_path
  nodejs_path="$(command -v nodejs)"
  if [ "$(id -u)" -eq 0 ]; then
    ln -sf "$nodejs_path" /usr/local/bin/node
  elif have sudo; then
    sudo ln -sf "$nodejs_path" /usr/local/bin/node
  else
    warn "nodejs is installed but node is missing, and sudo is unavailable."
    warn "Install a node binary or add a node symlink before rerunning the installer."
    return 1
  fi
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    return 1
  fi
}

install_base_packages() {
  # On Debian-like hosts this fills in the obvious runtime gaps. On other hosts
  # it just gets out of the way instead of trying to be clever.
  if ! have apt-get; then
    return
  fi

  missing=()
  for cmd in python3 curl git node npm; do
    have "$cmd" || missing+=("$cmd")
  done

  if ! python3 -m venv --help >/dev/null 2>&1; then
    missing+=("python3-venv")
  fi

  if [ "${#missing[@]}" -eq 0 ]; then
    return
  fi

  if [ "$(id -u)" -ne 0 ] && ! have sudo; then
    warn "Missing runtime packages (${missing[*]}) and sudo is unavailable."
    return
  fi

  info "Installing base system packages"
  run_privileged apt-get update
  run_privileged apt-get install -y \
    ca-certificates \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    nodejs \
    npm \
    psmisc

  ensure_node_command
}

main() {
  cd "$PROJECT_DIR"

  # Python is the only hard requirement at this stage; everything else can be
  # installed or skipped by the guided installer.
  have python3 || die "python3 is required"
  install_base_packages
  ensure_node_command

  if [ ! -d "$VENV_DIR" ]; then
    info "Creating Python virtual environment"
    python3 -m venv "$VENV_DIR"
  fi

  info "Installing Python requirements"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install -r "$REQ_FILE"

  info "Launching guided installer"
  exec "$VENV_DIR/bin/python" "$SCRIPT_DIR/installer.py"
}

main "$@"
