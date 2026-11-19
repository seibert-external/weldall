#!/bin/sh
# Black-box test of a built Git app image with a throwaway configuration: the Docker
# HEALTHCHECK turns healthy, /health answers, the authorization server and the skill
# catalog are announced, protected routes demand a token, the process runs unprivileged,
# a stop signal ends it promptly, secrets read from *_FILE mounts work, a missing or
# invalid configuration stops the container with an error that names the variables, and
# no secret value ever appears in the container's output. Needs docker, curl and node.
#
#   sh scripts/test-image.sh [image]
set -eu

image=${1:-weldall-git-app:local}
suffix=$$
origin=https://git-app.image-test.invalid
workdir=$(mktemp -d)
container=
negative=

cleanup() {
  docker rm --force $container $negative >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

fail() {
  echo >&2 "FAIL: $*"
  exit 1
}

# Throwaway keys and configuration, generated with Node built-ins (the release job has no
# pnpm install). Secrets that fit on one line go into an env file; the GitHub App key is a
# multi-line PEM and goes into a file mounted for GIT_APP_HOST_SECRET_FILE. secrets.txt holds
# every secret value, one per line, for the leak check. Everything is deleted on exit.
node - "$workdir" "$origin" <<'EOF'
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const [dir, origin] = process.argv.slice(2);
const ec = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateJwk: JSON.stringify(privateKey.export({ format: "jwk" })),
    publicJwk: JSON.stringify(publicKey.export({ format: "jwk" })),
    d: privateKey.export({ format: "jwk" }).d,
  };
};
const signing = ec();
const machine = ec();
const githubKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const credentialKey = randomBytes(32).toString("base64");
const forgejoToken = randomBytes(20).toString("hex");
const common = {
  GIT_APP_PUBLIC_ORIGIN: origin,
  GIT_APP_DOWNSTREAM_CLIENT_ID: "weldall-cli-at-git-app",
  GIT_APP_SIGNING_KID: "image-test-signing",
  GIT_APP_SIGNING_PRIVATE_JWK: signing.privateJwk,
  GIT_APP_SIGNING_PUBLIC_JWK: signing.publicJwk,
  GIT_APP_GIT_CREDENTIAL_KEY: credentialKey,
  WELDALL_ISSUER: "https://weldall.image-test.invalid",
  WELDALL_MACHINE_CLIENT_ID: "git-app-machine",
  WELDALL_MACHINE_KID: "image-test-machine",
  WELDALL_MACHINE_PRIVATE_JWK: machine.privateJwk,
  WELDALL_MACHINE_PUBLIC_JWK: machine.publicJwk,
};
const envFile = (values) =>
  Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
writeFileSync(`${dir}/common.env`, envFile(common), { mode: 0o600 });
writeFileSync(`${dir}/forgejo.env`, envFile({ GIT_APP_HOST_SECRET: forgejoToken }), { mode: 0o600 });
writeFileSync(`${dir}/github-key.pem`, githubKey);
writeFileSync(
  `${dir}/github.json`,
  JSON.stringify({
    appId: "123456",
    organization: "example-apps",
    installationId: "987654",
    templates: [{ name: "react", repository: "example-apps/react-starter" }],
    repositoryNamePrefix: "app-",
    reviewerTeam: "app-reviewers",
    setupMode: "customer-managed",
  }),
);
writeFileSync(
  `${dir}/forgejo.json`,
  JSON.stringify({
    baseUrl: "https://git.image-test.invalid",
    organization: "example-apps",
    botUser: "weldall-bot",
    templates: [{ name: "react", repository: "example-apps/react-starter" }],
    repositoryNamePrefix: "app-",
    reviewerTeam: "app-reviewers",
    setupMode: "customer-managed",
  }),
);
// Distinctive fragments of every secret: the PEM's base64 body lines, the private JWKs' d,
// the credential key and the Forgejo token.
const pemLines = githubKey.split("\n").filter((line) => line.length > 40);
writeFileSync(
  `${dir}/secrets.txt`,
  [...pemLines, signing.d, machine.d, credentialKey, forgejoToken].join("\n") + "\n",
);
EOF
# The container runs as the image's unprivileged user and reads the mounted files; on Linux
# a bind mount keeps host permissions, and mktemp -d creates a 0700 directory.
mkdir "$workdir/mount"
cp "$workdir/github-key.pem" "$workdir/github.json" "$workdir/forgejo.json" "$workdir/mount/"
chmod 755 "$workdir/mount"
chmod 644 "$workdir/mount/"*

