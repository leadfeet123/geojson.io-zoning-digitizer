import polygonClipping from 'polygon-clipping';
import {
  createLegendColorLut,
  parseCssOrHexColor,
  type RgbColor
} from 'app/lib/color_calibration';
import type { LegendItem } from 'app/lib/ocr_adapter';

type Pair = [number, number];
type Ring = Pair[];
type PolyCoords = Ring[];
type Affine2D = [number, number, number, number, number, number];

/** Minimal PDF.js operator list structure returned by page.getOperatorList(). */
export interface PdfOperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown[]>;
}

/** Minimal PDF.js PageViewport structure at scale = 1. */
export interface PdfUnscaledViewportLike {
  width: number;
  height: number;
  transform: number[];
}

/** Minimal PDFPageProxy interface required for vector path extraction. */
export interface PdfVectorPageLike {
  getViewport(params: { scale: number }): PdfUnscaledViewportLike;
  getOperatorList(): Promise<PdfOperatorListLike>;
}

/** Options controlling PDF vector zoning polygon extraction. */
export interface VectorExtractionOptions {
  /** Boundary stroke color from the legend, if present. */
  boundaryLineColor?: string | null;
  /** Ground meters per 1 unscaled PDF unit (used to compute minimum parcel area). */
  metersPerPdfUnit?: number;
  /** Minimum ground area in square meters for a valid zoning polygon (default 8 m²). */
  minAreaM2?: number;
  /** Maximum CIEDE2000 color distance to match a legend fill swatch (default 21). */
  maxDeltaE?: number;
}

/** Single vector zoning polygon extracted in unscaled PDF viewport coordinates. */
export interface VectorExtractedPolygon {
  legendItem: LegendItem;
  zoneIndex: number;
  /** Closed outer ring in unscaled PDF viewport coordinates. */
  outerRing: { x: number; y: number }[];
  /** Closed interior hole rings in unscaled PDF viewport coordinates. */
  holes: { x: number; y: number }[][];
  /** Planar area in unscaled PDF square points. */
  pdfArea: number;
  /** Perceptual color match confidence in [0.0, 1.0]. */
  confidence: number;
}

/** Standard PDF.js OPS numeric codes (compatible across pdfjs-dist builds and mocks). */
export const PDF_OPS = {
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  setFillGray: 57,
  setFillRGBColor: 59,
  setFillCMYKColor: 61,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  constructPath: 91,
  setFillTransparent: 93
} as const;

/** PDF.js v6 DrawOPS numeric codes inside constructPath Float32Array buffers. */
export const PDF_DRAW_OPS = {
  moveTo: 0,
  lineTo: 1,
  curveTo: 2,
  quadraticCurveTo: 3,
  closePath: 4
} as const;

interface GraphicsState {
  ctm: Affine2D;
  fillRgb: RgbColor | null;
  fillAlpha: number;
}

interface RawExtractedZonePoly {
  zoneIndex: number;
  legendItem: LegendItem;
  confidence: number;
  coords: PolyCoords;
  bbox: [number, number, number, number];
  area: number;
}

/**
 * Extracts filled vector zoning polygons from a PDF.js page's operator list,
 * preserving exact floating-point coordinates, interior holes, and z-order cutouts.
 */
export async function extractVectorZoningFromPage(
  page: PdfVectorPageLike,
  legend: ReadonlyArray<LegendItem>,
  options: VectorExtractionOptions = {}
): Promise<VectorExtractedPolygon[]> {
  if (legend.length === 0) return [];
  const viewport = page.getViewport({ scale: 1 });
  const operatorList = await page.getOperatorList();
  return extractVectorZoningFromOperatorList(
    operatorList,
    viewport,
    legend,
    options
  );
}

/**
 * Pure synchronous vector zoning extractor operating on a PDF.js operator list
 * and unscaled viewport transform.
 */
