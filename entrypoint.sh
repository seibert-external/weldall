#!/bin/sh
set -eu

required_variables="POSTGRES_URL WELDALL_ISSUER BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET WELDALL_SIGNING_PRIVATE_JWK WELDALL_SIGNING_PUBLIC_JWK WELDALL_SIGNING_KID"
for name in $required_variables; do
  value="$(printenv "$name" || true)"
  if [ -z "$value" ]; then
    echo "Error: $name is required" >&2
    exit 1
  fi
done

if [ "${WELDALL_DEPLOYMENT_MODE:-production}" != "production" ]; then
  echo "Error: WELDALL_DEPLOYMENT_MODE must be production in this image" >&2
  exit 1
fi
export WELDALL_DEPLOYMENT_MODE=production

/app/packages/db/node_modules/.bin/prisma migrate deploy \
  --schema /app/packages/db/prisma/schema.prisma
node /app/packages/db/deployment-init.mjs

exec node apps/weldall/server.js
