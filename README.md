# geojson.io Zoning Digitizer

This fork of geojson.io is a browser-based zoning PDF digitization workbench. It is built for planners and GIS technicians who need to load zoning maps from PDF, align them to a basemap, digitize polygons, assign zoning metadata, and export schema-compliant GeoJSON for downstream processing.

## Features

- Load zoning PDFs in a dedicated viewer and work against a linked map panel.
- Digitize polygons manually while preserving the baseline geojson.io editing workflow.
- Capture zoning metadata such as `raw_zoning_label`, `planning_class`, notes, and confidence.
- Validate and export planning GeoJSON in the schema required by the downstream pipeline.
- Continue using the existing geojson.io map editor for general-purpose spatial editing when digitizer mode is not active.
- Use the standard geojson.io keyboard shortcuts, import/export paths, and editing tools already available in the app.

## Bug Reports & Feature Requests

If you encounter any issues or have suggestions for this fork, please open an issue in the [geojson.io GitHub repository](https://github.com/mapbox/geojson.io/issues) for now and clearly note that the report applies to the zoning digitizer fork.

## Development

To run this project locally, you'll need [Node.js](https://nodejs.org/) installed. Then, clone the repository and install dependencies:

```bash
git clone https://github.com/mapbox/geojson-io.git
cd geojson.io
npm install
```

Copy `.env.example` to `.env` and add your public Mapbox token as `VITE_PUBLIC_MAPBOX_TOKEN`.

## AI Features

The digitizer includes optional Gemini-backed AI assistance. All AI features degrade gracefully when not configured.

### Environment variables

| Variable                           | Purpose                                                                             | Required |
| ---------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| `VITE_GEMINI_API_KEY`              | Enables Gemini classification, OCR legend extraction, and georeference suggestions  | No       |
| `VITE_GEOREF_SUGGESTION_PROXY_URL` | Proxy endpoint for georeference suggestions (takes priority over direct Gemini key) | No       |

### Feature behaviour and fallback order

**Planning-class suggestions** (`Suggest Planning Class` button in the feature editor):

- With key → calls Gemini, returns up to 3 ranked suggestions with confidence and rationale
- Without key → uses a deterministic prefix-lookup table (R→Residential, C→Commercial, etc.)
- Each suggestion has explicit Accept / Reject / Override controls; decisions are persisted per feature
- `human_confirmed` is never set automatically — it requires a user checkbox click

**Georeference point suggestions** (`Suggest 4 Points` in the Control Points panel):

- Proxy URL set → calls your proxy (forwarding `X-Gemini-Api-Key` header if key is also set)
- Key set, no proxy → calls Gemini directly
- Neither → uses built-in heuristic estimation
- Source badge in the UI shows which adapter is active

**OCR legend extraction** (`Crop Legend` → drag to select legend region):

- With key → sends image region to Gemini Vision for structured legend parsing
- Without key → returns null (no legend extracted)

### Human-in-the-loop guarantee

Features with `confidence < 0.5` that are not yet human-confirmed are:

- Visually flagged in the feature editor (amber styling)
- Blocked from export with a clear error message listing each affected feature

No AI-suggested value enters the export unless a human explicitly accepts it.

If you wire the experimental AI georeference suggestion service, configure only a proxy endpoint in local `.env`:

- `VITE_GEOREF_SUGGESTION_PROXY_URL`

To enable Gemini-backed AI features (OCR legend extraction and optional proxy-auth for georeference suggestions), set:

- `VITE_GEMINI_API_KEY`

`VITE_*` values are bundled into client code. For production, prefer a server-side proxy and use restricted or scoped API credentials if you expose a client-side key for local workflows.

If those AI variables are not set, the app falls back to the built-in heuristic suggester. The existing Mapbox configuration remains unchanged.

Then, start the development server:

```bash
npm run dev
```

This will start the application on `http://localhost:5173`. Open this URL in your web browser to view and interact with the application.

## History & Attribution

geojson.io was [originally created](https://github.com/mapbox/geojson.io/commits/main/?after=cb1c8d9d36ad4f6bc1b1c5b602db2f273e780ace+1084) in 2013 by Mapbox engineer [Tom MacWright](https://macwright.com) as a simple editor for GeoJSON, the widely-used format for encoding geographic data structures used heavily in web mapping applications. The earliest versions of the app used Mapbox.js (a Leaflet.js-based mapping library) for map rendering and leaflet-draw for drawing tools.

This repository is a fork that preserves the core geojson.io editing experience while adding a separate zoning digitization workflow for PDF-based map capture, georeferencing, validation, and planning-specific export.

It remains an open-source project with contributions from the mapping community over the years, but the default purpose of this fork is now the zoning workbench rather than the generic editor.

- [2013 blog post on mapbox.com (via internet archive)](https://web.archive.org/web/20150918163329/https://www.mapbox.com/blog/geojsonio-announce/)
- [2013 blog post on macwright.com](https://macwright.com/2013/07/26/geojsonio.html)
- [2022 blog post - Updating geojson.io](https://www.mapbox.com/blog/updating-geojson-io)
