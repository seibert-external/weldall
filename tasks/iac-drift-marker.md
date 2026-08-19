# IaC drift marker

## Goal

Clearly mark IaC-managed objects whose current persisted state differs from the state last applied or imported by their owning Weldall IaC workspace.

## Scope

- Store a canonical expected-state fingerprint for every IaC object binding when an object is applied or imported.
- Recompute the canonical fingerprint from the complete managed object, including owned relationships, when returning administrative data or IaC state.
- Expose an explicit drift status separately from the existing IaC ownership metadata.
- Show a visually distinct `Drift` marker next to the existing `IaC` badge in admin list and detail views.
- Include the workspace name, logical address, and a concise explanation in the marker tooltip without exposing sensitive values.
- Ensure drift detection is deterministic and does not trigger for ordering differences, timestamps, audit metadata, or other non-declarative fields.
- Treat missing bound objects and invalid bindings as drift and make those states visible through the IaC state API.
- Keep the marker informational: detection must not mutate data or reconcile drift outside an explicit `weldall plan`/`weldall up` operation.
- Refresh or clear drift after a successful apply, import, unmanage, or state move as appropriate.

## Acceptance criteria

- An unchanged IaC-managed object displays only the existing IaC ownership marker.
- Changing any declaratively managed field or relationship outside IaC causes the object to display the drift marker and appear as drifted in IaC state.
- Reordering set-like values or changing non-managed metadata does not produce a false drift marker.
- A successful apply that restores desired state removes the marker; unmanaging the object removes all IaC ownership and drift metadata.
- Tests cover every IaC-managed object kind, missing objects, relationship drift, canonical ordering, state moves, and concurrent reads during apply.