export function extractVectorZoningFromOperatorList(
  operatorList: PdfOperatorListLike,
  viewport: PdfUnscaledViewportLike,
  legend: ReadonlyArray<LegendItem>,
  options: VectorExtractionOptions = {}
): VectorExtractedPolygon[] {
  if (legend.length === 0 || operatorList.fnArray.length === 0) {
    return [];
  }

  const lut = createLegendColorLut(
    legend,
    options.boundaryLineColor,
    options.maxDeltaE ?? 21
  );

  const pageArea = Math.max(1, viewport.width * viewport.height);
  const maxBackgroundArea = pageArea * 0.82;
  const metersPerUnit =
    options.metersPerPdfUnit && options.metersPerPdfUnit > 0
      ? options.metersPerPdfUnit
      : 2;
  const minAreaM2 = options.minAreaM2 ?? 8;
  const minPdfArea = Math.max(
    0.25,
    minAreaM2 / (metersPerUnit * metersPerUnit)
  );

  const baseTransform: Affine2D =
    Array.isArray(viewport.transform) && viewport.transform.length >= 6
      ? [
          viewport.transform[0],
          viewport.transform[1],
          viewport.transform[2],
          viewport.transform[3],
          viewport.transform[4],
          viewport.transform[5]
        ]
      : [1, 0, 0, 1, 0, 0];

  let state: GraphicsState = {
    ctm: baseTransform,
    fillRgb: { r: 0, g: 0, b: 0 },
    fillAlpha: 1
  };
  const stateStack: GraphicsState[] = [];

  let pendingSubpaths: Pair[][] = [];
  let currentSubpath: Pair[] = [];

  const flushCurrentSubpath = () => {
    if (currentSubpath.length >= 3) {
      pendingSubpaths.push(currentSubpath);
    }
    currentSubpath = [];
  };

  const resetPath = () => {
    pendingSubpaths = [];
    currentSubpath = [];
  };

  const rawPolygons: RawExtractedZonePoly[] = [];

  const emitFilledPath = () => {
    flushCurrentSubpath();
    const subpaths = pendingSubpaths;
    resetPath();

    if (subpaths.length === 0 || !state.fillRgb || state.fillAlpha < 0.15) {
      return;
    }

    const colorMatch = lut.classifyExact(state.fillRgb);
    if (!colorMatch) {
      return;
    }

    const transformedRings: {
      ring: Ring;
      absArea: number;
      bbox: [number, number, number, number];
    }[] = [];

    for (const rawRing of subpaths) {
      const projected = projectAndCleanRing(rawRing, state.ctm);
      if (!projected) continue;

      const { ring, absArea, bbox } = projected;
      if (absArea < minPdfArea || absArea > maxBackgroundArea) continue;

      const width = bbox[2] - bbox[0];
      const height = bbox[3] - bbox[1];
      const minDim = Math.min(width, height);
      const perimeter = ringPerimeter(ring);
      const compactness = perimeter > 0 ? absArea / (perimeter * perimeter) : 0;

      // Reject thin vector line-work / text strokes rendered as filled outlines
      if (minDim < 1.0 && compactness < 0.004) {
        continue;
      }

      transformedRings.push({ ring, absArea, bbox });
    }

    if (transformedRings.length === 0) return;

    const grouped = groupCompoundPathRings(transformedRings);
    for (const poly of grouped) {
      rawPolygons.push({
        zoneIndex: colorMatch.zoneIndex,
        legendItem: legend[colorMatch.zoneIndex],
        confidence: colorMatch.confidence,
        coords: poly.coords,
        bbox: poly.bbox,
        area: poly.area
      });
    }
  };

  const { fnArray, argsArray } = operatorList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];

    switch (fn) {
      case PDF_OPS.save:
        stateStack.push({
          ctm: [...state.ctm] as Affine2D,
          fillRgb: state.fillRgb ? { ...state.fillRgb } : null,
          fillAlpha: state.fillAlpha
        });
        break;

      case PDF_OPS.restore: {
        const prev = stateStack.pop();
        if (prev) state = prev;
        break;
      }

      case PDF_OPS.paintFormXObjectBegin: {
        stateStack.push({
          ctm: [...state.ctm] as Affine2D,
          fillRgb: state.fillRgb ? { ...state.fillRgb } : null,
          fillAlpha: state.fillAlpha
        });
        const mat = args[0];
        if (Array.isArray(mat) && mat.length >= 6) {
          state.ctm = multiplyAffine(state.ctm, [
            Number(mat[0]),
            Number(mat[1]),
            Number(mat[2]),
            Number(mat[3]),
            Number(mat[4]),
            Number(mat[5])
          ]);
        }
        break;
      }

      case PDF_OPS.paintFormXObjectEnd: {
        const prev = stateStack.pop();
        if (prev) state = prev;
        break;
      }

      case PDF_OPS.transform:
        if (args.length >= 6) {
          state.ctm = multiplyAffine(state.ctm, [
            Number(args[0]),
            Number(args[1]),
            Number(args[2]),
            Number(args[3]),
            Number(args[4]),
            Number(args[5])
          ]);
        }
        break;

      case PDF_OPS.setGState: {
        const entries = args[0];
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (Array.isArray(entry) && entry[0] === 'ca') {
              const alpha = Number(entry[1]);
              if (Number.isFinite(alpha)) {
                state.fillAlpha = Math.max(0, Math.min(1, alpha));
              }
            }
          }
        }
        break;
      }

      case PDF_OPS.setFillRGBColor:
        state.fillRgb = parsePdfRgbArgs(args);
        break;

      case PDF_OPS.setFillGray:
        state.fillRgb = parsePdfGrayArgs(args);
        break;

      case PDF_OPS.setFillCMYKColor:
        state.fillRgb = parsePdfCmykArgs(args);
        break;

      case PDF_OPS.setFillTransparent:
        state.fillRgb = null;
        break;

      case PDF_OPS.moveTo:
        flushCurrentSubpath();
        currentSubpath.push([Number(args[0]), Number(args[1])]);
        break;

      case PDF_OPS.lineTo:
        currentSubpath.push([Number(args[0]), Number(args[1])]);
        break;

      case PDF_OPS.curveTo:
        appendCubicBezier(
          currentSubpath,
          Number(args[0]),
          Number(args[1]),
          Number(args[2]),
          Number(args[3]),
          Number(args[4]),
          Number(args[5])
        );
        break;

      case PDF_OPS.curveTo2: {
        const p0 =
          currentSubpath.length > 0
            ? currentSubpath[currentSubpath.length - 1]
            : [Number(args[0]), Number(args[1])];
        appendCubicBezier(
          currentSubpath,
          p0[0],
          p0[1],
          Number(args[0]),
          Number(args[1]),
          Number(args[2]),
          Number(args[3])
        );
        break;
      }

      case PDF_OPS.curveTo3:
        appendCubicBezier(
          currentSubpath,
          Number(args[0]),
          Number(args[1]),
          Number(args[2]),
          Number(args[3]),
          Number(args[2]),
          Number(args[3])
        );
        break;

      case PDF_OPS.rectangle: {
        flushCurrentSubpath();
        const rx = Number(args[0]);
        const ry = Number(args[1]);
        const rw = Number(args[2]);
        const rh = Number(args[3]);
        pendingSubpaths.push([
          [rx, ry],
          [rx + rw, ry],
          [rx + rw, ry + rh],
          [rx, ry + rh],
          [rx, ry]
        ]);
        break;
      }

      case PDF_OPS.closePath:
        flushCurrentSubpath();
        break;

      case PDF_OPS.constructPath: {
        resetPath();
        const firstArg = args[0];
        const secondArg = args[1];

        if (typeof firstArg === 'number') {
          // PDF.js v6 format: [paintOp, [Float32Array DrawOPS buffer], minMax]
          const bufferContainer = Array.isArray(secondArg)
            ? secondArg[0]
            : secondArg;
          if (isNumericArrayLike(bufferContainer)) {
            decodeDrawOpsBuffer(
              bufferContainer,
              pendingSubpaths,
              currentSubpath,
              flushCurrentSubpath
            );
          }
          if (isFillPaintOp(firstArg)) {
            emitFilledPath();
          } else if (
            firstArg === PDF_OPS.stroke ||
            firstArg === PDF_OPS.closeStroke ||
            firstArg === PDF_OPS.endPath
          ) {
            resetPath();
          }
        } else if (Array.isArray(firstArg) && isNumericArrayLike(secondArg)) {
          // Legacy PDF.js format: [opsArray, coordsArray]
          decodeLegacyConstructPath(
            firstArg,
            secondArg,
            pendingSubpaths,
            currentSubpath,
            flushCurrentSubpath
          );
        }
        break;
      }

      case PDF_OPS.fill:
      case PDF_OPS.eoFill:
      case PDF_OPS.fillStroke:
      case PDF_OPS.eoFillStroke:
      case PDF_OPS.closeFillStroke:
      case PDF_OPS.closeEOFillStroke:
        emitFilledPath();
        break;

      case PDF_OPS.stroke:
      case PDF_OPS.closeStroke:
      case PDF_OPS.endPath:
        resetPath();
        break;

      default:
        break;
    }
  }

  if (rawPolygons.length === 0) return [];

  return resolveZOrderOcclusion(rawPolygons, minPdfArea);
}

