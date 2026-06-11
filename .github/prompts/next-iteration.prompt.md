---
mode: agent
description: Start a new iteration on the zoning digitizer workbench. Forces inspection of architecture and strategy docs before making any changes.
---

# Next Iteration — Zoning Digitizer Workbench

You are a senior geospatial web developer continuing work on this repository.

**You must complete the following steps before writing a single line of code.**

---

## Step 0 — Mandatory Pre-Read

Read these files now. Do not skip any of them.

1. `ARCHITECTURE.md` — understand the module design, UI regions, and output schema
2. `MODIFICATION_STRATEGY.md` — understand the current phase, success criteria, and scope boundaries
3. `AGENTS.md` — understand constraints, prohibited actions, and iteration rules

After reading, answer these questions internally before proceeding:

- What is the current phase?
- Which success criteria for that phase are already met (checked)?
- Which success criteria remain unmet?
- What is the smallest change that advances the next unmet criterion?
- Does the change I'm about to make stay within the current phase boundary?

If you cannot answer these questions, re-read the documents.

---

## Step 1 — Inspect the Codebase State

Run the following checks to understand current state:

1. Check which Phase 1 files exist:
   - `app/components/pdf_viewer/` — does it exist?
   - `app/components/feature_editor/` — does it exist?
   - `app/lib/validation_engine.ts` — does it exist?
   - `app/lib/export_pipeline.ts` — does it exist?
   - `state/digitizer.ts` — does it exist?
   - `state/digitizer_features.ts` — does it exist?
   - `types/digitizer.ts` — does it exist?

2. Run `npm run build` and note any TypeScript errors.

3. Run `npm run test` and note which tests pass, which fail, which are missing.

4. Open or review `pages/index.tsx` to understand how the digitizer mode is currently
   integrated (if at all).

---

## Step 2 — Identify the Next Action

Based on your inspection:

- If Phase 1 success criteria are not all met → work on Phase 1
- If Phase 1 is complete → confirm this explicitly, then begin Phase 2 scope
- If a bug or regression is present → fix it before advancing

State your next action in one sentence before beginning.

---

## Step 3 — Implement

Follow these rules during implementation:

### Scope
- Stay within the current phase scope (see `MODIFICATION_STRATEGY.md`)
- If something is out of scope, add a `// TODO(phase-N):` comment and move on
- Do not begin the next phase in the same iteration

### Code quality
- No `any` without a type guard and comment
- No inline transform math in components — use `app/lib/transform_engine.ts`
- No direct API calls from components — use adapter interfaces
- No new packages without justification

### Preservation
- Confirm after your change that standard geojson.io mode still loads and works
- Do not delete or skip existing passing tests

### Human confirmability
- Any AI-suggested field must surface a confidence score
- Any feature with `confidence < 0.5` must be visually flagged
- `human_confirmed` must only be set via explicit user action

---

## Step 4 — Validate Before Declaring Done

Do not declare the task complete until:

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm run test` passes — no new test failures, no skipped tests
- [ ] Any new `app/lib/` module has unit tests
- [ ] The standard geojson.io editor still works (no regressions)
- [ ] Any new UI shows no console errors in the browser
- [ ] Any changes to exported GeoJSON still match the output schema in `ARCHITECTURE.md`

---

## Step 5 — Summarize What You Did

After completing the work, provide a brief summary:

1. What phase you were working on
2. Which success criterion you advanced (quote it from `MODIFICATION_STRATEGY.md`)
3. What files you changed or created
4. What tests you added or updated
5. What the next action should be (the next unmet success criterion)
6. Any new entries for the Assumptions Log in `AGENTS.md`

---

## Constraints Reminder (from AGENTS.md)

- Never remove core geojson.io editing capabilities
- Never mix transform math into React components
- Never implement OCR, classification, or AI features outside adapter interfaces
- Never require a backend server
- Never change the output schema without a `SCHEMA_MIGRATION.md` entry
- Never set `human_confirmed: true` without explicit user action
- Never merge if `npm run build` fails
- Never delete or skip passing tests
