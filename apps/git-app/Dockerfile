# syntax=docker/dockerfile:1

# Built from the repository root (the Git app depends on the workspace SDK):
#   docker build --file apps/git-app/Dockerfile --tag weldall-git-app:local .
# Configuration and secrets come only from the environment at run time (see apps/git-app/README.md);
# nothing is baked into the image.

FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @weldall/git-app...
RUN pnpm --filter @weldall/sdk build \
  && pnpm --filter @weldall/git-app exec node scripts/build-image.mjs /out

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=3002
WORKDIR /app
COPY --from=builder /out/index.mjs /out/THIRD_PARTY_NOTICES ./
COPY LICENSE ./LICENSE

# The base image's unprivileged `node` user (uid 1000); the bundle is read-only to it.
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/index.mjs"]
