#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.12+ LTS is required. Install it, then run this launcher again."
  exit 1
fi

PORT="${PORT:-4200}"
echo "Starting SHOTSPOT on http://localhost:${PORT}/"
echo "Press Ctrl+C to stop."
exec node scripts/serve.mjs "$PORT"
