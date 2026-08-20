#!/bin/sh
set -eu

validator=./docker-entrypoint.d/05-validate-upstream.sh

accept() {
  WELDALL_UPSTREAM=$1 sh "$validator"
}

reject() {
  if WELDALL_UPSTREAM=$1 sh "$validator" >/dev/null 2>&1; then
    echo >&2 "expected WELDALL_UPSTREAM to be rejected: $1"
    exit 1
  fi
}

accept https://weldall.example
accept https://weldall.example:8443
accept 'https://[2001:db8::1]:443'

reject ''
reject http://weldall.example
reject https://weldall.example/path
reject 'https://user@weldall.example'
reject 'https://weldall.example?query'
reject https://weldall.example:0
reject https://weldall.example:65536
reject "https://weldall.example
; proxy_ssl_verify off;"

echo "upstream validation passed"
