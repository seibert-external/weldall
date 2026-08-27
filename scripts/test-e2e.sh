#!/usr/bin/env bash
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  printf 'Docker daemon is not running. Start Docker and retry pnpm test:e2e.\n' >&2
  exit 1
fi

rm -rf apps/e2e/test-results
mkdir -p apps/e2e/test-results

# Pin the project name. Compose otherwise derives it from the checkout directory, so
# two worktrees of this repository that are both called "weldall" share one stack and
# the first `down --volumes` tears down the other one's containers and seed data.
compose=(docker compose -f docker-compose.e2e.yml -p "${COMPOSE_PROJECT_NAME:-weldall-e2e}")
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

# Stage 1: build and start the application stack and block until every healthcheck
# reports ready. Compose expresses this as dependency conditions, so a service that
# never comes up fails here instead of leaving the test container waiting on it
# until the job times out.
set +e
"${compose[@]}" up --build --wait --wait-timeout 900 \
  postgres bootstrap caddy trust dev-idp expenses reports catcher weldall 2>&1 | tee "$log_file"
stack_status=${PIPESTATUS[0]}
set -e
if (( stack_status != 0 )); then
  printf 'E2E dependency stack never became healthy (compose up --wait exited %d).\n' \
    "$stack_status" >&2
  printf 'Container state at failure:\n' >&2
  "${compose[@]}" ps --all >&2 || true
  printf 'Seed/bootstrap logs are above; the readiness gate reports the URL under test.\n' >&2
  exit "$stack_status"
fi

# Stage 2: run the Playwright suite against the stack that just reported ready.
# --build matters here: the e2e image is not part of the stage 1 service list, so
# without it a cached image would run the previous checkout's test code.
set +e
"${compose[@]}" up --build --abort-on-container-exit --exit-code-from e2e e2e 2>&1 | tee -a "$log_file"
compose_status=${PIPESTATUS[0]}
set -e

report_status=0
junit_report=apps/e2e/test-results/junit.xml
if [[ ! -f "$junit_report" ]]; then
  printf 'E2E test report is missing.\n' >&2
  report_status=1
else
  # Coverage gate: the suite is exactly the three system scenarios and none of them
  # may be skipped or lost. A run that is green only because assertions were
  # narrowed away produces the same exit code, so check the report shape.
  test_cases=$(grep -c "<testcase" "$junit_report" || true)
  skipped_cases=$(grep -c "<skipped" "$junit_report" || true)
  failed_cases=$(grep -c "<failure\\|<error" "$junit_report" || true)
  if (( test_cases != 3 )); then
    printf 'E2E coverage changed: expected 3 test cases in %s, found %d.\n' \
      "$junit_report" "$test_cases" >&2
    report_status=1
  fi
  if (( skipped_cases != 0 )); then
    printf 'E2E coverage changed: %d skipped test case(s) are not allowed.\n' \
      "$skipped_cases" >&2
    report_status=1
  fi
  if (( failed_cases != 0 )); then
    printf 'E2E report contains %d failure or error element(s).\\n' "$failed_cases" >&2
    report_status=1
  fi
fi
if (( compose_status != 0 )); then
  exit "$compose_status"
fi
exit "$report_status"
