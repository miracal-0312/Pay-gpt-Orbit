#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "$#" -gt 0 ]; then echo 'Usage: sh scripts/install.sh (Orbitcard API only)' >&2; exit 1; fi
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 24 or newer first.' >&2; exit 1; }
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" || { echo 'Node.js 24 or newer is required.' >&2; exit 1; }
npm ci --omit=dev --ignore-scripts
if [ ! -f .env ]; then cp .env.example .env; fi
echo 'Dependencies installed. Configure .env and MySQL, then run npm start.'
echo 'Set the paired Orbitcard API Key and platform card ID in the administrator UI before enabling redemptions.'
