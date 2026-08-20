#!/bin/sh
set -eu

image=${1:-weldall-discovery-proxy:local}
container=$(docker run --detach --publish 127.0.0.1::8080 \
  --env WELDALL_UPSTREAM=https://127.0.0.1:1 \
  --env request_method=GET \
  --env args=unexpected \
  --env proxy_host=attacker.example \
  "$image")

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

binding=$(docker port "$container" 8080/tcp)
base=http://127.0.0.1:${binding##*:}
attempt=0
while [ "$attempt" -lt 20 ]; do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/" || true)
  [ "$status" = 404 ] && break
  attempt=$((attempt + 1))
  sleep 0.25
done
if [ "${status:-}" != 404 ]; then
  docker logs "$container" >&2
  exit 1
fi

assert_status() {
  expected=$1
  url=$2
  shift 2
  actual=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@" "$url")
  if [ "$actual" != "$expected" ]; then
    echo >&2 "expected HTTP $expected from $url, received $actual"
    exit 1
  fi
}

assert_status 404 "$base/"
assert_status 404 "$base/not-allowed"
assert_status 405 "$base/.well-known/oauth-authorization-server" --request POST
assert_status 404 "$base/.well-known/oauth-authorization-server?query=blocked"
assert_status 502 "$base/.well-known/oauth-authorization-server"
assert_status 502 "$base/api/oauth/jwks"

echo "discovery proxy routing passed"
