import turfBbox from '@turf/bbox';
import { polygon, type Position } from '@turf/helpers';
import turfKinks from '@turf/kinks';
import unkinkPolygon from '@turf/unkink-polygon';
import { createLegendColorLut } from 'app/lib/color_calibration';
import { defaultPolygonValidationAdapter } from './ai_polygon_validation_adapter';
import type { LegendItem } from './ocr_adapter';

const OPEN_CV_INIT_TIMEOUT_MS = 15_000;
const MAX_AI_VALIDATIONS_PER_EXTRACTION = 10;
let openCvReadyPromise: Promise<void> | null = null;
let cv: any = null;

/** Bounding box in rendered canvas pixel coordinates covering a PDF text label. */
export interface CanvasTextMaskBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Optional configuration for high-DPI perceptual raster extraction. */
export interface SpatialExtractionOptions {
  /** Hex color of parcel/lot boundary lines from the legend, if available. */
  boundaryLineColor?: string | null;
  /** Ground meters represented by 1 pixel on the supplied canvas. */
  metersPerPixel?: number;
  /** Minimum real-world area in square meters for a valid parcel/zone (default 10 m²). */
  minAreaM2?: number;
  /** Maximum CIEDE2000 perceptual color distance for pixel matching (default 21). */
  maxDeltaE?: number;
  /** Text bounding boxes in canvas pixel space to heal label cutouts inside zones. */
  textMaskBoxes?: ReadonlyArray<CanvasTextMaskBox>;
}

/** Extracted polygon ring (and optional interior holes) in canvas pixel coordinates. */
export interface ExtractedPolygon {
  legendItem: LegendItem;
  pdfCoordinates: { x: number; y: number }[];
  pdfHoles?: { x: number; y: number }[][];
  confidence?: number;
}

/** Interface for raster zoning shape extraction engines. */
export interface SpatialExtractionEngine {
  extractShapes(
    canvas: HTMLCanvasElement,
    legend: LegendItem[],
    options?: SpatialExtractionOptions
  ): Promise<ExtractedPolygon[]>;
}

/** Removes consecutive duplicate vertices from a polygon ring (open or closed). */
function removeDuplicateVertices(
  pts: { x: number; y: number }[]
): { x: number; y: number }[] {
  if (pts.length === 0) return pts;
  const out: { x: number; y: number }[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    if (pts[i].x !== prev.x || pts[i].y !== prev.y) {
      out.push(pts[i]);
    }
  }
  return out;
}

function isOpenCvReady(resolvedCandidate?: any): boolean {
  if (!cv && resolvedCandidate) {
    if (typeof resolvedCandidate.Mat === 'function') {
      cv = resolvedCandidate;
    } else if (
      typeof resolvedCandidate === 'object' &&
      'default' in resolvedCandidate &&
      resolvedCandidate.default &&
      typeof resolvedCandidate.default.Mat === 'function'
    ) {
      cv = resolvedCandidate.default;
    }
  }

  if (!cv) return false;

  const cvAny = cv as unknown as {
    Mat?: unknown;
    imread?: unknown;
  };

  return typeof cvAny.Mat === 'function' && typeof cvAny.imread === 'function';
}

