import { rewindGeometry } from '@placemarkio/geojson-rewind';
import { calibrateLegendSwatches } from 'app/lib/color_calibration';
import { newFeatureId } from 'app/lib/id';
import {
  ocrAdapter,
  type LegendResult,
  type OcrAdapter
} from 'app/lib/ocr_adapter';
import {
  createLocalParcelBoundaryIndex,
  snapPolygonToParcelBoundaries
} from 'app/lib/parcel_snapping';
import {
  classifyParcelsFromPdfZoning,
  type ParcelExtractionMode
} from 'app/lib/parcel_zoning_classifier';
import {
  extractVectorZoningFromPage,
  type PdfOperatorListLike,
  type VectorExtractedPolygon
} from 'app/lib/pdf_vector_extractor';
import {
  spatialExtractionEngine,
  type CanvasTextMaskBox,
  type SpatialExtractionEngine
} from 'app/lib/spatial_extraction_engine';
import {
  estimateMetersPerPdfUnit,
  solveTransform,
  transformPoint,
  transformRenderedPoint,
  type TransformControlPoint
} from 'app/lib/transform_engine';
import type { Polygon } from 'types';
import type { DigitizerFeature } from 'types/digitizer';

const TARGET_EXTRACTION_LONG_EDGE_PX = 3800;
const MAX_EXTRACTION_PIXELS = 14_000_000;
const LEGEND_RENDER_SCALE = 4;
const MAX_LEGEND_CROP_SIDE_PX = 2400;

/** Minimal PDF.js page viewport interface used for offscreen rendering and projection. */
export interface PipelinePdfViewportLike {
  width: number;
  height: number;
  transform: number[];
  convertToViewportPoint?(x: number, y: number): number[];
}

/** Minimal PDF.js page interface supporting offscreen high-DPI render, vectors, and text. */
export interface PipelinePdfPageLike<V extends PipelinePdfViewportLike = any> {
  getViewport(params: { scale: number; offsetX?: number; offsetY?: number }): V;
  render(params: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: V;
  }): { promise: Promise<void>; cancel?: () => void };
  getOperatorList?(): Promise<PdfOperatorListLike>;
  getTextContent?(): Promise<{ items: unknown[] }>;
}

/** Inputs for high-DPI lossless legend extraction and pixel swatch calibration. */
export interface CalibratedLegendCropParams {
  pdfPage?: PipelinePdfPageLike | null;
  displayCanvas: HTMLCanvasElement;
  cropBoxPx: { x: number; y: number; width: number; height: number };
  displayScale: number;
  adapter?: OcrAdapter;
}

/** Inputs for the end-to-end high-accuracy zoning & parcel extraction pipeline. */
export interface ZoningExtractionPipelineParams {
  pdfPage?: PipelinePdfPageLike | null;
  displayCanvas: HTMLCanvasElement;
  displayScale: number;
  legend: LegendResult;
  confirmedControlPoints: TransformControlPoint[];
  sourceName: string;
  parcelFile?: Blob | null;
  parcelMode?: ParcelExtractionMode;
  snapToleranceMeters?: number;
  extractionEngine?: SpatialExtractionEngine;
  onStatus?: (message: string) => void;
}

/** Output features and human-readable status summaries from the extraction pipeline. */
export interface ZoningExtractionPipelineResult {
  features: DigitizerFeature[];
  summaryMessage: string;
  parcelStatusMessage: string | null;
}

/**
 * Renders the selected legend crop region as a high-DPI lossless PNG, extracts
 * structured legend rows via OCR, and calibrates each swatch hex code directly
 * from the rendered PDF pixels.
 */