# Fails when any secret value appears in the container's output.
assert_no_secrets() {
  docker logs "$1" >"$workdir/logs" 2>&1
  if grep -F -q -f "$workdir/secrets.txt" "$workdir/logs"; then
    fail "$2: a secret value appears in the container output"
  fi
  echo "$2: no secret value in the container output"
}

wait_for_healthy() {
  attempt=0
  while :; do
    status=$(docker inspect --format '{{.State.Status}}' "$1")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1")
    [ "$health" = none ] && fail "$image declares no HEALTHCHECK"
    [ "$status" = running ] || { docker logs "$1" >&2; fail "container stopped with status $status"; }
    [ "$health" = healthy ] && break
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ] || { docker logs "$1" >&2; fail "container never became healthy (last: $health)"; }
    sleep 1
  done
  echo "Container is healthy after ${attempt}s"
}

# --- 1. A GitHub instance with secrets and host configuration from mounted files ------
# The HEALTHCHECK's first probe runs after --health-interval; shorten it for the test only.
container=$(docker run --detach --publish 127.0.0.1::3002 \
  --health-interval 1s \
  --env-file "$workdir/common.env" \
  --env GIT_APP_HOST=github \
  --env GIT_APP_HOST_CONFIG_FILE=/run/git-app/github.json \
  --env GIT_APP_HOST_SECRET_FILE=/run/git-app/github-key.pem \
  --volume "$workdir/mount:/run/git-app:ro" \
  "$image")
wait_for_healthy "$container"
binding=$(docker port "$container" 3002/tcp)
base=http://127.0.0.1:${binding##*:}

health=$(curl --silent --show-error --fail "$base/health") || fail "/health not served"
[ "$health" = '{"status":"ok"}' ] || fail "/health answered $health"
echo "/health answers ok"

metadata=$(curl --silent --show-error --fail "$base/.well-known/oauth-authorization-server") ||
  fail "authorization server metadata not served"
case $metadata in
  *"\"issuer\":\"$origin\""*) echo "Authorization server metadata names the configured origin" ;;
  *) fail "authorization server metadata does not name $origin: $metadata" ;;
esac
resource=$(curl --silent --show-error --fail "$base/.well-known/oauth-protected-resource") ||
  fail "protected resource metadata not served"
case $resource in
  *"\"weldall_skills_endpoint\":\"$origin/.well-known/weldall-skills\""*)
    echo "Protected resource metadata announces the skill catalog" ;;
  *) fail "protected resource metadata does not announce the skill catalog: $resource" ;;
esac

status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/.well-known/weldall-skills")
[ "$status" = 401 ] || fail "skill catalog without Weldall's assertion answered $status"
status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/api/admin/checklist")
[ "$status" = 401 ] || fail "protected API without a token answered $status"
status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "$base/git/example-apps/app-demo.git/info/refs?service=git-upload-pack")
[ "$status" = 401 ] || fail "git route without a credential answered $status"
echo "Skill catalog, API and git route refuse unauthenticated requests"

uid=$(docker exec "$container" id -u)
[ "$uid" != 0 ] || fail "process runs as root"
user=$(docker inspect --format '{{.Config.User}}' "$container")
[ -n "$user" ] || fail "image sets no USER"
echo "Process runs as $user (uid $uid)"

