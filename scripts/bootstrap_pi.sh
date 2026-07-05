#!/usr/bin/env bash
set -euo pipefail
sudo apt update
sudo apt install -y git curl python3-venv python3-pip portaudio19-dev libasound2-dev docker-compose-plugin
if ! command -v docker >/dev/null 2>&1; then
  curl -sSL https://get.docker.com | sh
fi
sudo usermod -aG docker "$USER"
echo "Done. Log out and log back in so Docker group membership applies."
