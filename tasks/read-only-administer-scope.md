# Read-only administrator scope

## Goal

Introduce a protected system scope, `weldall:administer-read`, that grants access to the administration UI and administrative query APIs without granting permission to change configuration.

`weldall:administer` remains the full administrator scope and implicitly includes all read access.

## Scope

- Seed and advertise `weldall:administer-read` as a protected system scope that cannot be renamed, deleted, imported, or declared through IaC.
- Allow identities with either administrator scope to enter the admin application and use all administrative read/query endpoints.
- Continue to require `weldall:administer` for every mutation, including configuration changes, imports, synchronization actions, key rotation/revocation, and CLI-setting updates.
- Make the UI explicitly read-only for viewers: hide or disable create, edit, delete, import, and operational action controls, and explain why they are unavailable.
- Keep authorization enforcement on the server; disabled UI controls are not a security boundary.
- Ensure final-administrator safety checks continue to consider only `weldall:administer`.
- Include the new scope in assignment UI, audit context, bootstrap/seed behavior, and administrator documentation.

## Acceptance criteria

- A user assigned only `weldall:administer-read` can open every admin list and detail view, including audit data.
- The same user cannot execute any admin mutation through the UI, tRPC, route handlers, or direct HTTP requests.
- A user with `weldall:administer` retains existing read/write behavior.
- Unauthenticated users and users with neither administrator scope remain denied.
- Automated authorization tests cover representative queries and every mutation boundary, not only UI visibility.
