# Modification Strategy — Zoning PDF Digitization Workbench

> This document governs **how** the geojson.io codebase is modified to become a
> zoning digitization workbench. Agents and developers must follow the phased approach
> defined here. Do not skip phases. Do not conflate phases in a single PR unless
> explicitly approved.

---

## Guiding Principles

1. **Reversibility first.** Every phase should leave the codebase in a state where the
   standard geojson.io editing workflow still works. If a phase would break baseline
   functionality, it must be gated behind a feature flag.

2. **Thin vertical slices over big-bang rewrites.** Each phase must deliver something
   a human can open in a browser and use. No phase is "backend only" or "invisible."

3. **Separate concerns.** UI code, transform math, and data schema must live in
   separate modules from the first day. Do not mix coordinate transform logic with
   React component code.

4. **Schema stability.** The export schema defined in ARCHITECTURE.md is frozen from
   Phase 1. Changes require a documented migration.

5. **Human gates.** Each phase must include at least one point where a human can
   inspect and confirm work before it advances. Automation is additive — it never
   silently overwrites human decisions.

---

## Phase 1 — Split-Panel UI and Manual Polygon Export

### Objective
Establish the two-panel (PDF + map) layout, allow the user to load a PDF, draw
polygons manually on the map, assign a raw zoning label and planning_class by hand,
and export a valid GeoJSON file in the planning output schema.

No automation. No transform. Just the scaffolded UI and the export contract.

### Repo Areas Likely to Change
- `app/components/` — add `pdf_viewer/`, `feature_editor/`, `polygon_editor/` scaffolds
- `app/components/menu_bar.tsx` — add "Open PDF" and "Export Zoning GeoJSON" actions
- `state/` — add `state/digitizer.ts`, `state/digitizer_features.ts`
- `app/lib/` — add `validation_engine.ts`, `export_pipeline.ts`
- `pages/index.tsx` — conditionally render digitizer layout vs. standard geojson.io layout
- `styles/` — layout CSS for split-panel view

### New Dependencies (Candidates)
- `pdfjs-dist` — PDF.js for in-browser PDF rendering

### Success Criteria
- [ ] User can load a local PDF file; it renders in the left panel
- [ ] Map remains functional in the right panel
- [ ] User can draw a polygon on the map
- [ ] Feature editor panel shows `raw_zoning_label`, `planning_class`, `notes` inputs
- [ ] Export produces a valid GeoJSON FeatureCollection matching the output schema
- [ ] Standard geojson.io mode still works (no regressions)
- [ ] `validation_engine.ts` has unit tests passing

### Risks
- PDF.js bundle size may be significant; evaluate lazy loading or dynamic import
- Layout changes may conflict with existing responsive CSS in geojson.io
- The existing panel/mode system in geojson.io may need careful extension

### Out of Scope for Phase 1
- Georeferencing / GCPs
- OCR or any AI assistance
- PDF overlay on the map
- Automated geometry suggestions

---

## Phase 2 — Ground Control Point Alignment and Transform

### Objective
Allow the user to select matched point pairs between the PDF view and the map view
(ground control points), compute a coordinate transform, and render the PDF as a
warped overlay on the map so the user can trace polygons that align to real geography.

### Repo Areas Likely to Change
- `app/components/control_points/` — GCP placement UI (linked click mode)
- `app/components/pdf_viewer/` — GCP marker overlay on PDF canvas
- `app/components/map_component.tsx` — GCP marker layer + PDF raster overlay layer
- `state/control_points.ts` — GCP pair state
- `app/lib/transform_engine.ts` — affine and projective transform math
- `test/transform_engine.test.ts` — unit tests with known GCP fixtures

### New Dependencies (Candidates)
- None required — transform math is pure TypeScript
- Optional: `ml-matrix` or similar for least-squares fitting if needed

### Success Criteria
- [ ] User can enter "GCP mode" and click a point on PDF, then click the matching point on the map
- [ ] At least 3 GCPs placed → transform is computed and applied
- [ ] PDF is rendered as a semi-transparent overlay on the map, visually aligned to basemap
- [ ] Drawn polygons inherit coordinates from map space (WGS-84), not PDF space
- [ ] Transform engine has unit tests with ≥3 known GCP fixtures
- [ ] GCPs are saved in session state; overlay can be toggled on/off

### Risks
- Projective transform from PDF pixel space to WGS-84 may accumulate error; must surface
  residual error to the user after GCP computation
- PDF overlay on Mapbox GL requires rasterizing the PDF page to a canvas and using it
  as a custom raster source — this has performance limits for large PDFs

### Out of Scope for Phase 2
- Automatic GCP detection
- OCR or classification
- Batch processing

---

## Phase 3 — OCR-Assisted Label Extraction and Metadata Suggestions

### Objective
When a polygon is drawn or selected, allow the user to request OCR on the corresponding
region of the PDF. Surface the OCR result as a suggested `raw_zoning_label`. Then apply a
classification lookup (or LLM call) to suggest a `planning_class` with a confidence score.
The user must explicitly confirm or override all suggestions.

### Repo Areas Likely to Change
- `app/lib/ocr_adapter.ts` — implement at least one concrete adapter (Tesseract WASM)
- `app/lib/classification_adapter.ts` — implement lookup-table adapter
- `app/components/ai_assist/` — OCR trigger button, suggestion display, confidence badge,
  accept/reject/edit controls
