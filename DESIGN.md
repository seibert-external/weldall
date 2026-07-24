---
version: alpha
name: Weldall Border-First Admin Interface
description: A neutral administration UI that defines surfaces with borders instead of box-shadows.
colors:
  background-body: "#f1f1f1"
  background-surface: "#ffffff"
  background-muted: "#f1f1f1"
  text-primary: "#171717"
  text-secondary: "#737373"
  border: "#ebebeb"
  primary: "#262626"
  on-primary: "#ffffff"
typography:
  display:
    fontFamily: Geist, Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 2.625rem
    fontWeight: "400"
    lineHeight: "1.2381"
  heading-1:
    fontFamily: Geist, Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 1.5rem
    fontWeight: "600"
    lineHeight: "1.3333"
  heading-2:
    fontFamily: Geist, Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 1.25rem
    fontWeight: "600"
    lineHeight: "1.4"
  body:
    fontFamily: Geist, Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 0.875rem
    fontWeight: "400"
    lineHeight: "1.4286"
  supporting:
    fontFamily: Geist, Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 0.75rem
    fontWeight: "400"
    lineHeight: "1.6667"
rounded:
  sm: 0.375rem
  md: 0.625rem
  lg: 0.75rem
  page: 1.75rem
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  surface-panel:
    backgroundColor: "{colors.background-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  muted-panel:
    backgroundColor: "{colors.background-muted}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  input-field:
    backgroundColor: "{colors.background-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 8px 12px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 8px 12px
  button-secondary:
    backgroundColor: "{colors.background-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 8px 12px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 8px 12px
  button-destructive:
    backgroundColor: destructive
    textColor: on-destructive
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 8px 12px
---

## Overview

Weldall uses a calm, neutral admin interface based on the Astryx design framework. The UI should feel precise and operational rather than decorative. Structure comes from spacing, typography, and a small number of intentional surfaces.

The login screen is the reference pattern: true surfaces sit directly on the body background, use a white/surface fill, and are defined by a clear border. Do not create depth with shadows, and do not turn simple sections or layout divs into bordered boxes.

## Colors

Use Astryx neutral theme tokens whenever possible.

- **Body:** `background-body` is the page wash behind navigation and content.
- **Surface:** `background-surface` is used for cards, forms, tables, and panels.
- **Muted:** `background-muted` is only for secondary grouping or low-emphasis areas.
- **Borders:** `border` (`#ebebeb`) is the only allowed border color for UI boundaries in every color mode.
- **Text:** keep primary copy on `text-primary`; use `text-secondary` for metadata, descriptions, labels, and table support text.

## Typography

Typography should be functional and quiet. Use Astryx `Text` styles or equivalent Tailwind sizing. Avoid oversized decorative headings outside marketing/auth screens.

- Page titles use `heading-1`.
- Section titles use `heading-2` or body text with semibold weight.
- Labels, helper text, metadata, and table captions use `supporting` with `text-secondary`.

## Layout

Use generous but consistent spacing. Panels usually use 16px padding (`p-4`) and forms may use 20px (`p-5`) when field density needs more breathing room.

Content should align to a simple vertical stack with clear section gaps. Simple sections should rely on heading hierarchy, spacing, `<hr className="border-border" />` separators, row dividers, and muted backgrounds—not bordered wrapper divs. Only promote content into a bordered surface when it is a real standalone card or persistent panel. Full-page admin forms and tables remain borderless; their controls and rows own any necessary boundaries.

All admin content areas are full width within the app shell padding, including detail, edit, and create routes. Do not center or cap admin content with dynamic width utilities such as `mx-auto`, `max-w-3xl`, `max-w-5xl`, or `max-w-6xl`. Colored admin headlines and the content below must share the same left/right padding so their text edges sit flush.

## Elevation & Depth

Weldall is **border-first and shadowless**.

- Do not use `box-shadow`, Tailwind `shadow-*`, or framework shadow/elevation props for application surfaces.
- Real cards and persistent panels may use `border: 1px solid var(--color-border)` on `background-surface`; full-page admin forms and tables must not use an outer border.
- Simple sections, layout divs, and content groups should not get a border just to make a box; prefer `<hr className="border-border" />` between adjacent sections.
- Wrapping content in an extra bordered div is an absolute no-go; one component owns its surface, and nested border wrappers are not allowed.
- Do not use black, white-alpha, theme-dark, semantic, or emphasized border colors for surfaces and controls.
- Separate adjacent regions with `<hr className="border-border" />`, row dividers, spacing, or muted backgrounds first; use a border only when it belongs to the component itself.
- Popovers and dialogs should still prefer a visible border over drop shadows when custom styling is available.

