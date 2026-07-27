# Weldall documentation

The static documentation site uses [Astro Starlight](https://starlight.astro.build/) with the [Lucode Starlight](https://lucas-labs.github.io/lucode-starlight-theme/) theme.

Run commands from the repository root:

```sh
pnpm docs:dev
pnpm --filter @weldall/docs typecheck
pnpm --filter @weldall/docs build
pnpm --filter @weldall/docs preview
```

Documentation pages belong in `src/content/docs/`. German is served from the site root and English translations live under `src/content/docs/en/`.
