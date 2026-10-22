#!/usr/bin/env bash
# Keep the agent running: if it ever exits (crash, network down at boot, etc.) restart it after 15s.
#   bash scripts/run-forever.sh
# Ctrl+C once stops the agent cleanly AND stops this loop.
cd "$(dirname "$0")/.." || exit 1
trap 'echo "$(date -u +%T) stopped by you"; exit 0' INT TERM
while true; do
  npm run agent
  code=$?
  echo "$(date -u +%T) agent exited (code $code) — restarting in 15s. Press Ctrl+C to stop."
  sleep 15
done