async function ensureOpenCvReady(): Promise<void> {
  if (isOpenCvReady()) {
    return;
  }

  if (!openCvReadyPromise) {
    openCvReadyPromise = (async () => {
      const cvModule = await import('@techstark/opencv-js');
      const moduleValue =
        typeof cvModule === 'object' &&
        cvModule !== null &&
        'default' in cvModule
          ? (cvModule as { default: any }).default
          : (cvModule as any);

      if (isOpenCvReady(moduleValue)) {
        return;
      }

      if (moduleValue && typeof moduleValue.then === 'function') {
        const resolved = await moduleValue;
        const unwrapped =
          typeof resolved === 'object' &&
          resolved !== null &&
          'default' in resolved
            ? resolved.default
            : resolved;
        if (!isOpenCvReady(unwrapped)) {
          throw new Error(
            'OpenCV.js initialized but required APIs are missing.'
          );
        }
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const cvAny = moduleValue as {
          onRuntimeInitialized?: () => void;
        };
        const previousInitHandler = cvAny.onRuntimeInitialized;

        const timeoutHandle = globalThis.setTimeout(() => {
          reject(new Error('OpenCV.js initialization timed out.'));
        }, OPEN_CV_INIT_TIMEOUT_MS);

        cvAny.onRuntimeInitialized = () => {
          try {
            previousInitHandler?.();
          } catch {
            // Ignore errors from downstream handlers.
          }

          globalThis.clearTimeout(timeoutHandle);
          resolve();
        };

        if (isOpenCvReady()) {
          globalThis.clearTimeout(timeoutHandle);
          resolve();
        }
      });

      if (!isOpenCvReady()) {
        throw new Error('OpenCV.js initialized but required APIs are missing.');
      }
    })().finally(() => {
      openCvReadyPromise = null;
    });
  }

  await openCvReadyPromise;
}

/**
 * Bridges thin internal text/speckle gaps inside a zone mask while respecting
 * boundary ink lines so adjacent same-zone parcels remain distinct.
 */
export function bridgeInternalGaps(
  canvas: HTMLCanvasElement,
  targetZoningHex: string,
  boundaryLineHexColor?: string | null
): any {
  if (!cv || !cv.Mat) {
    throw new Error('OpenCV.js not initialized.');
  }

  const boundaryHex = boundaryLineHexColor || '#000000';
  const ctx = canvas.getContext('2d');
  const imageData =
    ctx && canvas.width > 0 && canvas.height > 0
      ? ctx.getImageData(0, 0, canvas.width, canvas.height)
      : null;

  if (imageData && typeof cv.matFromArray === 'function') {
    const lut = createLegendColorLut(
      [{ code: 'target', description: 'target', color: targetZoningHex }],
      boundaryHex
    );
    const total = imageData.width * imageData.height;
    const zoneBytes = new Uint8Array(total);
    const inkBytes = new Uint8Array(total);

    for (let p = 0; p < total; p++) {
      const off = p * 4;
      const classified = lut.classifyPixel(
        imageData.data[off],
        imageData.data[off + 1],
        imageData.data[off + 2]
      );
      if (classified.zoneIndex === 0) zoneBytes[p] = 255;
      if (classified.isDarkInk) inkBytes[p] = 255;
    }

    const zoningMask = cv.matFromArray(
      imageData.height,
      imageData.width,
      cv.CV_8UC1,
      zoneBytes
    );
    const boundaryMask = cv.matFromArray(
      imageData.height,
      imageData.width,
      cv.CV_8UC1,
      inkBytes
    );
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const closedZoning = new cv.Mat();
    cv.morphologyEx(zoningMask, closedZoning, cv.MORPH_CLOSE, kernel);

    const nonBoundary = new cv.Mat();
    cv.bitwise_not(boundaryMask, nonBoundary);
    const healedNonBoundary = new cv.Mat();
    cv.bitwise_and(closedZoning, nonBoundary, healedNonBoundary);
    const finalMask = new cv.Mat();
    cv.bitwise_or(zoningMask, healedNonBoundary, finalMask);

    zoningMask.delete();
    boundaryMask.delete();
    kernel.delete();
    closedZoning.delete();
    nonBoundary.delete();
    healedNonBoundary.delete();

    return finalMask;
  }

  const src = cv.imread(canvas);
  const hsv = new cv.Mat();
  cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
  const mask = buildHsvFallbackMask(hsv, targetZoningHex);
  src.delete();
  hsv.delete();
  return mask;
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16)
      ]
    : [0, 0, 0];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d === 0) h = 0;
  else if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else if (max === b) h = (r - g) / d + 4;

  h = Math.round(h * 60);
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : d / max;
  const v = max;

  return [h / 2, s * 255, v * 255];
}