export async function extractCalibratedLegendFromCrop(
  params: CalibratedLegendCropParams
): Promise<LegendResult | null> {
  const {
    pdfPage = null,
    displayCanvas,
    cropBoxPx,
    displayScale,
    adapter = ocrAdapter
  } = params;

  const safeDisplayScale =
    Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;

  const tempCanvas = document.createElement('canvas');
  let renderedViaPdfPage = false;

  if (pdfPage) {
    try {
      const pdfX = cropBoxPx.x / safeDisplayScale;
      const pdfY = cropBoxPx.y / safeDisplayScale;
      const pdfW = Math.max(1, cropBoxPx.width / safeDisplayScale);
      const pdfH = Math.max(1, cropBoxPx.height / safeDisplayScale);

      const maxScaleForSide = MAX_LEGEND_CROP_SIDE_PX / Math.max(pdfW, pdfH, 1);
      const renderScale = Math.max(
        1.5,
        Math.min(LEGEND_RENDER_SCALE, maxScaleForSide)
      );

      const cropWidthPx = Math.max(1, Math.ceil(pdfW * renderScale));
      const cropHeightPx = Math.max(1, Math.ceil(pdfH * renderScale));
      tempCanvas.width = cropWidthPx;
      tempCanvas.height = cropHeightPx;

      const ctx = tempCanvas.getContext('2d');
      if (ctx && typeof pdfPage.render === 'function') {
        const viewport = pdfPage.getViewport({
          scale: renderScale,
          offsetX: -pdfX * renderScale,
          offsetY: -pdfY * renderScale
        });
        await pdfPage.render({
          canvas: tempCanvas,
          canvasContext: ctx,
          viewport
        }).promise;
        renderedViaPdfPage = true;
      }
    } catch {
      renderedViaPdfPage = false;
    }
  }

  if (!renderedViaPdfPage) {
    tempCanvas.width = Math.max(1, Math.round(cropBoxPx.width));
    tempCanvas.height = Math.max(1, Math.round(cropBoxPx.height));
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return null;
    if (typeof ctx.drawImage === 'function') {
      ctx.drawImage(
        displayCanvas,
        cropBoxPx.x,
        cropBoxPx.y,
        cropBoxPx.width,
        cropBoxPx.height,
        0,
        0,
        tempCanvas.width,
        tempCanvas.height
      );
    }
  }

  const pngDataUrl = tempCanvas.toDataURL('image/png');
  const rawLegend = await adapter.extractLegend(pngDataUrl);
  if (!rawLegend) return null;

  const ctx = tempCanvas.getContext('2d');
  if (
    ctx &&
    typeof ctx.getImageData === 'function' &&
    tempCanvas.width > 0 &&
    tempCanvas.height > 0
  ) {
    try {
      const imageData = ctx.getImageData(
        0,
        0,
        tempCanvas.width,
        tempCanvas.height
      );
      return calibrateLegendSwatches(imageData, rawLegend);
    } catch {
      return rawLegend;
    }
  }

  return rawLegend;
}

/**
 * Runs the 3-stage maximum-accuracy zoning extraction pipeline:
 * 1. Solves PDF <-> WGS-84 transform and extracts vector zoning paths when available.
 * 2. Renders an offscreen ~3800px high-DPI PDF page and extracts text-mask boxes.
 * 3. Classifies survey-grade parcels (when Parcel GeoJSON is loaded) or selects
 *    the highest-fidelity vector/raster zoning polygons with holes preserved.
 */
