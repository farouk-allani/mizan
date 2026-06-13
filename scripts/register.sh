#!/usr/bin/env bash
# One-shot on-chain competition registration. Idempotent (twak handles re-runs).
set -euo pipefail
echo "Status before:"; twak compete status --json
echo "Registering...";  twak compete register --json
echo "Status after:";   twak compete status --json
echo "→ Now also submit the agent address + strategy write-up on DoraHacks."