started=$(date +%s)
docker stop --time 20 "$container" >/dev/null
took=$(($(date +%s) - started))
code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
[ "$code" = 0 ] || { docker logs "$container" >&2; fail "stop signal: container exited with $code"; }
[ "$took" -lt 10 ] || fail "stop signal: container needed ${took}s to stop"
echo "Stop signal ends the container with 0 after ${took}s"
assert_no_secrets "$container" "GitHub instance"
docker rm --force "$container" >/dev/null
container=

# --- 2. A Forgejo instance with every secret from the environment -------------------
container=$(docker run --detach --publish 127.0.0.1::3002 \
  --health-interval 1s \
  --env-file "$workdir/common.env" \
  --env-file "$workdir/forgejo.env" \
  --env GIT_APP_HOST=forgejo \
  --env GIT_APP_HOST_CONFIG_FILE=/run/git-app/forgejo.json \
  --volume "$workdir/mount:/run/git-app:ro" \
  "$image")
wait_for_healthy "$container"
assert_no_secrets "$container" "Forgejo instance"
docker rm --force "$container" >/dev/null
container=

# --- 3. A missing or invalid configuration stops the container before it serves -----
assert_rejected() {
  label=$1
  shift
  negative=$(docker run --detach "$@" "$image")
  attempt=0
  while [ "$(docker inspect --format '{{.State.Status}}' "$negative")" = running ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 40 ] || { docker logs "$negative" >&2; fail "$label: container kept running"; }
    sleep 0.25
  done
  code=$(docker inspect --format '{{.State.ExitCode}}' "$negative")
  [ "$code" != 0 ] || fail "$label: container exited with 0"
  docker logs "$negative" >"$workdir/logs" 2>&1
  grep -q "Invalid Git app configuration" "$workdir/logs" ||
    { cat "$workdir/logs" >&2; fail "$label: no configuration error in the output"; }
  if grep -q "Git app listening" "$workdir/logs"; then fail "$label: the server started"; fi
  for name in $EXPECTED; do
    grep -q "$name" "$workdir/logs" || { cat "$workdir/logs" >&2; fail "$label: $name not named"; }
  done
  assert_no_secrets "$negative" "$label"
  docker rm --force "$negative" >/dev/null
  negative=
  echo "$label: container exited with $code and named $EXPECTED"
}

EXPECTED="GIT_APP_HOST GIT_APP_PUBLIC_ORIGIN WELDALL_ISSUER GIT_APP_GIT_CREDENTIAL_KEY" \
  assert_rejected "missing configuration"

# Every secret is present, but the origin, host and credential key are wrong; the
# Forgejo token is given twice. The error must name the variables and print no value.
EXPECTED="GIT_APP_PUBLIC_ORIGIN GIT_APP_HOST GIT_APP_GIT_CREDENTIAL_KEY" \
  assert_rejected "invalid configuration" \
  --env-file "$workdir/common.env" \
  --env-file "$workdir/forgejo.env" \
  --env GIT_APP_HOST=gitlab \
  --env GIT_APP_HOST_CONFIG_FILE=/run/git-app/forgejo.json \
  --env GIT_APP_PUBLIC_ORIGIN=http://git-app.image-test.invalid \
  --env GIT_APP_GIT_CREDENTIAL_KEY=dG9vLXNob3J0 \
  --volume "$workdir/mount:/run/git-app:ro"

# A malformed secret is refused without being echoed.
malformed="malformed-secret-$suffix-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n') !"
echo "$malformed" >>"$workdir/secrets.txt"
EXPECTED="GIT_APP_HOST_SECRET" \
  assert_rejected "invalid host secret" \
  --env-file "$workdir/common.env" \
  --env GIT_APP_HOST=forgejo \
  --env GIT_APP_HOST_CONFIG_FILE=/run/git-app/forgejo.json \
  --env GIT_APP_HOST_SECRET="$malformed" \
  --volume "$workdir/mount:/run/git-app:ro"

echo "git app image tests passed"
