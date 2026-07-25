#!/usr/bin/env bash
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  printf 'Docker daemon is not running. Start Docker and retry pnpm test:e2e.\n' >&2
  exit 1
fi

rm -rf apps/e2e/test-results
mkdir -p apps/e2e/test-results

compose=(docker compose -f docker-compose.e2e.yml)
log_file=$(mktemp "${TMPDIR:-/tmp}/weldall-e2e.XXXXXX")
chmod 0600 "$log_file"
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans || true
  rm -f "$log_file"
  if [[ "${KEEP_E2E_ARTIFACTS:-0}" != "1" ]]; then
    rm -rf apps/e2e/test-results
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

set +e
"${compose[@]}" up --build --abort-on-container-exit --exit-code-from e2e >"$log_file" 2>&1
compose_status=$?
set -e

report_status=0
if [[ ! -f apps/e2e/test-results/junit.xml ]]; then
  printf 'E2E test report is missing.\n' >&2
  report_status=1
fi
if ((compose_status != 0)); then
  cat "$log_file" >&2
  exit "$compose_status"
fi
exit "$report_status"