function isFillPaintOp(op: number): boolean {
  return (
    op === PDF_OPS.fill ||
    op === PDF_OPS.eoFill ||
    op === PDF_OPS.fillStroke ||
    op === PDF_OPS.eoFillStroke ||
    op === PDF_OPS.closeFillStroke ||
    op === PDF_OPS.closeEOFillStroke
  );
}

function isNumericArrayLike(value: unknown): value is ArrayLike<number> {
  return (
    Array.isArray(value) ||
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof Int32Array
  );
}

function decodeDrawOpsBuffer(
  data: ArrayLike<number>,
  pendingSubpaths: Pair[][],
  currentSubpath: Pair[],
  flush: () => void
): void {
  let i = 0;
  const len = data.length;
  while (i < len) {
    const op = data[i++];
    switch (op) {
      case PDF_DRAW_OPS.moveTo:
        flush();
        currentSubpath.push([data[i++], data[i++]]);
        break;
      case PDF_DRAW_OPS.lineTo:
        currentSubpath.push([data[i++], data[i++]]);
        break;
      case PDF_DRAW_OPS.curveTo:
        appendCubicBezier(
          currentSubpath,
          data[i++],
          data[i++],
          data[i++],
          data[i++],
          data[i++],
          data[i++]
        );
        break;
      case PDF_DRAW_OPS.quadraticCurveTo:
        appendQuadraticBezier(
          currentSubpath,
          data[i++],
          data[i++],
          data[i++],
          data[i++]
        );
        break;
      case PDF_DRAW_OPS.closePath:
        flush();
        break;
      default:
        // Unknown DrawOPS code; stop decoding safely
        i = len;
        break;
    }
  }
  if (currentSubpath.length >= 3) {
    pendingSubpaths.push([...currentSubpath]);
    currentSubpath.length = 0;
  }
}

