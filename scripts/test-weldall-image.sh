#!/bin/sh
# Black-box test of a built Weldall server image against a throwaway PostgreSQL.
#
#   sh scripts/test-weldall-image.sh <image>
#
# Proves what the Docker image release promises: migrations run at start-up, the
# Docker HEALTHCHECK turns healthy, the OAuth discovery document is served, the
# process runs unprivileged, and the container refuses to start when the database
# is unreachable or a required variable is missing. Needs docker, curl and node.
set -eu

image=${1:?usage: test-weldall-image.sh <image>}
suffix=$$
network=weldall-image-test-$suffix
database=weldall-image-test-db-$suffix
app=weldall-image-test-app-$suffix
issuer=https://weldall.image-test.invalid
repo_root=$(cd "$(dirname "$0")/.." && pwd)
migrations_dir=$repo_root/packages/db/prisma/migrations
expected_migrations=$(find "$migrations_dir" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
env_file=$(mktemp)
chmod 600 "$env_file"

cleanup() {
  docker rm --force "$app" "$app-negative" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$env_file"
}
trap cleanup EXIT INT TERM

fail() {
  echo >&2 "FAIL: $*"
  exit 1
}

# Throwaway secrets in the same shape as `pnpm secrets:generate` (scripts/generate-env.ts),
# re-implemented with Node built-ins because the release job has no pnpm install and this
# script must also run against a bare image checkout. The file is deleted on exit.
node - >"$env_file" <<'EOF'
const { generateKeyPairSync, randomBytes, randomUUID } = require("node:crypto");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const lines = {
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  WELDALL_SETUP_TOKEN: randomBytes(32).toString("base64url"),
  WELDALL_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION: "1",
  WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
  WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
  WELDALL_SIGNING_KID: randomUUID(),
  WELDALL_DEPLOYMENT_MODE: "production",
};
process.stdout.write(Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
EOF

echo "Starting throwaway PostgreSQL"
docker network create "$network" >/dev/null
docker run --detach --name "$database" --network "$network" \
  --env POSTGRES_PASSWORD=postgres postgres:16-alpine >/dev/null
attempt=0
until docker exec "$database" pg_isready --username postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail "PostgreSQL did not become ready"
  sleep 1
done
database_url=postgresql://postgres:postgres@$database:5432/postgres

echo "Starting $image"
docker run --detach --name "$app" --network "$network" --publish 127.0.0.1::3000 \
  --env-file "$env_file" \
  --env POSTGRES_URL="$database_url" \
  --env WELDALL_ISSUER="$issuer" \
  "$image" >/dev/null

# The image's own HEALTHCHECK is the readiness signal customers and orchestrators rely on.
attempt=0
while :; do
  status=$(docker inspect --format '{{.State.Status}}' "$app")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app")
  [ "$health" = none ] && fail "$image declares no HEALTHCHECK"
  [ "$status" = running ] || { docker logs "$app" >&2; fail "container stopped with status $status"; }
  [ "$health" = healthy ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 150 ] || { docker logs "$app" >&2; fail "container never became healthy (last: $health)"; }
  sleep 1
done
echo "Container is healthy after ${attempt}s"

binding=$(docker port "$app" 3000/tcp)
base=http://127.0.0.1:${binding##*:}
discovery=$(curl --silent --show-error --fail "$base/.well-known/openid-configuration") ||
  fail "discovery document not served"
case $discovery in
  *"\"issuer\":\"$issuer\""*) echo "Discovery document names the configured issuer" ;;
  *) fail "discovery document does not name issuer $issuer: $discovery" ;;
esac

uid=$(docker exec "$app" id -u)
[ "$uid" != 0 ] || fail "process runs as root"
user=$(docker inspect --format '{{.Config.User}}' "$app")
[ -n "$user" ] || fail "image sets no USER"
echo "Process runs as $user (uid $uid)"

applied=$(docker exec "$database" psql --username postgres --tuples-only --no-align \
  --command "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")
unfinished=$(docker exec "$database" psql --username postgres --tuples-only --no-align \
  --command "select count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null")
[ "$applied" = "$expected_migrations" ] || fail "expected $expected_migrations applied migrations, found $applied"
[ "$unfinished" = 0 ] || fail "$unfinished migrations are unfinished or rolled back"
echo "All $applied migrations applied"

wait_for_exit() {
  attempt=0
  while [ "$(docker inspect --format '{{.State.Status}}' "$1")" = running ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 90 ] || { docker logs "$1" >&2; fail "$2: container kept running"; }
    sleep 1
  done
  code=$(docker inspect --format '{{.State.ExitCode}}' "$1")
  [ "$code" != 0 ] || fail "$2: container exited with 0"
  echo "$2: container exited with $code"
}

echo "Negative test: unreachable database"
docker run --detach --name "$app-negative" --network "$network" \
  --env-file "$env_file" \
  --env POSTGRES_URL=postgresql://postgres:postgres@unreachable.invalid:5432/postgres \
  --env WELDALL_ISSUER="$issuer" \
  "$image" >/dev/null
wait_for_exit "$app-negative" "unreachable database"
docker logs "$app-negative" 2>&1 | grep -q "P1001" || fail "unreachable database: no Prisma P1001 error in logs"
docker rm --force "$app-negative" >/dev/null

echo "Negative test: missing required variable"
docker run --detach --name "$app-negative" --network "$network" \
  --env-file "$env_file" \
  --env POSTGRES_URL="$database_url" \
  "$image" >/dev/null
wait_for_exit "$app-negative" "missing WELDALL_ISSUER"
docker logs "$app-negative" 2>&1 | grep -q "WELDALL_ISSUER is required" ||
  fail "missing variable: entrypoint did not name WELDALL_ISSUER"

echo "weldall image tests passed"
