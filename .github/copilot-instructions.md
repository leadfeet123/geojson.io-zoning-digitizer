# GitHub Copilot Instructions — Zoning PDF Digitization Workbench

This repository is a fork of **geojson.io** modified to serve as a browser-based
zoning PDF digitization workbench for statewide planning. Before suggesting or
generating any code, internalize the following constraints.

---

## What This Codebase Is

- A **React + TypeScript + Vite** single-page application
- Built on **geojson.io** — a mature open-source GeoJSON editing tool
- Being extended with: PDF rendering, coordinate georeferencing, zoning label
  assignment, and structured GeoJSON export for a planning pipeline
- Governed by `ARCHITECTURE.md`, `MODIFICATION_STRATEGY.md`, and `AGENTS.md`

---

## Architecture Priorities (Highest to Lowest)

1. **Correctness of geospatial data** — wrong coordinates or schema violations
   corrupt downstream data. Verify geometry and schema before exporting.
2. **Maintainability** — prefer clear, separated modules over clever one-liners.
   A future developer must be able to understand each module in isolation.
3. **Human confirmability** — every AI-suggested value must be visible and
   overridable by the user before it enters the export.
4. **Performance** — optimize only where there is a measured bottleneck.
5. **Feature completeness** — build the right foundation before adding features.

---

## What to Preserve

- **All existing geojson.io editor capabilities** must remain functional when the
  digitizer mode is not active. Do not remove, rename, or disable any existing
  draw, edit, or export functionality.
- **Existing state atoms** in `state/` must not be removed or renamed without a
  documented migration plan.
- **Existing tests** must not be deleted or weakened. If a refactor causes test
  failures, fix the tests correctly — do not skip or comment them out.

---

## What to Avoid

- **Do not introduce a required backend server.** The app must run as a static SPA.
  Optional AI integrations (OCR, classification) must go behind adapter interfaces
  that degrade gracefully when no concrete implementation is available.
- **Do not make direct API calls from React components.** Route all external
  calls through the adapter interfaces defined in `app/lib/`.
- **Do not inline transform math in components.** All coordinate transforms belong
  in `app/lib/transform_engine.ts`.
- **Do not add large new dependencies without justification.** Before adding a
  package, verify: (a) it is necessary, (b) it is actively maintained, (c) its
  bundle impact is acceptable (check with dynamic import if large).
- **Do not use `any` in TypeScript** unless behind an explicit type guard with a
  comment explaining why.
- **Do not claim automation is complete when it is not.** Label stubs clearly with
  `// TODO(phase-N):` comments.

---

## Testing Expectations

- Every module in `app/lib/` must have unit tests in `test/` or co-located.
- Tests use **Vitest** (existing setup in `test/setup.ts`).
- Geospatial transform tests must use fixed GCP fixtures with known expected outputs.
- Export pipeline tests must validate schema compliance of the output.

---

## Experimental AI Integrations

OCR, classification suggestion, and polygon detection are **experimental features**
gated behind adapter interfaces. When working in these areas:

- Keep the interface (`OcrAdapter`, `ClassificationAdapter`) stable.
- Mark concrete adapter implementations clearly as experimental.
- Surface confidence scores; never hide uncertainty from the user.
- Require `human_confirmed: true` before any AI-suggested feature can be exported.

---

## Output Schema (Frozen)

The GeoJSON output schema is defined in `ARCHITECTURE.md`. It is **frozen** — do not
change field names, types, or required/optional status. Any proposed change requires
a `SCHEMA_MIGRATION.md` entry.

---

## How to Approach a Change

1. Read `ARCHITECTURE.md` to understand where the change belongs.
2. Read `MODIFICATION_STRATEGY.md` to confirm the change is in scope for the current phase.
3. Read `AGENTS.md` to check constraints and prohibited actions.
4. Make the smallest change that satisfies the requirement.
5. Add or update tests for any logic you touch.
6. Verify `npm run build` passes and existing tests still pass.