function decodeLegacyConstructPath(
  ops: unknown[],
  coords: ArrayLike<number>,
  pendingSubpaths: Pair[][],
  currentSubpath: Pair[],
  flush: () => void
): void {
  let c = 0;
  for (const rawOp of ops) {
    const op = Number(rawOp);
    switch (op) {
      case PDF_OPS.moveTo:
        flush();
        currentSubpath.push([coords[c++], coords[c++]]);
        break;
      case PDF_OPS.lineTo:
        currentSubpath.push([coords[c++], coords[c++]]);
        break;
      case PDF_OPS.curveTo:
        appendCubicBezier(
          currentSubpath,
          coords[c++],
          coords[c++],
          coords[c++],
          coords[c++],
          coords[c++],
          coords[c++]
        );
        break;
      case PDF_OPS.curveTo2: {
        const p0 =
          currentSubpath.length > 0
            ? currentSubpath[currentSubpath.length - 1]
            : [coords[c], coords[c + 1]];
        appendCubicBezier(
          currentSubpath,
          p0[0],
          p0[1],
          coords[c++],
          coords[c++],
          coords[c++],
          coords[c++]
        );
        break;
      }
      case PDF_OPS.curveTo3: {
        const x2 = coords[c++];
        const y2 = coords[c++];
        const x3 = coords[c++];
        const y3 = coords[c++];
        appendCubicBezier(currentSubpath, x2, y2, x3, y3, x3, y3);
        break;
      }
      case PDF_OPS.rectangle: {
        flush();
        const rx = coords[c++];
        const ry = coords[c++];
        const rw = coords[c++];
        const rh = coords[c++];
        pendingSubpaths.push([
          [rx, ry],
          [rx + rw, ry],
          [rx + rw, ry + rh],
          [rx, ry + rh],
          [rx, ry]
        ]);
        break;
      }
      case PDF_OPS.closePath:
        flush();
        break;
      default:
        break;
    }
  }
}

function appendCubicBezier(
  subpath: Pair[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number
): void {
  if (subpath.length === 0) {
    subpath.push([x3, y3]);
    return;
  }
  const [x0, y0] = subpath[subpath.length - 1];
  const chord = Math.hypot(x3 - x0, y3 - y0);
  const controlPolygon =
    Math.hypot(x1 - x0, y1 - y0) +
    Math.hypot(x2 - x1, y2 - y1) +
    Math.hypot(x3 - x2, y3 - y2);

  if (controlPolygon - chord < 0.15) {
    subpath.push([x3, y3]);
    return;
  }

  const steps = 8;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    const px =
      mt * mt * mt * x0 +
      3 * mt * mt * t * x1 +
      3 * mt * t * t * x2 +
      t * t * t * x3;
    const py =
      mt * mt * mt * y0 +
      3 * mt * mt * t * y1 +
      3 * mt * t * t * y2 +
      t * t * t * y3;
    subpath.push([px, py]);
  }
}

