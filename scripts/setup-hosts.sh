#!/bin/sh
set -eu

hosts_file=${HOSTS_FILE:-/etc/hosts}
missing=""

for host in weldall.seibert.localdev expenses.seibert.localdev dev-idp.seibert.localdev; do
  addresses=$(awk -v host="$host" '
    $1 !~ /^#/ {
      for (i = 2; i <= NF; i++) if ($i == host) print $1
    }
  ' "$hosts_file")
  if [ -n "$addresses" ]; then
    if printf '%s\n' "$addresses" | grep -v '^127\.0\.0\.1$' >/dev/null; then
      printf 'Refusing conflicting hosts entry for %s:\n%s\n' "$host" "$addresses" >&2
      exit 1
    fi
    continue
  fi
  missing="$missing $host"
done

[ -z "$missing" ] && exit 0
line="127.0.0.1$missing"
if [ -w "$hosts_file" ]; then
  printf '%s\n' "$line" >>"$hosts_file"
else
  printf '%s\n' "$line" | sudo tee -a "$hosts_file" >/dev/null
fi
