# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

FROM base AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
RUN pnpm --dir packages/db exec prisma generate --schema prisma/schema.prisma \
  && pnpm --filter @weldall/sdk build \
  && pnpm --filter @weldall/db build \
  && pnpm --dir apps/cli exec esbuild ../weldall/src/scripts/deployment-init.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --external:@prisma/client \
    --outfile=/app/deployment-init.mjs
RUN POSTGRES_URL=postgresql://build:build@127.0.0.1:5432/build \
  BETTER_AUTH_SECRET=build-only-better-auth-secret-at-least-32-characters \
  GOOGLE_CLIENT_ID=build-only-client \
  GOOGLE_CLIENT_SECRET=build-only-secret \
  WELDALL_DEPLOYMENT_MODE=production \
  WELDALL_ISSUER=https://build.invalid \
  WELDALL_SIGNING_KID=build-only \
  WELDALL_SKIP_RESOURCE_SEED=true \
  pnpm --dir apps/weldall exec next build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/apps/weldall/.next/standalone ./
COPY --from=builder /app/apps/weldall/.next/static ./apps/weldall/.next/static
COPY --from=builder /app/apps/weldall/public ./apps/weldall/public
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/deployment-init.mjs ./packages/db/deployment-init.mjs
RUN cd packages/db \
  && npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund \
    prisma@6.19.3 \
    @prisma/client@6.19.3 >/dev/null
COPY entrypoint.sh ./entrypoint.sh

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/.well-known/openid-configuration').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["./entrypoint.sh"]
