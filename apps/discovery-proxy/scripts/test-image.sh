#!/bin/sh
# Black-box test of a built discovery proxy image: only the allowlisted routes and
# methods pass, the process runs unprivileged, and a missing or invalid
# WELDALL_UPSTREAM stops the container with a clear error instead of serving.
#
#   sh scripts/test-image.sh [image]
set -eu

image=${1:-weldall-discovery-proxy:local}
container=$(docker run --detach --publish 127.0.0.1::8080 \
  --env WELDALL_UPSTREAM=https://127.0.0.1:1 \
  --env request_method=GET \
  --env args=unexpected \
  --env proxy_host=attacker.example \
  "$image")
negative=

cleanup() {
  docker rm --force "$container" $negative >/dev/null 2>&1 || true
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

uid=$(docker exec "$container" id -u)
if [ "$uid" = 0 ]; then
  echo >&2 "process runs as root"
  exit 1
fi
user=$(docker inspect --format '{{.Config.User}}' "$container")
if [ -z "$user" ]; then
  echo >&2 "image sets no USER"
  exit 1
fi
echo "discovery proxy runs as $user (uid $uid)"

# The entrypoint's upstream validator must stop the container before nginx serves anything.
assert_rejected_upstream() {
  label=$1
  shift
  negative=$(docker run --detach "$@" "$image")
  attempt=0
  while [ "$(docker inspect --format '{{.State.Status}}' "$negative")" = running ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 40 ]; then
      docker logs "$negative" >&2
      echo >&2 "$label: container kept running"
      exit 1
    fi
    sleep 0.25
  done
  code=$(docker inspect --format '{{.State.ExitCode}}' "$negative")
  if [ "$code" = 0 ]; then
    echo >&2 "$label: container exited with 0"
    exit 1
  fi
  if ! docker logs "$negative" 2>&1 | grep -q "WELDALL_UPSTREAM must be"; then
    docker logs "$negative" >&2
    echo >&2 "$label: no WELDALL_UPSTREAM error in logs"
    exit 1
  fi
  docker rm --force "$negative" >/dev/null
  negative=
  echo "$label: container exited with $code and named WELDALL_UPSTREAM"
}

assert_rejected_upstream "missing WELDALL_UPSTREAM"
assert_rejected_upstream "invalid WELDALL_UPSTREAM" --env WELDALL_UPSTREAM=http://weldall.example

echo "discovery proxy image tests passed"