function buildHsvFallbackMask(hsv: any, hexColor: string): any {
  const [r, g, b] = hexToRgb(hexColor);
  const [h, s, v] = rgbToHsv(r, g, b);
  const hueTol = 14;
  const satTol = 65;
  const valTol = 65;

  const minS = Math.max(0, s - satTol);
  const maxS = Math.min(255, s + satTol);
  const minV = Math.max(0, v - valTol);
  const maxV = Math.min(255, v + valTol);

  const mask = new cv.Mat();
  if (h - hueTol < 0 || h + hueTol > 179) {
    // Wrap around red 0/179 boundary
    const low1 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, minS, minV, 0]);
    const high1 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
      (h + hueTol) % 180,
      maxS,
      maxV,
      255
    ]);
    const low2 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
      (h - hueTol + 180) % 180,
      minS,
      minV,
      0
    ]);
    const high2 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
      179,
      maxS,
      maxV,
      255
    ]);
    const m1 = new cv.Mat();
    const m2 = new cv.Mat();
    cv.inRange(hsv, low1, high1, m1);
    cv.inRange(hsv, low2, high2, m2);
    cv.bitwise_or(m1, m2, mask);
    low1.delete();
    high1.delete();
    low2.delete();
    high2.delete();
    m1.delete();
    m2.delete();
  } else {
    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
      h - hueTol,
      minS,
      minV,
      0
    ]);
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
      h + hueTol,
      maxS,
      maxV,
      255
    ]);
    cv.inRange(hsv, low, high, mask);
    low.delete();
    high.delete();
  }
  return mask;
}

function readContourCoords(
  contour: any,
  epsilon: number
): { x: number; y: number }[] | null {
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(contour, approx, epsilon, true);
    const rawCoords: { x: number; y: number }[] = [];
    const data = approx.data32S;
    for (let j = 0; j < data.length; j += 2) {
      rawCoords.push({ x: data[j], y: data[j + 1] });
    }
    const coords = removeDuplicateVertices(rawCoords);
    if (coords.length < 3) return null;
    if (
      coords[0].x !== coords[coords.length - 1].x ||
      coords[0].y !== coords[coords.length - 1].y
    ) {
      coords.push({ x: coords[0].x, y: coords[0].y });
    }
    return coords.length >= 4 ? coords : null;
  } finally {
    approx.delete();
  }
}

function computePlanarRingArea(
  ring: ReadonlyArray<{ x: number; y: number }>
): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(sum / 2);
}

/**
 * Perceptual CIELAB + OpenCV contour extraction engine supporting hole hierarchies,
 * text-cutout healing, ground-calibrated area thresholds, and highlighted AI validation.
 */