export async function runZoningExtractionPipeline(
  params: ZoningExtractionPipelineParams
): Promise<ZoningExtractionPipelineResult> {
  const {
    pdfPage = null,
    displayCanvas,
    displayScale,
    legend,
    confirmedControlPoints,
    sourceName,
    parcelFile = null,
    parcelMode = 'classify_parcels',
    snapToleranceMeters = 5,
    extractionEngine = spatialExtractionEngine,
    onStatus
  } = params;

  const safeDisplayScale =
    Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;

  const { transform } = solveTransform(confirmedControlPoints);
  const metersPerPdfUnit = estimateMetersPerPdfUnit(transform);

  const unscaledDims = resolveUnscaledPageDimensions(
    pdfPage,
    displayCanvas,
    safeDisplayScale
  );

  // Stage 2A: Attempt exact PDF vector operator list extraction
  let vectorPolygons: VectorExtractedPolygon[] = [];
  if (pdfPage && typeof pdfPage.getOperatorList === 'function') {
    onStatus?.('Inspecting PDF vector fill layers...');
    try {
      vectorPolygons = await extractVectorZoningFromPage(
        {
          getViewport: (opts): PipelinePdfViewportLike => {
            const vp = pdfPage.getViewport(opts) as PipelinePdfViewportLike;
            return vp;
          },
          getOperatorList: () => pdfPage.getOperatorList!()
        },
        legend.zones,
        {
          boundaryLineColor: legend.boundary_line,
          metersPerPdfUnit,
          minAreaM2: 8
        }
      );
    } catch {
      vectorPolygons = [];
    }
  }

  // Stage 2B: Render high-DPI offscreen PDF page (~3800 px long edge)
  onStatus?.('Rendering high-resolution PDF page for spatial analysis...');
  const highRes = await renderHighResolutionPage(
    pdfPage,
    displayCanvas,
    safeDisplayScale,
    unscaledDims
  );

  // Stage 3A: Parcel-driven zonal classification (default when Parcel GeoJSON is loaded)
  if (parcelFile && parcelMode !== 'snap_outlines') {
    const classification = await classifyParcelsFromPdfZoning({
      parcelFile,
      transform,
      pdfPageWidth: unscaledDims.width,
      pdfPageHeight: unscaledDims.height,
      legend,
      sourceName,
      vectorPolygons,
      rasterImage: highRes.imageData,
      rasterScale: highRes.scale,
      mode: parcelMode,
      marginMeters: Math.max(snapToleranceMeters, 25),
      onStatus
    });

    const reviewNote =
      classification.ambiguousParcelCount > 0
        ? ` (${classification.ambiguousParcelCount} split or boundary-ambiguous parcel${classification.ambiguousParcelCount === 1 ? '' : 's'} flagged for review)`
        : '';

    const parcelStatusMessage = `Scanned ${classification.scannedParcelCount} parcels; ${classification.inBoundsParcelCount} in PDF bounds; classified ${classification.classifiedParcelCount} zoned parcel${classification.classifiedParcelCount === 1 ? '' : 's'}${reviewNote}.`;

    const summaryMessage =
      parcelMode === 'dissolve_parcels'
        ? `Classified ${classification.classifiedParcelCount} parcels and dissolved into ${classification.features.length} zoning district${classification.features.length === 1 ? '' : 's'}${reviewNote}.`
        : `Successfully detected and classified ${classification.features.length} zoning parcel${classification.features.length === 1 ? '' : 's'}${reviewNote}.`;

    return {
      features: classification.features,
      summaryMessage,
      parcelStatusMessage
    };
  }

  // Stage 3B: PDF-only extraction (or legacy outline-snapping mode)
  onStatus?.('Extracting zoning polygons at full resolution...');
  const textMaskBoxes = await extractCanvasTextMaskBoxes(
    pdfPage,
    highRes.scale
  );

  const rasterPolygons = await extractionEngine.extractShapes(
    highRes.canvas,
    legend.zones,
    {
      boundaryLineColor: legend.boundary_line,
      metersPerPixel: metersPerPdfUnit / highRes.scale,
      minAreaM2: 10,
      textMaskBoxes
    }
  );

  // Prefer exact vector polygons unless the PDF drew coarse block fills subdivided by black stroke parcel lines
  const useVectors =
    vectorPolygons.length > 0 &&
    !(
      vectorPolygons.length < 15 &&
      rasterPolygons.length > vectorPolygons.length * 2.5
    );

  const unifiedPolygons: {
    legendItem: (typeof legend.zones)[number];
    outerMapRing: [number, number][];
    holeMapRings: [number, number][][];
    confidence: number;
  }[] = useVectors
    ? vectorPolygons.map((vp) => ({
        legendItem: vp.legendItem,
        outerMapRing: closeMapRing(
          vp.outerRing.map((pt) => {
            const m = transformPoint(transform, pt);
            return [m.lon, m.lat];
          })
        ),
        holeMapRings: vp.holes
          .map((hole) =>
            closeMapRing(
              hole.map((pt) => {
                const m = transformPoint(transform, pt);
                return [m.lon, m.lat];
              })
            )
          )
          .filter((r) => r.length >= 4),
        confidence: vp.confidence
      }))
    : rasterPolygons.map((rp) => ({
        legendItem: rp.legendItem,
        outerMapRing: closeMapRing(
          rp.pdfCoordinates.map((pt) => {
            const m = transformRenderedPoint(transform, pt, highRes.scale);
            return [m.lon, m.lat];
          })
        ),
        holeMapRings: (rp.pdfHoles ?? [])
          .map((hole) =>
            closeMapRing(
              hole.map((pt) => {
                const m = transformRenderedPoint(transform, pt, highRes.scale);
                return [m.lon, m.lat];
              })
            )
          )
          .filter((r) => r.length >= 4),
        confidence: rp.confidence ?? 0.7
      }));

  const validPolygons = unifiedPolygons.filter(
    (p) => p.outerMapRing.length >= 4
  );

  let parcelStatusMessage: string | null = null;
  let snappedShapeCount = 0;
  let unchangedShapeCount = 0;
  let snappedVertexCount = 0;

  if (
    parcelFile &&
    parcelMode === 'snap_outlines' &&
    validPolygons.length > 0
  ) {
    onStatus?.('Scanning parcel file for extracted shape boundaries...');
    const localParcelResult = await createLocalParcelBoundaryIndex(
      parcelFile,
      validPolygons.map((p) => p.outerMapRing),
      snapToleranceMeters
    );
    const parcelBoundaryIndex = localParcelResult.parcelIndex;
    parcelStatusMessage = `Scanned ${localParcelResult.scannedParcelCount} parcels; found ${parcelBoundaryIndex?.parcelCount ?? 0} with edges in the buffered extracted-shape bounds.`;

    if (parcelBoundaryIndex) {
      for (const poly of validPolygons) {
        const snap = snapPolygonToParcelBoundaries(
          poly.outerMapRing,
          parcelBoundaryIndex,
          snapToleranceMeters
        );
        poly.outerMapRing = snap.coordinates;
        if (snap.applied) {
          snappedShapeCount++;
          snappedVertexCount += snap.snappedVertexCount;
        } else {
          unchangedShapeCount++;
        }
      }
    }
  }

  const features: DigitizerFeature[] = validPolygons.map((poly) => {
    const rawGeom: Polygon = {
      type: 'Polygon',
      coordinates: [poly.outerMapRing, ...poly.holeMapRings]
    };
    const rewound = rewindGeometry(rawGeom, false) as Polygon;

    return {
      id: newFeatureId(),
      geometry: rewound,
      properties: {
        planning_class: poly.legendItem.description || poly.legendItem.code,
        raw_zoning_label: poly.legendItem.code || poly.legendItem.description,
        confidence:
          Math.round(Math.max(0.05, Math.min(0.98, poly.confidence)) * 100) /
          100,
        source_type: 'digitized',
        source_name: sourceName,
        human_confirmed: false
      }
    };
  });

  const engineLabel = useVectors ? 'vector PDF paths' : 'high-DPI PDF analysis';
  const snapSummary =
    parcelFile && parcelMode === 'snap_outlines'
      ? parcelStatusMessage?.includes('found 0 ')
        ? ' No parcel edges were found in the extracted-shape bounds; PDF outlines were kept unchanged.'
        : ` Parcel alignment adjusted ${snappedShapeCount} shape${snappedShapeCount === 1 ? '' : 's'} (${snappedVertexCount} vertices); kept ${unchangedShapeCount} PDF outline${unchangedShapeCount === 1 ? '' : 's'} unchanged.`
      : '';

  return {
    features,
    summaryMessage: `Successfully extracted ${features.length} zoning shape${features.length === 1 ? '' : 's'} via ${engineLabel}.${snapSummary}`,
    parcelStatusMessage
  };
}