function appendQuadraticBezier(
  subpath: Pair[],
  x1: number,
  y1: number,
  x2: number,
  y2: number
): void {
  if (subpath.length === 0) {
    subpath.push([x2, y2]);
    return;
  }
  const [x0, y0] = subpath[subpath.length - 1];
  const steps = 6;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    subpath.push([
      mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
      mt * mt * y0 + 2 * mt * t * y1 + t * t * y2
    ]);
  }
}

function multiplyAffine(m1: Affine2D, m2: Affine2D): Affine2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function projectAndCleanRing(
  rawRing: Pair[],
  ctm: Affine2D
): {
  ring: Ring;
  absArea: number;
  bbox: [number, number, number, number];
} | null {
  const cleaned: Ring = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [rx, ry] of rawRing) {
    const x = ctm[0] * rx + ctm[2] * ry + ctm[4];
    const y = ctm[1] * rx + ctm[3] * ry + ctm[5];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    if (cleaned.length > 0) {
      const prev = cleaned[cleaned.length - 1];
      if (Math.hypot(x - prev[0], y - prev[1]) < 1e-5) {
        continue;
      }
    }
    cleaned.push([x, y]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (cleaned.length < 3) return null;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-5) {
    cleaned[cleaned.length - 1] = [first[0], first[1]];
  } else {
    cleaned.push([first[0], first[1]]);
  }

  if (cleaned.length < 4) return null;

  const absArea = Math.abs(signedRingArea(cleaned));
  return {
    ring: cleaned,
    absArea,
    bbox: [minX, minY, maxX, maxY]
  };
}

function groupCompoundPathRings(
  rings: {
    ring: Ring;
    absArea: number;
    bbox: [number, number, number, number];
  }[]
): {
  coords: PolyCoords;
  bbox: [number, number, number, number];
  area: number;
}[] {
  if (rings.length === 1) {
    return [
      {
        coords: [rings[0].ring],
        bbox: rings[0].bbox,
        area: rings[0].absArea
      }
    ];
  }

  const sorted = [...rings].sort((a, b) => b.absArea - a.absArea);
  const parents = new Array<number>(sorted.length).fill(-1);
  const depths = new Array<number>(sorted.length).fill(0);

  for (let i = 0; i < sorted.length; i++) {
    const testPt = interiorOrMidpointSample(sorted[i].ring);
    let depth = 0;
    let immediateParent = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (
        bboxContainsPoint(sorted[j].bbox, testPt) &&
        pointInRing(testPt, sorted[j].ring)
      ) {
        depth++;
        if (immediateParent === -1) {
          immediateParent = j;
        }
      }
    }
    depths[i] = depth;
    parents[i] = immediateParent;
  }

  const outerMap = new Map<
    number,
    { coords: PolyCoords; bbox: [number, number, number, number]; area: number }
  >();

  for (let i = 0; i < sorted.length; i++) {
    if (depths[i] % 2 === 0) {
      outerMap.set(i, {
        coords: [sorted[i].ring],
        bbox: sorted[i].bbox,
        area: sorted[i].absArea
      });
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    if (depths[i] % 2 === 1 && parents[i] >= 0) {
      const target = outerMap.get(parents[i]);
      if (target) {
        target.coords.push(sorted[i].ring);
        target.area = Math.max(0, target.area - sorted[i].absArea);
      }
    }
  }

  return Array.from(outerMap.values());
}

function resolveZOrderOcclusion(
  rawPolygons: RawExtractedZonePoly[],
  minPdfArea: number
): VectorExtractedPolygon[] {
  const results: VectorExtractedPolygon[] = [];

  for (let i = 0; i < rawPolygons.length; i++) {
    const item = rawPolygons[i];
    let currentMulti: PolyCoords[] = [item.coords];

    // Subtract later-drawn overlapping polygons of different zones (painter's order)
    if (rawPolygons.length <= 800) {
      for (let j = i + 1; j < rawPolygons.length; j++) {
        const later = rawPolygons[j];
        if (later.zoneIndex === item.zoneIndex) continue;
        if (!bboxesOverlap(item.bbox, later.bbox)) continue;

        try {
          currentMulti = polygonClipping.difference(currentMulti, [
            later.coords
          ]) as PolyCoords[];
          if (currentMulti.length === 0) break;
        } catch {
          // Keep unclipped geometry if degenerate vertices prevent clipping
        }
      }
    }

    for (const polyCoords of currentMulti) {
      if (polyCoords.length === 0) continue;
      const outer = ensureClosedCleanRing(polyCoords[0]);
      if (!outer) continue;
      const outerArea = Math.abs(signedRingArea(outer));
      if (outerArea < minPdfArea) continue;

      const holes: { x: number; y: number }[][] = [];
      let netArea = outerArea;
      for (let h = 1; h < polyCoords.length; h++) {
        const hole = ensureClosedCleanRing(polyCoords[h]);
        if (!hole) continue;
        const holeArea = Math.abs(signedRingArea(hole));
        if (holeArea < minPdfArea * 0.5) continue;
        netArea -= holeArea;
        holes.push(hole.map(([x, y]) => ({ x, y })));
      }

      if (netArea < minPdfArea) continue;

      results.push({
        legendItem: item.legendItem,
        zoneIndex: item.zoneIndex,
        outerRing: outer.map(([x, y]) => ({ x, y })),
        holes,
        pdfArea: netArea,
        confidence: item.confidence
      });
    }
  }

  return results;
}

