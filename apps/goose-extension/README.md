# Weldall for Goose

Use Weldall skills and connected services in Goose through a local stdio MCP extension.

## Requirements

- Node.js 22.15 or newer.
- The local Weldall binary in PATH, logged in and supporting `organizationInstructions` in `weldall status --json`.

## Setup

Add a **Command-Line Extension** in Goose with a 300-second timeout:

```sh
npx -y @weldall/goose@0.1.0
```

Keep Code Mode disabled in Goose 1.51 so organization instructions reach the model.
