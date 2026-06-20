# Architecture — Zoning PDF Digitization Workbench

> This document is the authoritative design reference for the zoning digitization workbench
> built on top of [geojson.io](https://github.com/mapbox/geojson.io).
> Agents and developers must read this before making structural changes.

---

## Product Purpose

A **browser-based zoning PDF digitization workbench** that enables planners and GIS technicians to
convert scanned or vector zoning maps (supplied as PDFs) into structured, georeferenced GeoJSON.

The tool is designed for **human-in-the-loop** workflows. Automation assists but does not replace
human judgment. Confidence must always be surfaced to the user; low-confidence outputs must require
explicit human confirmation before they are accepted into the export.

The GeoJSON produced here feeds a downstream Python geospatial processing pipeline and must
conform to the defined output schema at all times.

This tool is **not** the statewide processing pipeline. It is a web-based digitization
workbench — one step in a larger statewide planning workflow.

---

## Core Workflow

```
1. Load PDF zoning map
        ↓
2. Load basemap / parcel reference layers
        ↓
3. Select ground control points (GCPs) between PDF space and map space
        ↓
4. Compute affine / projective transform from PDF → WGS-84 coordinates
        ↓
5. Draw or refine polygons on the map (assisted by transformed PDF overlay)
        ↓
6. Detect / manually enter raw zoning labels (OCR-assisted, Phase 3+)
        ↓
7. Suggest normalized planning_class (AI-assisted, Phase 3+)
        ↓
8. Validate geometry and metadata (overlap, gap, schema compliance)
        ↓
9. Export GeoJSON in the planning output schema
```

---

## Major UI Regions

```
┌──────────────────────────┬──────────────────────────┐
│                          │                          │
│      LEFT PANEL          │      RIGHT PANEL         │
│      PDF Viewer          │   Interactive Map        │
│                          │   (Mapbox GL / MapLibre)  │
│  - Render PDF pages      │  - Basemap tiles         │
│  - Overlay GCP markers   │  - Parcel reference layer│
│  - Highlight regions     │  - Drawn polygons        │
│                          │  - GCP markers           │
│                          │  - PDF overlay (warped)  │
│                          │                          │
├──────────────────────────┴──────────────────────────┤
│                                                      │
│   BOTTOM / SIDE PANEL — Feature Editor / AI Assist  │
│                                                      │
│  - Selected feature properties                       │
│  - raw_zoning_label input (manual + OCR suggestion)  │
│  - planning_class suggestion + confidence indicator  │
│  - Validation messages (errors, warnings)            │
│  - Notes field                                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

The existing geojson.io right-side feature panel may be adapted or replaced by the
Feature Editor panel. The core map editing capabilities of geojson.io must be preserved.

---

## Main Technical Modules

### 1. PDF Document Viewer

- Renders PDF pages in the browser using **PDF.js** (or a thin wrapper)
- Exposes PDF coordinate space (page pixels) for GCP selection
- Supports page navigation, zoom, and pan
- File: `app/components/pdf_viewer/`

### 2. Control Point Manager

- Stores matched pairs of (PDF pixel coordinates, WGS-84 lon/lat)
- Minimum 3 GCPs for affine transform; 4+ for projective
- UI: click-to-place markers on PDF panel and map panel in a linked mode
- Persists GCPs in session state (not exported in final GeoJSON)
- File: `app/components/control_points/`
- State: `state/control_points.ts`

### 3. Georeferencing / Transform Engine

- Accepts an array of GCP pairs
- Computes the best-fit transform (affine or projective)
- Exposes `transformPoint(pdfX, pdfY) → [lon, lat]`
- Exposes `transformPolygon(pdfCoords[]) → GeoJSON geometry`
- Must be pure TypeScript, fully unit-testable, no map library dependency
- File: `app/lib/transform_engine.ts`

### 4. Polygon Editor

- Built on top of existing geojson.io draw/edit capabilities (Mapbox Draw)
- Extended with: snapping to parcel edges, duplicate-vertex detection,
  topology checks (overlap, gap detection within a batch)
- File: `app/components/polygon_editor/`

### 5. OCR and Label Suggestion Service Interface

- **Interface only** until a backend adapter is wired in (Phase 3+)
- Accepts: a clipped region of the PDF canvas (bitmap or PDF page crop)
- Returns: `{ text: string, confidence: number }[]`
- Concrete adapters can be: local Tesseract WASM, or a remote API endpoint
- File: `app/lib/ocr_adapter.ts` (interface + null adapter)

### 6. Classification Suggestion Interface

- **Interface only** until an AI adapter is wired in (Phase 3+)
- Accepts: `raw_zoning_label: string`, optional municipality context
- Returns: `{ planning_class: string, confidence: number, rationale: string }[]`
- Concrete adapters can be: local lookup table, remote LLM endpoint
- File: `app/lib/classification_adapter.ts` (interface + lookup-table adapter)

### 7. Validation Engine

- Checks individual features: geometry validity, required fields present,
  planning_class in allowed vocabulary, confidence threshold met
- Checks feature collection: no unresolved overlaps within same planning_class,
  no features with confidence below minimum without a human-confirmed flag
- File: `app/lib/validation_engine.ts`

### 8. Export Pipeline

- Converts internal Jotai state → GeoJSON FeatureCollection
- Enforces output schema (see below)
- Strips internal-only fields (GCPs, UI state)
- Supports download as `.geojson` and `.json`
- File: `app/lib/export_pipeline.ts`

---

## Recommended Technology Boundaries

| Concern                   | Boundary                                                              |
| ------------------------- | --------------------------------------------------------------------- |
| PDF rendering             | Browser only — PDF.js WASM                                            |
| Map rendering             | Browser only — existing Mapbox GL / MapLibre                          |
| Coordinate transform      | Browser only — pure TS, no server call                                |
| Polygon editing           | Browser only — Mapbox Draw (existing geojson.io)                      |
| OCR / label extraction    | Behind `OcrAdapter` interface — can be WASM or HTTP                   |
| Classification suggestion | Behind `ClassificationAdapter` interface — can be lookup table or LLM |
| Validation                | Browser only — deterministic rules                                    |
| Export                    | Browser only — deterministic serialization                            |

**Never introduce a required backend server.** Optional AI integrations must degrade gracefully
(i.e., the tool must remain fully functional with both adapters returning null/empty results).

---

## Output Schema

Every exported GeoJSON feature must support the following properties.
Fields marked **required** must be present and non-null at export time.

```jsonc
{
  "type": "Feature",
  "geometry": { /* GeoJSON Polygon or MultiPolygon — required */ },
  "properties": {
    "planning_class":     "string",   // required — normalized zoning class
    "raw_zoning_label":   "string",   // required — verbatim text from PDF or user input
    "confidence":         0.0–1.0,    // required — human=1.0, AI-suggested=model score
    "source_type":        "digitized", // required — always "digitized" from this tool
    "source_name":        "string",   // required — PDF filename or user-provided name
    "human_confirmed":    true|false, // required — true if a human explicitly accepted this feature
    "notes":              "string",   // optional — free text
    "digitized_at":       "ISO8601",  // required — set at export time
    "digitized_by":       "string"    // optional — user identifier if available
  }
}
```

**Schema stability is a hard constraint.** The downstream Python pipeline depends on
this schema. Any proposed change to field names or types requires an explicit migration note
and must be flagged in a PR description.

---

## State Management

State follows the existing Jotai pattern used throughout geojson.io.

New atoms will be added in `state/` for:

- `state/digitizer.ts` — digitizer session state (PDF file, GCPs, active page)
- `state/control_points.ts` — GCP pairs (PDF coords ↔ map coords)
- `state/digitizer_features.ts` — features under active digitization (before export)

Existing geojson.io state atoms must not be removed or renamed without a migration plan.

---

## Directory Layout (Target)

```
app/
  components/
    pdf_viewer/           # Phase 1 — PDF rendering panel
    control_points/       # Phase 2 — GCP UI
    polygon_editor/       # Phase 1 — extended draw panel
    feature_editor/       # Phase 1 — label/metadata panel
    ai_assist/            # Phase 3+ — OCR and classification widgets
  lib/
    transform_engine.ts   # Phase 2 — pure TS coordinate transform
    ocr_adapter.ts        # Phase 3 — interface + null adapter
    classification_adapter.ts  # Phase 3 — interface + lookup adapter
    validation_engine.ts  # Phase 1 — schema + geometry checks
    export_pipeline.ts    # Phase 1 — GeoJSON serialization
state/
  digitizer.ts            # Phase 1
  control_points.ts       # Phase 2
  digitizer_features.ts   # Phase 1
test/
  transform_engine.test.ts
  validation_engine.test.ts
  export_pipeline.test.ts
```

---

## Integration Points with Existing geojson.io Code

| geojson.io module                  | Digitizer integration                                 |
| ---------------------------------- | ----------------------------------------------------- |
| `app/components/map_component.tsx` | Extended with PDF overlay layer and GCP marker layer  |
| `app/components/panel_details.tsx` | May be replaced or augmented by `feature_editor/`     |
| `state/index.ts`                   | New atoms imported alongside existing atoms           |
| `app/components/menu_bar.tsx`      | New "Open PDF" and "Export Zoning GeoJSON" actions    |
| Export functions (existing)        | Superseded by `export_pipeline.ts` for digitizer mode |

The digitizer must be activatable as a **mode** so that the standard geojson.io editing
workflow remains available when the digitizer is not active.

---

_Last updated: initial scaffold — see MODIFICATION_STRATEGY.md for delivery phases._
