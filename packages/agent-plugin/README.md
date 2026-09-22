# Weldall agent plugin

Weldall is the company's access layer. It holds the catalog of what each user is permitted to
do in company systems, and it performs every API call on their behalf, so no access token
reaches the agent.

This directory packages one skill for four coding agents. When a request concerns a company
system, a business record, or an action on one, the agent reads the live catalog, matches a
skill, and follows the document Weldall returns. It does not answer those requests from
memory and does not invent an API call.

## Requirements

- The Weldall CLI at **0.14.0 or newer**, on the PATH of the shell the agent runs commands
  in, and signed in with `weldall login`
- Tested host versions: Claude Code 2.1, OpenWork 0.18.42, pi 0.84, opencode 1.18

The version floor is hard. The skill reads the catalog with `weldall skills list --agentic`,
which arrived in CLI 0.14.0, and it carries no fallback to an older flag. On an older CLI the
lookup fails and the agent reports the failure rather than guessing.

## Install

### Claude Code

Install from the internal marketplace, which already carries a copy of this host:

```
/plugin marketplace add https://bitbucket.seibert.tools/scm/as/claude-managed-plugins.git
/plugin install weldall@seibert-claude-plugins
```

Managed Macs get the marketplace through device management, so the first command is usually
unnecessary. To install straight from this repository instead, add the local marketplace at
`packages/agent-plugin/.claude-plugin/marketplace.json` from a checkout.

### OpenWork

OpenWork has no host of its own. Its GitHub importer resolves a Claude Code plugin, so it
installs `hosts/claude-code` directly. In Settings, open Library, then Advanced settings,
paste this URL, press Preview, then Install:

```
https://github.com/seibert-external/weldall/tree/main/packages/agent-plugin/hosts/claude-code
```

Two things to know. The import reports nothing on success, so check that
`.opencode/skills/weldall-plugin/weldall/SKILL.md` appeared in the workspace folder. And
installs are per workspace and write into that folder, so pick the workspace deliberately
rather than dropping an untracked `.opencode/` into a real repository.

### pi

```sh
pi install npm:@weldall/pi
```

Add `-l` to install into `.pi/settings.json` for one project instead of globally.

### opencode

```sh
opencode plugin @weldall/opencode
```

Add `-g` to install into `~/.config/opencode/opencode.json` instead of the project. Restart
opencode afterwards: config is read once at startup and is not reloaded.

## What the skill does

The catalog differs per user and an administrator can change it at any moment, so the skill
reads it on every run rather than remembering it between turns. A skill the user lacks scopes
for is reported along with the scopes it needs, never attempted anyway. A catalog that came
back incomplete is reported as incomplete, never as proof that a capability is absent.

## How this directory is built

`procedure.md` is the only copy of the text. `scripts/assemble-skill.mjs` writes an identical
`SKILL.md` into every host under `hosts/`, so edit the source and rerun the script rather
than editing a generated copy:

```sh
node scripts/assemble-skill.mjs
node --test "test/*.test.mjs"
```

Quote that glob, or node resolves it as a directory and fails. The `agent-plugin` job in
`.github/workflows/ci.yml` runs both and fails on any diff. This directory has no
`package.json` and stays outside pnpm and turbo, the same arrangement as
`packages/python-sdk/`.

Whenever the text changes, bump `version` in all three host manifests together.
`test/packaging.test.mjs` asserts they agree. Claude Code keys its plugin cache by version,
so a reinstall without a bump keeps serving the old skill. A fourth copy lives in the
`claude-managed-plugins` repository and no test here can see it.

## License

FSL-1.1-ALv2. Source at [seibert-external/weldall](https://github.com/seibert-external/weldall).
