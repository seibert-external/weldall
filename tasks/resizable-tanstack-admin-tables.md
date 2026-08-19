# Resizable TanStack tables in the admin UI

## Goal

Improve the administration tables with consistent, user-resizable columns built on the existing TanStack Table integration.

## Scope

- Introduce a reusable table/header implementation for column sizing and resize handles instead of duplicating resizing behavior in each page.
- Apply it to the top-level admin tables for users, scopes, assignments, group assignments, group providers, resources, machines, skills, and audit events.
- Define sensible default, minimum, and maximum widths per column, with action columns remaining compact.
- Keep wide tables usable through deliberate truncation, tooltips where content is hidden, and horizontal scrolling at narrow viewport widths.
- Preserve current server-side filtering, sorting, pagination, row actions, URL state, loading states, and empty states.
- Provide clear hover/focus/drag feedback, a way to reset widths, and keyboard-accessible resizing.
- Avoid layout jumps while dragging and keep resize performance smooth for large result pages.
- Persist column widths per table and browser without putting noisy sizing state into shareable query URLs.

## Acceptance criteria

- Every listed admin table uses TanStack column sizing and exposes visible, accessible resize handles.
- Resizing one column does not break header/body alignment, sorting controls, row actions, or responsive overflow.
- Saved widths survive navigation and reload, are isolated per table, and can be reset to defaults.
- Tables remain operable with keyboard-only navigation and at supported mobile and desktop viewport widths.
- Component tests cover sizing state and persistence; browser tests cover pointer resize, keyboard resize, reset, and a narrow viewport.
