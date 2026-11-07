#!/bin/sh
set -eu

# Bootstrap must work before the checkout has installed its JavaScript dependencies.
cd "$(dirname "$0")/.."
vp i
exec pnpm --dir e2e exec playwright install --with-deps chromium