function resolveUnscaledPageDimensions(
  pdfPage: PipelinePdfPageLike | null,
  displayCanvas: HTMLCanvasElement,
  displayScale: number
): { width: number; height: number } {
  if (pdfPage) {
    const vp = pdfPage.getViewport({ scale: 1 });
    if (vp.width > 0 && vp.height > 0) {
      return { width: vp.width, height: vp.height };
    }
  }

  const dsWidth = Number(displayCanvas.dataset?.pdfPageWidth);
  const dsHeight = Number(displayCanvas.dataset?.pdfPageHeight);
  if (
    Number.isFinite(dsWidth) &&
    Number.isFinite(dsHeight) &&
    dsWidth > 0 &&
    dsHeight > 0
  ) {
    return { width: dsWidth, height: dsHeight };
  }

  return {
    width: Math.max(1, displayCanvas.width / displayScale),
    height: Math.max(1, displayCanvas.height / displayScale)
  };
}

async function renderHighResolutionPage(
  pdfPage: PipelinePdfPageLike | null,
  displayCanvas: HTMLCanvasElement,
  displayScale: number,
  unscaledDims: { width: number; height: number }
): Promise<{
  canvas: HTMLCanvasElement;
  scale: number;
  imageData: ImageData | null;
}> {
  if (pdfPage && typeof pdfPage.render === 'function') {
    const longEdge = Math.max(unscaledDims.width, unscaledDims.height, 1);
    const scaleByEdge = TARGET_EXTRACTION_LONG_EDGE_PX / longEdge;
    const scaleByBudget = Math.sqrt(
      MAX_EXTRACTION_PIXELS /
        Math.max(1, unscaledDims.width * unscaledDims.height)
    );
    const targetScale = Math.max(
      displayScale,
      Math.min(6, scaleByEdge, scaleByBudget)
    );

    const offscreen = document.createElement('canvas');
    const viewport = pdfPage.getViewport({ scale: targetScale });
    offscreen.width = Math.max(1, Math.ceil(viewport.width));
    offscreen.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = offscreen.getContext('2d');

    if (ctx && typeof pdfPage.render === 'function') {
      try {
        await pdfPage.render({
          canvas: offscreen,
          canvasContext: ctx,
          viewport
        }).promise;
        let imageData: ImageData | null = null;
        if (typeof ctx.getImageData === 'function') {
          try {
            imageData = ctx.getImageData(
              0,
              0,
              offscreen.width,
              offscreen.height
            );
          } catch {
            imageData = null;
          }
        }
        return { canvas: offscreen, scale: targetScale, imageData };
      } catch {
        // Fall back to displayCanvas below
      }
    }
  }

  let fallbackImageData: ImageData | null = null;
  const displayCtx = displayCanvas.getContext('2d');
  if (
    displayCtx &&
    typeof displayCtx.getImageData === 'function' &&
    displayCanvas.width > 0 &&
    displayCanvas.height > 0
  ) {
    try {
      fallbackImageData = displayCtx.getImageData(
        0,
        0,
        displayCanvas.width,
        displayCanvas.height
      );
    } catch {
      fallbackImageData = null;
    }
  }

  return {
    canvas: displayCanvas,
    scale: displayScale,
    imageData: fallbackImageData
  };
}

