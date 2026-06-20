---
mode: agent
description: Scaffold the initial Phase 1 thin vertical slice of the zoning digitizer workbench.
---

# Scaffold Digitizer — Phase 1 Thin Vertical Slice

You are a senior geospatial web developer working on a fork of geojson.io.

**Before writing any code, read these files in order:**

1. `ARCHITECTURE.md`
2. `MODIFICATION_STRATEGY.md`
3. `AGENTS.md`

Then implement exactly the Phase 1 scope defined in `MODIFICATION_STRATEGY.md`.
Do not implement Phase 2 or later.

---

## Your Goal

Deliver the thinnest possible vertical slice that lets a human:

1. Open the app and enter "digitizer mode"
2. Load a local PDF file — it renders in a left panel
3. See the existing geojson.io map in a right panel
4. Draw a polygon on the map (using existing Mapbox Draw)
5. Fill in `raw_zoning_label`, `planning_class`, and `notes` in a feature editor panel
6. Click Export and download a valid GeoJSON file matching the planning output schema

Standard geojson.io mode must still work. No regressions.

---

## Step-by-Step Implementation Order

### Step 1 — Add pdfjs-dist

Check if `pdfjs-dist` is already in `package.json`.
If not, add it with: `npm install pdfjs-dist`
Evaluate bundle size impact. Use a dynamic import so the library is only loaded
when the user enters digitizer mode.

### Step 2 — Add digitizer state atoms

Create `state/digitizer.ts` with Jotai atoms:

- `digitizerModeAtom` — boolean, default false
- `activePdfAtom` — stores `{ file: File, pageCount: number } | null`
- `activePdfPageAtom` — number, default 1

Create `state/digitizer_features.ts` with Jotai atoms:

- `digitizerFeaturesAtom` — array of digitizer features (see schema below)

### Step 3 — Add the validation engine stub

Create `app/lib/validation_engine.ts`:

- Export a `validateFeature(feature: DigitizerFeature): ValidationResult` function
- Export a `validateFeatureCollection(features: DigitizerFeature[]): ValidationResult[]` function
- Implement checks: required fields present, confidence in range [0,1],
  geometry is a Polygon or MultiPolygon
- Write unit tests in `test/validation_engine.test.ts`

### Step 4 — Add the export pipeline

Create `app/lib/export_pipeline.ts`:

- Export a `toGeoJSON(features: DigitizerFeature[], sourceName: string): GeoJSON.FeatureCollection`
- Enforce the output schema from `ARCHITECTURE.md`
- Set `source_type: "digitized"` and `digitized_at` to the current ISO 8601 timestamp
- Write unit tests in `test/export_pipeline.test.ts`

### Step 5 — Add the PDF viewer component scaffold

Create `app/components/pdf_viewer/PdfViewer.tsx`:

- Accept a `file: File | null` prop
- When file is null, render an upload prompt ("Drop a PDF or click to open")
- When file is present, render the first page of the PDF on a `<canvas>` element
- Add page navigation (prev/next buttons) if pageCount > 1
- Add a zoom control (at minimum: fit-to-panel)
- The canvas must expose its coordinate system for future GCP placement (Phase 2)
  Mark the GCP interface with a `// TODO(phase-2):` comment

### Step 6 — Add the feature editor panel scaffold

Create `app/components/feature_editor/FeatureEditor.tsx`:

- Show when a polygon is selected on the map (in digitizer mode)
- Inputs: `raw_zoning_label` (text), `planning_class` (text or select), `notes` (textarea)
- Show validation errors inline if fields are missing or invalid
- AI suggestion slots (stubbed): a disabled "Detect label" button with
  a `// TODO(phase-3):` comment
- Show `confidence` as a read-only field (default 1.0 for manually entered data)
- Show a "Confirm feature" checkbox that sets `human_confirmed: true`

### Step 7 — Integrate the split-panel layout

Modify `pages/index.tsx` minimally:

- Add a toggle button ("Open Digitizer") that sets `digitizerModeAtom` to true
- When digitizer mode is active, render a two-column layout:
  left: `PdfViewer`, right: existing map
- When digitizer mode is inactive, render the existing geojson.io layout unchanged
- Add an "Exit Digitizer" button that restores the standard layout

Alternatively, create a new page `pages/digitizer.tsx` if that avoids touching the
existing layout. Choose the approach that causes the smallest diff.

### Step 8 — Add Export action

Add an "Export Zoning GeoJSON" button to the menu or feature editor panel:

- Calls `validateFeatureCollection` — shows errors if any exist
- Calls `toGeoJSON` with current digitizer features
- Triggers a file download (`.geojson`)

---

## Type Definitions

Use these types throughout. Define them in `types/digitizer.ts`:

```typescript
export interface DigitizerFeature {
  id: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  properties: {
    planning_class: string;
    raw_zoning_label: string;
    confidence: number; // 0.0–1.0
    source_type: 'digitized';
    source_name: string;
    human_confirmed: boolean;
    notes?: string;
    digitized_at?: string;
    digitized_by?: string;
    ai_suggestions?: AiSuggestion[]; // Phase 3; optional
  };
}

export interface AiSuggestion {
  field: 'raw_zoning_label' | 'planning_class';
  value: string;
  confidence: number;
  accepted: boolean | null; // null = pending review
}

export interface ValidationResult {
  featureId: string | null;
  severity: 'error' | 'warning';
  message: string;
  field?: string;
}
```

---

## Completion Criteria

Before declaring this task complete, verify:

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm run test` passes — `validation_engine.test.ts` and `export_pipeline.test.ts` are green
- [ ] Opening the app in a browser: standard geojson.io editor works normally (no regressions)
- [ ] Clicking "Open Digitizer": split panel appears, left side shows PDF upload prompt
- [ ] Uploading a PDF: first page renders in the left panel
- [ ] Drawing a polygon on the map and selecting it: feature editor panel appears
- [ ] Filling in fields and clicking "Confirm feature": feature shows as confirmed
- [ ] Clicking "Export Zoning GeoJSON": file downloads with correct schema
- [ ] All new `app/lib/` modules have at least one unit test

---

## Constraints

- Do not implement GCPs, transform, OCR, or classification (Phase 2+)
- Do not require a backend server
- Do not use `any` without a type guard
- Do not remove existing geojson.io functionality
- Mark all Phase 2+ stubs with `// TODO(phase-N):`