export class OpenCvExtractionEngine implements SpatialExtractionEngine {
  async extractShapes(
    canvas: HTMLCanvasElement,
    legend: LegendItem[],
    options: SpatialExtractionOptions = {}
  ): Promise<ExtractedPolygon[]> {
    await ensureOpenCvReady();

    if (!cv || !cv.Mat) {
      throw new Error('OpenCV.js not initialized.');
    }

    const src = cv.imread(canvas);
    if (legend.length === 0) {
      src.delete();
      return [];
    }

    const ctx = canvas.getContext('2d');
    let imageData: ImageData | null = null;
    if (
      ctx &&
      typeof ctx.getImageData === 'function' &&
      canvas.width > 0 &&
      canvas.height > 0
    ) {
      try {
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        imageData = null;
      }
    }

    const useLabLut =
      imageData !== null && typeof cv.matFromArray === 'function';

    let hsv: any = null;
    let zoneIndexBuffer: Int16Array | null = null;
    let textBoxMaskBytes: Uint8Array | null = null;
    const zoneConfSums = new Float64Array(legend.length);
    const zoneConfCounts = new Uint32Array(legend.length);

    if (useLabLut && imageData) {
      const lut = createLegendColorLut(
        legend,
        options.boundaryLineColor,
        options.maxDeltaE ?? 21
      );
      const totalPixels = imageData.width * imageData.height;
      zoneIndexBuffer = new Int16Array(totalPixels).fill(-1);
      const rawData = imageData.data;

      for (let p = 0; p < totalPixels; p++) {
        const off = p * 4;
        if (rawData[off + 3] < 96) continue;
        const classified = lut.classifyPixel(
          rawData[off],
          rawData[off + 1],
          rawData[off + 2]
        );
        if (classified.zoneIndex >= 0) {
          zoneIndexBuffer[p] = classified.zoneIndex;
          zoneConfSums[classified.zoneIndex] += classified.confidence;
          zoneConfCounts[classified.zoneIndex]++;
        }
      }

      if (options.textMaskBoxes && options.textMaskBoxes.length > 0) {
        textBoxMaskBytes = new Uint8Array(totalPixels);
        for (const box of options.textMaskBoxes) {
          const x0 = Math.max(0, Math.floor(box.x - 1));
          const y0 = Math.max(0, Math.floor(box.y - 1));
          const x1 = Math.min(
            imageData.width - 1,
            Math.ceil(box.x + box.width + 1)
          );
          const y1 = Math.min(
            imageData.height - 1,
            Math.ceil(box.y + box.height + 1)
          );
          for (let y = y0; y <= y1; y++) {
            const rowStart = y * imageData.width;
            textBoxMaskBytes.fill(255, rowStart + x0, rowStart + x1 + 1);
          }
        }
      }
    } else {
      hsv = new cv.Mat();
      cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
      cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    }

    const canvasRows = imageData
      ? imageData.height
      : (hsv?.rows ?? canvas.height);
    const canvasCols = imageData
      ? imageData.width
      : (hsv?.cols ?? canvas.width);
    const minAreaM2 = options.minAreaM2 ?? 10;
    const minAreaPx =
      options.metersPerPixel && options.metersPerPixel > 0
        ? Math.max(
            10,
            minAreaM2 / (options.metersPerPixel * options.metersPerPixel)
          )
        : Math.max(16, Math.round(canvasRows * canvasCols * 0.00002));

    const results: ExtractedPolygon[] = [];
    let aiValidationCount = 0;

    for (let z = 0; z < legend.length; z++) {
      const item = legend[z];
      let mask: any = null;

      if (useLabLut && imageData && zoneIndexBuffer) {
        if (zoneConfCounts[z] === 0) {
          continue;
        }
        const total = imageData.width * imageData.height;
        const maskBytes = new Uint8Array(total);
        for (let p = 0; p < total; p++) {
          if (zoneIndexBuffer[p] === z) {
            maskBytes[p] = 255;
          }
        }
        mask = cv.matFromArray(
          imageData.height,
          imageData.width,
          cv.CV_8UC1,
          maskBytes
        );

        // Heal text cutouts inside known PDF text bounding boxes without crossing parcel borders
        if (
          textBoxMaskBytes &&
          typeof cv.morphologyEx === 'function' &&
          typeof cv.getStructuringElement === 'function'
        ) {
          const textMaskMat = cv.matFromArray(
            imageData.height,
            imageData.width,
            cv.CV_8UC1,
            textBoxMaskBytes
          );
          const kernel = cv.getStructuringElement(
            cv.MORPH_RECT,
            new cv.Size(5, 5)
          );
          const closed = new cv.Mat();
          const healedTextOnly = new cv.Mat();
          cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);
          cv.bitwise_and(closed, textMaskMat, healedTextOnly);
          cv.bitwise_or(mask, healedTextOnly, mask);
          textMaskMat.delete();
          kernel.delete();
          closed.delete();
          healedTextOnly.delete();
        }
      } else {
        mask = buildHsvFallbackMask(hsv, item.color);
      }

      const meanZoneConfidence =
        zoneConfCounts[z] > 0
          ? Math.max(0.5, Math.min(0.95, zoneConfSums[z] / zoneConfCounts[z]))
          : 0.7;

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      const retrMode =
        typeof cv.RETR_CCOMP === 'number' ? cv.RETR_CCOMP : cv.RETR_EXTERNAL;

      cv.findContours(
        mask,
        contours,
        hierarchy,
        retrMode,
        cv.CHAIN_APPROX_SIMPLE
      );

      const hierData: Int32Array | null = hierarchy.data32S ?? null;
      const contourCount = contours.size();

      interface CandidatePoly {
        legendItem: LegendItem;
        pdfCoordinates: { x: number; y: number }[];
        pdfHoles: { x: number; y: number }[][];
        areaPx: number;
        confidence: number;
        needsValidation: boolean;
      }

      const preliminaryResults: CandidatePoly[] = [];

      for (let i = 0; i < contourCount; i++) {
        // In RETR_CCOMP, top-level outer contours have parent === -1; holes have parent >= 0
        const parentIdx = hierData ? hierData[i * 4 + 3] : -1;
        if (parentIdx !== -1) {
          continue;
        }

        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        const perimeter = cv.arcLength(contour, true);
        const circularity =
          perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;

        // Keep small lots and elongated corridor zones; only drop hair-thin 1px artifacts
        const isHairlineNoise = circularity <= 0.006 && area < minAreaPx * 4;

        if (area >= minAreaPx && !isHairlineNoise) {
          const epsilon =
            options.metersPerPixel && options.metersPerPixel > 0
              ? Math.max(0.6, Math.min(2.2, 0.35 / options.metersPerPixel))
              : Math.max(0.75, Math.min(2.2, 0.002 * perimeter));

          const coords = readContourCoords(contour, epsilon);

          // Collect child hole rings under RETR_CCOMP
          const holes: { x: number; y: number }[][] = [];
          if (hierData && coords) {
            let childIdx = hierData[i * 4 + 2];
            while (childIdx >= 0 && childIdx < contourCount) {
              const holeContour = contours.get(childIdx);
              const holeArea = cv.contourArea(holeContour);
              if (holeArea >= minAreaPx * 0.5) {
                const holeCoords = readContourCoords(holeContour, epsilon);
                if (holeCoords) {
                  holes.push(holeCoords);
                }
              }
              holeContour.delete();
              childIdx = hierData[childIdx * 4];
            }
          }

          if (coords) {
            const turfCoords: Position[][] = [coords.map((c) => [c.x, c.y])];
            const turfPoly = polygon(turfCoords);
            const kinks = turfKinks(turfPoly);

            if (kinks.features.length > 0) {
              try {
                const unkinked = unkinkPolygon(turfPoly);
                for (const feature of unkinked.features) {
                  if (
                    feature.geometry.type === 'Polygon' &&
                    feature.geometry.coordinates.length > 0
                  ) {
                    const ring = feature.geometry.coordinates[0].map((c) => ({
                      x: c[0],
                      y: c[1]
                    }));
                    const partArea = computePlanarRingArea(ring);
                    if (partArea < minAreaPx) continue;
                    preliminaryResults.push({
                      legendItem: item,
                      pdfCoordinates: ring,
                      pdfHoles: [],
                      areaPx: partArea,
                      confidence: Math.min(0.65, meanZoneConfidence * 0.8),
                      needsValidation: true
                    });
                  }
                }
              } catch (unkinkError) {
                console.warn(
                  'Could not resolve a self-intersecting shape; keeping raw outline with low confidence for manual review.',
                  unkinkError
                );
                preliminaryResults.push({
                  legendItem: item,
                  pdfCoordinates: coords,
                  pdfHoles: holes,
                  areaPx: area,
                  confidence: 0.35,
                  needsValidation: false
                });
              }
            } else {
              preliminaryResults.push({
                legendItem: item,
                pdfCoordinates: coords,
                pdfHoles: holes,
                areaPx: area,
                confidence: meanZoneConfidence,
                needsValidation: false
              });
            }
          }
        }
        contour.delete();
      }

      for (const res of preliminaryResults) {
        if (
          res.needsValidation &&
          aiValidationCount < MAX_AI_VALIDATIONS_PER_EXTRACTION
        ) {
          aiValidationCount++;
          const coords = res.pdfCoordinates;
          if (coords.length < 4) continue;

          const turfPoly = polygon([coords.map((c) => [c.x, c.y])]);
          const box = turfBbox(turfPoly);
          const PADDING = 24;
          const boxMinX = Math.max(0, Math.floor(box[0]) - PADDING);
          const boxMinY = Math.max(0, Math.floor(box[1]) - PADDING);
          const boxMaxX = Math.min(canvas.width, Math.ceil(box[2]) + PADDING);
          const boxMaxY = Math.min(canvas.height, Math.ceil(box[3]) + PADDING);

          const width = boxMaxX - boxMinX;
          const height = boxMaxY - boxMinY;

          if (width > 0 && height > 0) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = width;
            tempCanvas.height = height;
            const cropCtx = tempCanvas.getContext('2d');
            if (cropCtx) {
              cropCtx.drawImage(
                canvas,
                boxMinX,
                boxMinY,
                width,
                height,
                0,
                0,
                width,
                height
              );

              // Highlight the exact candidate polygon outline in high-contrast cyan
              cropCtx.save();
              cropCtx.strokeStyle = '#00ffff';
              cropCtx.lineWidth = 2;
              cropCtx.beginPath();
              coords.forEach((pt, idx) => {
                const lx = pt.x - boxMinX;
                const ly = pt.y - boxMinY;
                if (idx === 0) cropCtx.moveTo(lx, ly);
                else cropCtx.lineTo(lx, ly);
              });
              cropCtx.closePath();
              cropCtx.stroke();
              cropCtx.restore();

              const dataUrl = tempCanvas.toDataURL('image/png');
              const base64Data = dataUrl.split(',')[1];
              if (base64Data) {
                const binaryString = window.atob(base64Data);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let k = 0; k < len; k++) {
                  bytes[k] = binaryString.charCodeAt(k);
                }

                try {
                  const aiResult =
                    await defaultPolygonValidationAdapter.validatePolygon({
                      imageBytes: bytes,
                      mimeType: 'image/png'
                    });

                  if (aiResult.isValid) {
                    results.push({
                      legendItem: res.legendItem,
                      pdfCoordinates: res.pdfCoordinates,
                      pdfHoles:
                        res.pdfHoles.length > 0 ? res.pdfHoles : undefined,
                      confidence: Math.max(0.5, aiResult.confidence)
                    });
                  } else if (res.areaPx >= minAreaPx * 3) {
                    // Preserve substantial shapes with low confidence (<0.5) for human review
                    results.push({
                      legendItem: res.legendItem,
                      pdfCoordinates: res.pdfCoordinates,
                      pdfHoles:
                        res.pdfHoles.length > 0 ? res.pdfHoles : undefined,
                      confidence: 0.35
                    });
                  }
                  continue;
                } catch {
                  // Fall through and keep candidate
                }
              }
            }
          }
        }

        results.push({
          legendItem: res.legendItem,
          pdfCoordinates: res.pdfCoordinates,
          pdfHoles: res.pdfHoles.length > 0 ? res.pdfHoles : undefined,
          confidence: res.confidence
        });
      }

      mask.delete();
      contours.delete();
      hierarchy.delete();
    }

    src.delete();
    if (hsv) hsv.delete();

    return results;
  }
}

/** Shared singleton extraction engine instance. */
export const spatialExtractionEngine = new OpenCvExtractionEngine();
