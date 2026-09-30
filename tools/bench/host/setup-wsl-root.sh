#!/usr/bin/env bash
# HOST-BENCH: the part of the laptop setup that needs root.
# docs/runbooks/laptop-host-bench.md, Part 0 step 0.9. The OPERATOR runs it once,
# inside WSL Ubuntu, from the repository root, and types the sudo password:
#
#   sudo bash tools/bench/host/setup-wsl-root.sh
#
# What it does (each step is skipped when already done):
#   1. turns systemd on in /etc/wsl.conf ([boot] systemd=true), if it is off;
#   2. installs the base packages: git, curl, jq, python3-venv, sysstat
#      (iostat), zstd, tmux, gh, build tools;
#   3. installs Docker Engine (docker-ce) from Docker's own apt repository,
#      inside WSL. This is NOT Docker Desktop, and it listens on its local unix
#      socket only;
#   4. adds the invoking user to the `docker` group, and enables the service.
# It creates no credential, opens no port, and changes nothing on Windows.
# A group or wsl.conf change takes effect after `wsl --shutdown` (step 0.10).
set -euo pipefail

say() { printf '[setup] %s\n' "$*"; }
fail() { printf '[setup] STOP: %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || fail "run it with sudo: sudo bash $0"
user="${SUDO_USER:-}"
[[ -n ${user} && ${user} != root ]] || fail "run it as your own user through sudo, not from a root shell"
grep -qi microsoft /proc/version || fail "this is not WSL"
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID} == ubuntu ]] || fail "this is ${ID}, not Ubuntu"
say "Ubuntu ${VERSION_ID} (${VERSION_CODENAME}) on WSL; user ${user}"

restart_needed=0

# 1. systemd
if grep -Eqs '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' /etc/wsl.conf; then
  say "systemd: already on in /etc/wsl.conf"
else
  if grep -Eqs '^[[:space:]]*systemd[[:space:]]*=' /etc/wsl.conf; then
    sed -i -E 's/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/' /etc/wsl.conf
  elif grep -Eqs '^\[boot\]' /etc/wsl.conf; then
    sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
  else
    printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
  fi
  say "systemd: turned on in /etc/wsl.conf"
  restart_needed=1
fi

# 2. base packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q \
  ca-certificates curl git gnupg jq unzip build-essential \
  python3 python3-venv python3-pip \
  sysstat zstd pigz tmux htop util-linux gh
say "base packages: installed"

# 3. Docker Engine, from Docker's apt repository
if command -v dockerd >/dev/null 2>&1; then
  say "docker: already installed ($(dockerd --version))"
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch="$(dpkg --print-architecture)"
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME}}"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  say "docker: installed ($(dockerd --version))"
fi

# 4. group and service
if id -nG "${user}" | tr ' ' '\n' | grep -qx docker; then
  say "docker group: ${user} is already a member"
else
  usermod -aG docker "${user}"
  say "docker group: added ${user}"
  restart_needed=1
fi
if [[ "$(ps -p 1 -o comm=)" == systemd ]]; then
  systemctl enable --now docker.service containerd.service >/dev/null
  say "docker service: enabled and started ($(systemctl is-active docker.service))"
else
  say "docker service: systemd is not running yet; it starts after the restart below"
  restart_needed=1
fi

if [[ ${restart_needed} -eq 1 ]]; then
  say "NEXT: close this window, run 'wsl --shutdown' in Windows PowerShell, then reopen Ubuntu."
else
  say "done; nothing needs a restart."
fi