function ensureClosedCleanRing(ring: Ring): Ring | null {
  const out: Ring = [];
  for (const [x, y] of ring) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (out.length > 0) {
      const prev = out[out.length - 1];
      if (Math.hypot(x - prev[0], y - prev[1]) < 1e-5) continue;
    }
    out.push([x, y]);
  }
  if (out.length < 3) return null;
  const first = out[0];
  const last = out[out.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-5) {
    out[out.length - 1] = [first[0], first[1]];
  } else {
    out.push([first[0], first[1]]);
  }
  return out.length >= 4 ? out : null;
}

function signedRingArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

function ringPerimeter(ring: Ring): number {
  let len = 0;
  for (let i = 1; i < ring.length; i++) {
    len += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  }
  return len;
}

function interiorOrMidpointSample(ring: Ring): Pair {
  let cx = 0;
  let cy = 0;
  const n = Math.max(1, ring.length - 1);
  for (let i = 0; i < n; i++) {
    cx += ring[i][0];
    cy += ring[i][1];
  }
  const candidate: Pair = [cx / n, cy / n];
  if (pointInRing(candidate, ring)) {
    return candidate;
  }
  return ring[0];
}

function bboxContainsPoint(
  bbox: [number, number, number, number],
  pt: Pair
): boolean {
  return (
    pt[0] >= bbox[0] && pt[0] <= bbox[2] && pt[1] >= bbox[1] && pt[1] <= bbox[3]
  );
}

function bboxesOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function pointInRing(point: Pair, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function parsePdfRgbArgs(args: unknown[]): RgbColor | null {
  if (typeof args[0] === 'string') {
    return parseCssOrHexColor(args[0]);
  }
  if (Array.isArray(args[0]) && args[0].length >= 3) {
    return normalizeRgbTriple(
      Number(args[0][0]),
      Number(args[0][1]),
      Number(args[0][2])
    );
  }
  if (args.length >= 3) {
    return normalizeRgbTriple(
      Number(args[0]),
      Number(args[1]),
      Number(args[2])
    );
  }
  return null;
}

function normalizeRgbTriple(r: number, g: number, b: number): RgbColor | null {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return null;
  }
  const isUnit =
    r <= 1 &&
    g <= 1 &&
    b <= 1 &&
    (r < 1 || g < 1 || b < 1 || Math.max(r, g, b) <= 1);
  const scale = isUnit && Math.max(r, g, b) <= 1 ? 255 : 1;
  return {
    r: Math.max(0, Math.min(255, Math.round(r * scale))),
    g: Math.max(0, Math.min(255, Math.round(g * scale))),
    b: Math.max(0, Math.min(255, Math.round(b * scale)))
  };
}

function parsePdfGrayArgs(args: unknown[]): RgbColor | null {
  const g = Number(args[0]);
  if (!Number.isFinite(g)) return null;
  const v = g <= 1 ? Math.round(g * 255) : Math.round(g);
  const clamped = Math.max(0, Math.min(255, v));
  return { r: clamped, g: clamped, b: clamped };
}

function parsePdfCmykArgs(args: unknown[]): RgbColor | null {
  const src = Array.isArray(args[0]) ? args[0] : args;
  if (src.length < 4) return null;
  const c = Math.max(0, Math.min(1, Number(src[0])));
  const m = Math.max(0, Math.min(1, Number(src[1])));
  const y = Math.max(0, Math.min(1, Number(src[2])));
  const k = Math.max(0, Math.min(1, Number(src[3])));
  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k))
  };
}
