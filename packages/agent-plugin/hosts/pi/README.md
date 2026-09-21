# @weldall/pi

Weldall as a pi skill.

Weldall is the access layer in front of company systems. It holds the catalog of what each
user is permitted to do, and it performs every API call on their behalf, so no access token
reaches the agent.

This package ships one skill. When a request concerns a company system, a business record, or
an action on one, the agent reads the live catalog, matches a skill, and follows the document
Weldall returns. It does not answer those requests from memory and does not invent an API call.

## Requirements

- pi, tested against 0.84
- The Weldall CLI at **0.14.0 or newer**, on the PATH of the shell pi runs commands in, and
  signed in with `weldall login`

The version floor is hard. The skill reads the catalog with `weldall skills list --agentic`,
which arrived in CLI 0.14.0, and it carries no fallback to an older flag. On an older CLI the
lookup fails and the agent reports the failure rather than guessing.

## Install

```sh
pi install npm:@weldall/pi
```

Add `-l` to install into `.pi/settings.json` for one project instead of globally.

## What it does

The catalog differs per user and an administrator can change it at any moment, so the skill
reads it on every run rather than remembering it between turns. A skill the user lacks scopes
for is reported along with the scopes it needs, never attempted anyway. A catalog that came
back incomplete is reported as incomplete, never as proof that a capability is absent.

The procedure is one file in the repository, and every host package is generated from it, so
the text does not fork per host.

## License

FSL-1.1-ALv2. Source at [seibert-external/weldall](https://github.com/seibert-external/weldall).