async function extractCanvasTextMaskBoxes(
  pdfPage: PipelinePdfPageLike | null,
  renderScale: number
): Promise<CanvasTextMaskBox[]> {
  if (!pdfPage || typeof pdfPage.getTextContent !== 'function') {
    return [];
  }

  try {
    const viewport = pdfPage.getViewport({ scale: renderScale });
    if (typeof viewport.convertToViewportPoint !== 'function') {
      return [];
    }
    const textContent = await pdfPage.getTextContent();
    const boxes: CanvasTextMaskBox[] = [];
    const maxBoxW = viewport.width * 0.2;
    const maxBoxH = viewport.height * 0.05;

    for (const rawItem of textContent.items) {
      if (
        typeof rawItem !== 'object' ||
        rawItem === null ||
        !('str' in rawItem) ||
        !('transform' in rawItem)
      ) {
        continue;
      }
      const item = rawItem as {
        str?: unknown;
        transform?: unknown;
        width?: unknown;
        height?: unknown;
      };
      if (typeof item.str !== 'string' || item.str.trim().length === 0) {
        continue;
      }
      if (!Array.isArray(item.transform) || item.transform.length < 6) {
        continue;
      }
      const tx = Number(item.transform[4]);
      const ty = Number(item.transform[5]);
      const fontPts = Math.max(
        4,
        Number(item.height) ||
          Math.hypot(Number(item.transform[0]), Number(item.transform[1]))
      );
      const widthPts = Math.max(fontPts * 0.5, Number(item.width) || fontPts);

      const [vx, vy] = viewport.convertToViewportPoint(tx, ty);
      const boxW = widthPts * renderScale;
      const boxH = fontPts * renderScale * 1.25;

      if (
        Number.isFinite(vx) &&
        Number.isFinite(vy) &&
        boxW > 1 &&
        boxH > 1 &&
        boxW <= maxBoxW &&
        boxH <= maxBoxH
      ) {
        boxes.push({
          x: vx,
          y: vy - boxH * 0.85,
          width: boxW,
          height: boxH
        });
      }
    }

    return boxes;
  } catch {
    return [];
  }
}

function closeMapRing(ring: [number, number][]): [number, number][] {
  const cleaned: [number, number][] = [];
  for (const pt of ring) {
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    if (cleaned.length > 0) {
      const prev = cleaned[cleaned.length - 1];
      if (prev[0] === pt[0] && prev[1] === pt[1]) continue;
    }
    cleaned.push([pt[0], pt[1]]);
  }
  if (cleaned.length < 3) return [];
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    cleaned.push([first[0], first[1]]);
  }
  return cleaned;
}
