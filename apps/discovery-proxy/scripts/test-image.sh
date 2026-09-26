#!/bin/sh
# Black-box test of a built discovery proxy image: only the allowlisted routes and
# methods pass, the two allowlisted routes are proxied unchanged from a controlled
# TLS upstream, the upstream certificate is verified, the process runs unprivileged,
# and a missing or invalid WELDALL_UPSTREAM stops the container with a clear error
# instead of serving. Needs docker, curl and openssl.
#
#   sh scripts/test-image.sh [image]
set -eu

image=${1:-weldall-discovery-proxy:local}
suffix=$$
network=weldall-proxy-test-$suffix
stub=weldall-proxy-test-upstream-$suffix
stub_host=upstream.test
stub_port=8443
workdir=$(mktemp -d)
container=
proxied=
negative=

cleanup() {
  docker rm --force $container $proxied $negative "$stub" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

fail() {
  echo >&2 "FAIL: $*"
  exit 1
}

assert_status() {
  expected=$1
  url=$2
  shift 2
  actual=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@" "$url")
  [ "$actual" = "$expected" ] || fail "expected HTTP $expected from $url, received $actual"
}

wait_for_404() {
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$1/" || true)
    [ "$status" = 404 ] && return 0
    attempt=$((attempt + 1))
    sleep 0.25
  done
  docker logs "$2" >&2
  fail "proxy did not come up"
}

base_of() {
  binding=$(docker port "$1" 8080/tcp)
  echo "http://127.0.0.1:${binding##*:}"
}

# --- 1. Routing against a dead upstream: nothing but the allowlist gets through -------
container=$(docker run --detach --publish 127.0.0.1::8080 \
  --env WELDALL_UPSTREAM=https://127.0.0.1:1 \
  --env request_method=GET \
  --env args=unexpected \
  --env proxy_host=attacker.example \
  "$image")
base=$(base_of "$container")
wait_for_404 "$base" "$container"

assert_status 404 "$base/"
assert_status 404 "$base/not-allowed"
assert_status 405 "$base/.well-known/oauth-authorization-server" --request POST
assert_status 404 "$base/.well-known/oauth-authorization-server?query=blocked"
assert_status 502 "$base/.well-known/oauth-authorization-server"
assert_status 502 "$base/api/oauth/jwks"
echo "discovery proxy routing passed"

uid=$(docker exec "$container" id -u)
[ "$uid" != 0 ] || fail "process runs as root"
user=$(docker inspect --format '{{.Config.User}}' "$container")
[ -n "$user" ] || fail "image sets no USER"
echo "discovery proxy runs as $user (uid $uid)"

# --- 2. A controlled TLS upstream: allowlisted routes are proxied unchanged ---------
# Throwaway CA and server certificate for the stub; the proxy only trusts the CA
# bundle mounted over /etc/ssl/certs/ca-certificates.crt, so the second run below
# (without the mount) proves proxy_ssl_verify is really on.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=weldall-proxy-test-ca \
  -keyout "$workdir/ca.key" -out "$workdir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=$stub_host" \
  -keyout "$workdir/server.key" -out "$workdir/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\n' "$stub_host" >"$workdir/san.cnf"
openssl x509 -req -days 1 -in "$workdir/server.csr" -CA "$workdir/ca.crt" -CAkey "$workdir/ca.key" \
  -CAcreateserial -extfile "$workdir/san.cnf" -out "$workdir/server.crt" >/dev/null 2>&1
# The stub runs as uid 101 inside its container and reads these through a bind mount;
# on Linux the mount keeps host permissions, and mktemp -d creates a 0700 directory.
chmod 755 "$workdir"
chmod 644 "$workdir/server.key" "$workdir/server.crt" "$workdir/ca.crt"

mkdir -p "$workdir/www/.well-known" "$workdir/www/api/oauth"
printf '{"issuer":"https://%s:%s","stub":"discovery","nested":{"keep":[1,2,3]}}' "$stub_host" "$stub_port" \
  >"$workdir/www/.well-known/oauth-authorization-server"
printf '{"keys":[{"kty":"EC","crv":"P-256","kid":"stub","x":"AA","y":"BB"}]}' \
  >"$workdir/www/api/oauth/jwks"
printf '{"secret":"must not be reachable through the proxy"}' >"$workdir/www/secret"
cat >"$workdir/stub.conf" <<EOF
server {
  listen $stub_port ssl;
  server_name $stub_host;
  ssl_certificate /stub/server.crt;
  ssl_certificate_key /stub/server.key;
  root /stub/www;
  default_type application/json;
  add_header x-weldall-stub "upstream-$suffix" always;
  location / { try_files \$uri =404; }
}
EOF

docker network create "$network" >/dev/null
docker run --detach --name "$stub" --network "$network" --network-alias "$stub_host" \
  --volume "$workdir/stub.conf:/etc/nginx/conf.d/default.conf:ro" \
  --volume "$workdir:/stub:ro" \
  nginxinc/nginx-unprivileged:1.28-alpine >/dev/null

# nginx resolves proxy_pass hosts once at start-up, so the stub must be up and
# resolvable on the network before the proxy container is created.
attempt=0
until docker logs "$stub" 2>&1 | grep -q "ready for start up"; do
  attempt=$((attempt + 1))
  status=$(docker inspect --format '{{.State.Status}}' "$stub")
  if [ "$status" != running ] || [ "$attempt" -ge 40 ]; then
    docker logs "$stub" >&2
    fail "stub upstream did not come up (status $status)"
  fi
  sleep 0.25
done

proxied=$(docker run --detach --network "$network" --publish 127.0.0.1::8080 \
  --env WELDALL_UPSTREAM="https://$stub_host:$stub_port" \
  --volume "$workdir/ca.crt:/etc/ssl/certs/ca-certificates.crt:ro" \
  "$image")
base=$(base_of "$proxied")
wait_for_404 "$base" "$proxied"

for route in /.well-known/oauth-authorization-server /api/oauth/jwks; do
  curl --silent --show-error --fail --dump-header "$workdir/headers" \
    --output "$workdir/body" "$base$route" ||
    { docker logs "$proxied" >&2; docker logs "$stub" >&2; fail "$route not proxied"; }
  cmp -s "$workdir/body" "$workdir/www$route" || fail "$route body changed by the proxy"
  grep -qi '^content-type: application/json' "$workdir/headers" ||
    fail "$route content-type not forwarded"
  grep -qi "^x-weldall-stub: upstream-$suffix" "$workdir/headers" ||
    fail "$route upstream headers not forwarded"
done
echo "discovery and JWKS documents proxied unchanged"

assert_status 404 "$base/secret"
assert_status 404 "$base/.well-known/oauth-authorization-server?query=blocked"
assert_status 405 "$base/api/oauth/jwks" --request POST
echo "allowlist holds against a live upstream"

docker rm --force "$proxied" >/dev/null
proxied=$(docker run --detach --network "$network" --publish 127.0.0.1::8080 \
  --env WELDALL_UPSTREAM="https://$stub_host:$stub_port" \
  "$image")
base=$(base_of "$proxied")
wait_for_404 "$base" "$proxied"
assert_status 502 "$base/api/oauth/jwks"
echo "untrusted upstream certificate is rejected"

# --- 3. The entrypoint's upstream validator stops the container before nginx serves ---
assert_rejected_upstream() {
  label=$1
  shift
  negative=$(docker run --detach "$@" "$image")
  attempt=0
  while [ "$(docker inspect --format '{{.State.Status}}' "$negative")" = running ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 40 ]; then
      docker logs "$negative" >&2
      fail "$label: container kept running"
    fi
    sleep 0.25
  done
  code=$(docker inspect --format '{{.State.ExitCode}}' "$negative")
  [ "$code" != 0 ] || fail "$label: container exited with 0"
  if ! docker logs "$negative" 2>&1 | grep -q "WELDALL_UPSTREAM must be"; then
    docker logs "$negative" >&2
    fail "$label: no WELDALL_UPSTREAM error in logs"
  fi
  docker rm --force "$negative" >/dev/null
  negative=
  echo "$label: container exited with $code and named WELDALL_UPSTREAM"
}

assert_rejected_upstream "missing WELDALL_UPSTREAM"
assert_rejected_upstream "invalid WELDALL_UPSTREAM" --env WELDALL_UPSTREAM=http://weldall.example

echo "discovery proxy image tests passed"
