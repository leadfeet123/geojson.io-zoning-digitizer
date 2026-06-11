# AGENTS.md — Zoning PDF Digitization Workbench

> This file governs how AI coding agents operate on this repository.
> Read this file in full before making any change. Do not skip sections.

---

## Project Overview

This repository is a fork of [geojson.io](https://github.com/mapbox/geojson.io), modified
to serve as a **browser-based zoning PDF digitization workbench** for statewide planning.

Users load a zoning PDF, align it to a georeferenced basemap via ground control points,
draw or refine polygons, assign zoning labels and planning classes (with AI assistance),
and export structured GeoJSON. The exported GeoJSON feeds a downstream Python geospatial
processing pipeline.

**This is a human-in-the-loop tool.** Automation assists human operators; it does not
replace human judgment or silently modify confirmed work.

**Primary reference documents (read before acting):**
- `ARCHITECTURE.md` — module design, output schema, UI regions
- `MODIFICATION_STRATEGY.md` — phased delivery plan with success criteria

---

## Current Maturity and Goals

**Current phase:** Phase 1 scaffolding (see `MODIFICATION_STRATEGY.md`).

The codebase is at its starting point. The digitizer modules described in `ARCHITECTURE.md`
do not yet exist. The standard geojson.io editor functionality is fully intact.

**Current goals:**
1. Scaffold the split-panel layout (PDF viewer + map)
2. Add the feature editor panel with schema-compliant fields
3. Add the export pipeline with the planning output schema
4. Add a stub validation engine with unit tests

**Do not attempt Phase 2 or later until Phase 1 success criteria are checked.**

---

## Architecture Guardrails

These rules are non-negotiable:

1. **Never remove core geojson.io editing capabilities.** The standard draw, edit, and
   export workflow must remain functional when the digitizer is not active. Gate new
   features behind a digitizer mode flag.

2. **Never mix coordinate transform logic with React component code.** Transform math
   lives in `app/lib/transform_engine.ts` only. Components call transform functions;
   they do not implement them.

3. **Never implement OCR, classification, or AI polygon extraction inline.** These must
   go behind the adapter interfaces defined in `ARCHITECTURE.md`. A null adapter that
   returns empty results is acceptable. A hard-coded API call inside a component is not.

4. **Never require a backend server.** The tool must run as a static single-page app.
   Optional AI integrations must degrade gracefully when unavailable.

5. **Never change the output schema without a migration note.** Field names, types, and
   required/optional status are frozen from Phase 1. Any change needs an explicit
   `SCHEMA_MIGRATION.md` entry and must be flagged in the PR description.

6. **Never set `human_confirmed: true` programmatically without explicit user action.**
   A button click, checkbox, or keyboard shortcut counts. A background process does not.

7. **Never export a feature with `confidence < 0.5` and `human_confirmed: false`.**
   The validation engine must block such exports with a clear error message.

---

## Coding Conventions

### Language and Framework
- TypeScript strict mode. No `any` unless behind a type guard.
- React functional components with hooks. No class components.
- Jotai for state management. New atoms go in `state/`. Do not use React context
  for shared digitizer state.
- Tailwind CSS for layout and utility styles. Custom CSS only when Tailwind cannot
  express the style.

### File Structure
Follow the target directory layout in `ARCHITECTURE.md`. New modules go in their
designated directories. Do not create flat top-level files for modules that belong
in `app/lib/` or `app/components/`.

### Testing
- All pure logic modules (`transform_engine`, `validation_engine`, `export_pipeline`,
  adapter interfaces) must have co-located or `test/`-housed unit tests.
- Tests must use the existing test runner (Vitest, as per `package.json`).
- A PR that adds a new lib module without tests will be rejected.

### Naming
- Components: `PascalCase` files and exports (`PdfViewer.tsx`)
- Lib modules: `snake_case` files (`transform_engine.ts`)
- State atoms: `camelCase` with `Atom` suffix (`gcpPairsAtom`)
- Constants: `SCREAMING_SNAKE_CASE`

### Imports
- Use TypeScript path aliases (`@/`) where configured.
- Do not use relative `../../` imports across major module boundaries (e.g., from
  `components/` into `state/` via a long relative path). Use the alias.

### Comments
- Add a JSDoc comment to every exported function and type in `app/lib/`.
- Do not add comments to code that is self-explanatory. Prefer clear naming.
- Add a `// TODO(phase-N):` comment on any stub or placeholder that is out of scope
  for the current phase, where N is the phase that will implement it.

---

## File Ownership Guidance

| Path | Ownership | Notes |
|---|---|---|
| `ARCHITECTURE.md` | Human architect | Do not rewrite without human review |
| `MODIFICATION_STRATEGY.md` | Human architect | Do not rewrite without human review |
| `AGENTS.md` | Human architect | Do not rewrite without human review |
| `app/lib/transform_engine.ts` | Coding agent (Phase 2) | Pure math — must have tests |
| `app/lib/ocr_adapter.ts` | Coding agent (Phase 3) | Interface + null adapter only |
| `app/lib/classification_adapter.ts` | Coding agent (Phase 3) | Interface + lookup table only |
| `app/lib/validation_engine.ts` | Coding agent (Phase 1) | Must have tests |
| `app/lib/export_pipeline.ts` | Coding agent (Phase 1) | Must have tests |
| `app/components/pdf_viewer/` | Coding agent (Phase 1) | UI only; no transform logic |
| `app/components/control_points/` | Coding agent (Phase 2) | UI only; no transform logic |
| `state/digitizer.ts` | Coding agent (Phase 1) | Jotai atoms only |
| `state/control_points.ts` | Coding agent (Phase 2) | Jotai atoms only |
| `pages/index.tsx` | Coding agent (careful) | Minimal change; add mode flag only |
| `app/components/map_component.tsx` | Coding agent (careful) | Extend, do not rewrite |
| `app/components/menu_bar.tsx` | Coding agent (careful) | Add actions; do not remove existing |

---

## Iteration Rules

Before starting any work:
1. Read `ARCHITECTURE.md` and `MODIFICATION_STRATEGY.md`.
2. Identify the current phase (check which Phase 1 success criteria are unchecked).
3. Limit your changes to the current phase only.
4. Prefer the smallest change that advances the success criteria.

During implementation:
5. If a change would touch a "careful" file (see ownership table), explain your reasoning
   before making the change and keep the diff minimal.
6. If a dependency is not yet in `package.json`, justify why it is necessary before adding it.
7. If you are unsure whether a change belongs in the current phase, it probably does not.
   Mark it with `// TODO(phase-N):` and move on.
8. Never rewrite a module that already has passing tests without a documented reason.

After implementation:
9. Confirm that `npm run build` (or equivalent) still passes.
10. Confirm that existing tests still pass.
11. Confirm that the digitizer mode can be entered and exited without breaking the baseline editor.

---

## Validation Rules

Agents must verify the following before declaring a task complete:

### Schema validation
- Every exported feature has all required fields from the output schema.
- `source_type` is always the string `"digitized"`.
- `human_confirmed` is always a boolean, not a string.
- `confidence` is always a number between 0.0 and 1.0.

### Geometry validation
- All exported geometries are valid GeoJSON (`Polygon` or `MultiPolygon`).
- No self-intersecting rings.
- Coordinates are in WGS-84 (lon/lat), not PDF pixel space.

### UI validation
- The left PDF panel and right map panel render without errors when a PDF is loaded.
- The baseline geojson.io editor still works when no PDF is loaded.
- All new UI controls have accessible labels (aria attributes or visible text labels).

### Test validation
- All unit tests pass.
- No tests have been deleted or skipped to make the suite pass.

---

## What NOT to Change Casually

The following are high-risk areas. Do not modify them without a clear, documented reason
and a minimal diff:

- **`pages/index.tsx`** — the application entry point
- **`app/components/map_component.tsx`** — core map initialization
- **`app/components/menu_bar.tsx`** — core navigation
- **`state/index.ts`** — root state atom wiring
- **`vite.config.ts`** — build configuration
- **`tsconfig.json`** — TypeScript configuration
- **Any existing test file** — do not delete or weaken existing tests
- **The output schema** — frozen; changes require explicit migration

---

## Assumptions Log

Agents must document non-obvious assumptions here when they are made.

| Date | Assumption | Made by | Validated? |
|---|---|---|---|
| initial | PDF.js (`pdfjs-dist`) will be the PDF rendering library | architect | No — evaluate in Phase 1 |
| initial | Transform engine will use a direct linear least-squares affine solve | architect | No — validate in Phase 2 |
| initial | Tesseract.js is the OCR library for Phase 3 (evaluate accuracy on zoning text) | architect | No — evaluate in Phase 3 |
| initial | The downstream Python pipeline consumes GeoJSON matching the schema in ARCHITECTURE.md | architect | No — confirm with pipeline team |

---

## Automation Confidence Rules

When proposing or implementing AI-assisted features:

- **Never claim a feature is "fully automated" unless all edge cases produce correct output.**
- **Always surface confidence scores to the user.** Do not hide uncertainty.
- **Low-confidence results (< 0.5) must be visually flagged** and must require explicit
  human confirmation before they can be exported.
- **When confidence is ambiguous or cannot be computed, default to 0.0** and require
  human review.
- **Do not batch-confirm features on behalf of the user.** Each feature must be confirmed
  individually, or the user must explicitly trigger a "confirm all" action that shows
  them a summary first.

---

## Prohibited Actions

The following are explicitly prohibited for all agents:

- Removing or disabling the standard geojson.io draw/edit workflow
- Adding `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why
- Calling a remote API endpoint from a component directly (must go through an adapter)
- Writing to `localStorage` or `IndexedDB` without documenting the key schema
- Generating or guessing map tile URLs (use only configured providers)
- Claiming that OCR, auto-vectorization, or AI polygon extraction is complete when only
  an interface or stub is in place
- Merging a PR that causes `npm run build` to fail
- Merging a PR that deletes or skips existing passing tests

---

_This AGENTS.md was established at the initial project scaffold.
Update the Assumptions Log as the project evolves.
All other sections require human architect review to modify._