## Shapes

Use the Astryx radius scale.

- Standard panels and forms: `rounded-lg` / `0.75rem`.
- Controls and compact rectangles: `rounded-md` / `0.625rem`.
- Pills and avatars: `rounded-full`.

## Components

### Herocrumbs

Admin routes use `AdminPageChrome` and `Herocrumbs` for the colored top section. Herocrumbs own the gradient, noise texture, headline animation, route title, and action target. Top-level admin pages render a single route title. Nested create and detail routes remain within the same shared page chrome instead of implementing their own headline surface. Do not render metadata, descriptions, or status text inside the colored section.

`AdminPageChrome` must render Herocrumbs for every authenticated admin route. Pages place actions in the shared headline through `HerocrumbsActions`; they must not wrap themselves in another Herocrumbs container or reimplement the gradient and animation.

Keep Herocrumbs full-bleed to the app shell edge, then render page content below at full width using the same horizontal padding. Do not add per-page max-width wrappers below it.

### Table handling

Use Astryx table primitives for visual structure and TanStack Table for state/data handling. Prefer `TableHeader`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell`, and `TableContext` over Astryx `<Table>` when Weldall needs to own sorting, filtering, visibility, pagination, virtualization, or server/client state. Keep column definitions explicit with TanStack `ColumnDef`, render through `flexRender`, and wire row models/state via `useReactTable`.

Persist table state in URL query params with `nuqs` (`useQueryState`/`useQueryStates`) so sorting, filters, pagination, and visibility can be shared and restored. Use compact, readable query values where possible (for example `sort=lastActivityAt.desc&q=martin`), clear default/empty values from the URL, and keep TanStack as the source of row-model behavior.

Table cells should stay atomic: use separate columns for separate facts (name, email, team names, last activity date, identity counts, activity counts) instead of stacking unrelated metadata into one cell. Never wrap tables in an extra bordered div. If a route calls for a borderless data grid, let the table sit full-width in the content area and keep `dividers="none"`; otherwise let the table component own row/grid dividers itself. Do not migrate unrelated tables opportunistically; convert one table surface at a time.

### Surface panels

Use bordered panels only for real standalone panels, not ordinary page sections:

```tsx
<section className="border-border bg-surface rounded-lg border p-4">...</section>
```

Full-page admin forms stay borderless and full width. Structure them with headings, spacing, separators, and bordered form controls instead of wrapping the form in a card surface.

Do not add a bordered wrapper around a section, form, table, or div that already has its own structure. Never add `shadow-sm`, `shadow`, or other `shadow-*` utilities to these containers.

### Inputs and forms

Inputs should look inset through their own border and background, matching the login screen’s card treatment. Prefer Astryx form components where available; otherwise use a 1px border, surface fill, and clear focus state.

### Buttons

Use Astryx `Button` for application actions and links styled as actions. Button styling is limited to the four Astryx variants: `primary`, `secondary`, `ghost`, and `destructive`.

- **Primary:** the main action in the current view, such as creating, saving, running, or opening the primary edit flow.
- **Secondary:** supporting actions with normal emphasis.
- **Ghost:** low-emphasis actions that should stay visually quiet.
- **Destructive:** dangerous or irreversible actions.

Do not create bespoke button-like anchors or Tailwind button classes (`rounded border px-*`, custom black fills, red text buttons, etc.). Use `Button href="..."` for navigation that should look like a button.

During async work, keep the button label stable and set the component's `isLoading` prop; do not swap the text to "Saving…", "Creating…", "Running…", etc. or manually disable the button just because it is loading. Reserve `isDisabled` for non-loading business rules such as invalid form state or missing permissions.

### Navigation

The sidebar follows the same border-first language. Weldall is rendered as text in the expanded sidebar and as a bordered rectangle containing its initial in collapsed mode.

## Do's and Don'ts

**Do**

- Use outer borders only for intentional cards and persistent panels; keep full-page admin forms and tables borderless.
- Keep simple sections borderless and let spacing, typography, `<hr />` separators, row dividers, and muted backgrounds create hierarchy.
- Keep backgrounds flat and token-based.
- Use Astryx examples and components as the source of interaction behavior.

**Don't**

- Add `box-shadow` or `shadow-*` to app UI.
- Simulate elevation with blurred shadows.
- Introduce custom colors when an Astryx token exists.
- Wrap simple sections, tables, or layout divs in bordered boxes.
- Use borderless white panels on white backgrounds.
