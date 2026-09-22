#!/bin/sh
# Stop every Caddy process on the host. macOS only: `pgrep -x` matches the exact
# process name, which is what the dev workflow's `caddy run --config Caddyfile` uses.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'kill-caddy.sh is macOS-only; detected %s.\n' "$(uname -s)" >&2
  exit 1
fi

caddy_pids() {
  pgrep -x caddy || true
}

format_pids() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'
}

pids=$(caddy_pids)
if [ -z "$pids" ]; then
  printf 'No Caddy processes running.\n'
  exit 0
fi

printf 'Stopping Caddy: %s\n' "$(format_pids "$pids")"
kill $pids 2>/dev/null || true

# Give Caddy room for a graceful shutdown (in-flight connections) before escalating:
# 25 x 0.2s = 5s, then SIGKILL.
waited=0
while [ "$waited" -lt 25 ] && [ -n "$(caddy_pids)" ]; do
  sleep 0.2
  waited=$((waited + 1))
done

leftover=$(caddy_pids)
if [ -n "$leftover" ]; then
  printf 'Force killing Caddy: %s\n' "$(format_pids "$leftover")"
  kill -9 $leftover 2>/dev/null || true
fi

if [ -n "$(caddy_pids)" ]; then
  printf 'Caddy processes survived; they are likely owned by another user (try sudo).\n' >&2
  exit 1
fi

printf 'Caddy stopped.\n'
