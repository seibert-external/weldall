# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Treat `pnpm-workspace.yaml` and each workspace's `package.json` as the authoritative package inventory; root setup, build, and validation commands live in `package.json` and `.github/workflows/ci.yml`.
- For CLI syntax, read `apps/cli/src/commands.tsx` and validate the built interface with `./apps/cli/dist/index.js <command> --help`; request payload behavior is covered in `apps/cli/test/transfers.test.ts`.
- The product model is defined by `packages/db/prisma/schema.prisma`, with scope/resource policy in `apps/weldall/src/server/policy/` and local demonstration records in `packages/db/prisma/seed.dev.ts`.
- Standalone CLI targets, build/archive checks, and release upload behavior live in `apps/cli/scripts/standalone-targets.mjs` and `.github/workflows/release-cli-assets.yml`.
- Atomic file replacement in the CLI storage layer must go through `atomicWriteFile` in `apps/cli/src/storage/atomic-write.ts` (all five storage writers use it): temp written with `flag:"wx"`/mode 0o600, then renamed over the destination with a bounded EPERM retry, because on Windows `rename` over a file open without `FILE_SHARE_DELETE` intermittently fails with `EPERM`.
- After bumping any CLI dependency, regenerate the committed `apps/cli/THIRD_PARTY_NOTICES` (`pnpm --filter @weldall/cli exec tsx scripts/generate-third-party-notices.mjs`); `apps/cli/test/standalone-scripts.test.ts` asserts it matches. Bumping `lucide-react` also grows the icon catalog count asserted in `apps/weldall/test/skill-appearance.test.ts`.
- Do not bump `chalk` in `apps/cli` past 5.x: the CLI forces per-stream colors via `chalk.level` on its own instance, while `ink` still depends on `chalk ^5.6.2`, so a chalk 6 upgrade splits the instances and silently breaks "color stderr when only stderr is a TTY" (`test/commands.test.ts`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