- `app/components/feature_editor/` — wire AI assist suggestions into the feature editor
- `state/digitizer_features.ts` — add `ai_suggestions` sub-state per feature

### New Dependencies (Candidates)
- `tesseract.js` — in-browser OCR (evaluate WASM size and accuracy on zoning text)
- Planning-class lookup table (JSON file in `public/` or bundled)

### Success Criteria
- [ ] "Detect label" button triggers OCR on the PDF region corresponding to the selected polygon
- [ ] OCR result appears as a suggested value in the `raw_zoning_label` field
- [ ] Classification suggestion appears with a confidence indicator (0–100%)
- [ ] User can accept, reject, or override each suggestion
- [ ] `human_confirmed` is only set to `true` after explicit user acceptance
- [ ] Features with low-confidence suggestions (<0.5) are visually flagged and blocked from export
  until the user confirms them
- [ ] OCR adapter falls back gracefully (no crash) when Tesseract is unavailable

### Risks
- OCR accuracy on scanned or low-resolution PDFs may be poor; must not mislead user
- Tesseract WASM adds significant bundle weight; must be dynamically imported
- Classification lookup table must be versioned and kept in sync with downstream pipeline vocabulary

### Out of Scope for Phase 3
- Automatic polygon detection from PDF
- Batch OCR across all pages
- LLM-based classification (interface only; lookup table is the concrete adapter)

---

## Phase 4 — Semi-Automated Polygon Suggestion and Geometry Validation

### Objective
Provide assisted polygon tracing: detect candidate region boundaries from the PDF
(e.g., color region segmentation or vector path extraction), present them as
suggested polygon outlines that the user can accept, reject, or reshape. Add topology
validation (overlap detection, gap detection, minimum area checks).

### Repo Areas Likely to Change
- `app/lib/ocr_adapter.ts` or new `app/lib/region_detector.ts` — PDF region segmentation
- `app/components/polygon_editor/` — suggestion overlay, accept/reject/reshape flow
- `app/lib/validation_engine.ts` — topology checks (overlap, gap, sliver detection)
- `app/components/ai_assist/` — validation message panel

### New Dependencies (Candidates)
- Vector path extraction from PDF.js operator list (no new package needed if using PDF.js)
- `@turf/turf` (already likely present via geojson.io) for topology checks
- Optional: remote computer-vision endpoint behind the `OcrAdapter` interface

### Success Criteria
- [ ] Suggested polygon outlines from PDF vector paths (or color regions) are rendered as
  dashed preview overlays on the map
- [ ] User can click a suggestion to accept it as a polygon (it becomes editable)
- [ ] Validation panel surfaces overlap and gap warnings before export
- [ ] Export is blocked (with a clear message) if there are unresolved validation errors
- [ ] All suggestions treated as unconfirmed until user explicitly accepts

### Risks
- PDF vector path extraction is only possible if the PDF contains actual vector data;
  scanned raster PDFs have no extractable paths — must degrade to manual tracing
- Color-region segmentation on a canvas is heuristic and may produce many false candidates
- Topology checks on large feature sets may be slow; consider web workers

### Out of Scope for Phase 4
- Fully automatic map generation without human review
- Cross-page topology validation

---

## Phase 5 — Batch-Assisted Workflows with Human Review Gates

### Objective
Enable processing of multi-page or multi-file zoning maps with reduced manual effort.
Provide a review queue where AI-suggested features are presented to a human one by one
for confirmation. Add project-level session management (save/restore progress).
Establish the handoff protocol to the downstream Python pipeline.

### Repo Areas Likely to Change
- `app/components/` — review queue panel, project session manager
- `state/` — project-level session state, serialization/deserialization
- `app/lib/export_pipeline.ts` — batch export, pipeline handoff format
- `pages/` — project dashboard page (list of PDFs in a digitization project)

### New Dependencies (Candidates)
- IndexedDB wrapper (e.g., `idb`) for local project persistence
- Optional: remote storage adapter behind an interface

### Success Criteria
- [ ] User can save and restore a digitization session (PDF, GCPs, features) from local storage
- [ ] Review queue shows AI-suggested features with confidence scores; user confirms or rejects
- [ ] A project can include multiple PDF pages; processed pages are tracked
- [ ] Batch export produces a single GeoJSON FeatureCollection per project
- [ ] Every exported feature has `human_confirmed: true` — no unreviewed features in export
- [ ] Handoff format is documented and matches the downstream Python pipeline contract

### Risks
- IndexedDB storage limits may be hit for very large PDF files (store file references, not blobs)
- Multi-page GCP alignment requires per-page transform storage; design must be extended from Phase 2
- Human review queue UX must prevent fatigue-driven rubber-stamping; consider mandatory
  slow-review mode for low-confidence batches

### Out of Scope for Phase 5
- Fully autonomous pipeline with no human in the loop
- Cloud storage or multi-user collaboration
- Integration with external GIS platforms

---

## Phase Dependencies

```
Phase 1 (split panel + manual export)
    └── Phase 2 (GCP alignment + transform)
            └── Phase 3 (OCR + label suggestion)
                    └── Phase 4 (polygon suggestion + validation)
                            └── Phase 5 (batch review + session management)
```

Phases are sequential. A phase is considered complete when all its success criteria
are checked and verified in a browser test or unit test. Do not start the next phase
until the current one is complete.

---

_Last updated: initial scaffold — see ARCHITECTURE.md for module details._
