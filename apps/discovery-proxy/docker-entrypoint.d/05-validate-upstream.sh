#!/bin/sh
set -eu

invalid_upstream() {
  echo >&2 "WELDALL_UPSTREAM must be an HTTPS origin with a valid port and without credentials, path, query, or fragment"
  exit 1
}

upstream=${WELDALL_UPSTREAM:-}
line_count=$(printf '%s\n' "$upstream" | wc -l | tr -d '[:space:]')
if [ "$line_count" -ne 1 ] \
  || ! printf '%s\n' "$upstream" \
    | grep -Eq '^https://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'; then
  invalid_upstream
fi

authority=${upstream#https://}
case "$authority" in
  \[*\]:*) port=${authority##*:} ;;
  \[*\]) port= ;;
  *:*) port=${authority##*:} ;;
  *) port= ;;
esac

if [ -n "$port" ] && { [ "$port" -eq 0 ] || [ "$port" -gt 65535 ]; }; then
  invalid_upstream
fi
