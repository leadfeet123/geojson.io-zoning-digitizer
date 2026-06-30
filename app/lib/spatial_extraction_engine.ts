import cvModule from '@techstark/opencv-js';
import turfKinks from '@turf/kinks';
import unkinkPolygon from '@turf/unkink-polygon';
import { polygon, Position } from '@turf/helpers';
import turfBbox from '@turf/bbox';
import type { LegendItem } from './ocr_adapter';
import { defaultPolygonValidationAdapter } from './ai_polygon_validation_adapter';

const OPEN_CV_INIT_TIMEOUT_MS = 15_000;
let openCvReadyPromise: Promise<void> | null = null;
let cv: any = null;

export interface ExtractedPolygon {
  legendItem: LegendItem;
  pdfCoordinates: { x: number; y: number }[];
}

export interface SpatialExtractionEngine {
  extractShapes(
    canvas: HTMLCanvasElement,
    legend: LegendItem[]
  ): Promise<ExtractedPolygon[]>;
}

function isOpenCvReady(): boolean {
  const moduleAny = cvModule as any;

  if (!cv) {
    if (moduleAny && typeof moduleAny.Mat === 'function') {
      cv = moduleAny;
    } else if (
      moduleAny?.default &&
      typeof moduleAny.default.Mat === 'function'
    ) {
      cv = moduleAny.default;
    }
  }

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
      const moduleAny = cvModule as any;
      const moduleValue = moduleAny?.default ?? moduleAny;

      if (moduleValue && typeof moduleValue.then === 'function') {
        const resolved = await moduleValue;
        cv = resolved?.default ?? resolved;

        if (!isOpenCvReady()) {
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

        // If it initialized before the handler was set, resolve immediately.
        if (isOpenCvReady()) {
          globalThis.clearTimeout(timeoutHandle);
          resolve();
        }
      });

      if (!isOpenCvReady()) {
        throw new Error('OpenCV.js initialized but required APIs are missing.');
      }
    }).finally(() => {
      openCvReadyPromise = null;
    });
  }

  await openCvReadyPromise;
}

export function bridgeInternalGaps(
  canvas: HTMLCanvasElement,
  targetZoningHex: string,
  boundaryLineHexColor?: string | null
): any {
  if (!cv || !cv.Mat) {
    throw new Error('OpenCV.js not initialized.');
  }

  const boundaryHex = boundaryLineHexColor || '#000000';

  const src = cv.imread(canvas);
  const hsv = new cv.Mat();
  cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

  const { lowerBound: lowerZoning, upperBound: upperZoning } = getHsvBounds(
    targetZoningHex,
    hsv.rows,
    hsv.cols,
    hsv.type()
  );
  const zoningMask = new cv.Mat();
  cv.inRange(hsv, lowerZoning, upperZoning, zoningMask);

  const { lowerBound: lowerBoundary, upperBound: upperBoundary } = getHsvBounds(
    boundaryHex,
    hsv.rows,
    hsv.cols,
    hsv.type()
  );
  const boundaryMask = new cv.Mat();
  cv.inRange(hsv, lowerBoundary, upperBoundary, boundaryMask);

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));

  const closedZoning = new cv.Mat();
  cv.morphologyEx(zoningMask, closedZoning, cv.MORPH_CLOSE, kernel);

  const allowedMask = new cv.Mat();
  cv.bitwise_or(zoningMask, boundaryMask, allowedMask);

  const finalMask = new cv.Mat();
  cv.bitwise_and(closedZoning, allowedMask, finalMask);

  // Cleanup
  src.delete();
  hsv.delete();
  lowerZoning.delete();
  upperZoning.delete();
  zoningMask.delete();
  lowerBoundary.delete();
  upperBoundary.delete();
  boundaryMask.delete();
  kernel.delete();
  closedZoning.delete();
  allowedMask.delete();

  return finalMask;
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

// Convert RGB to HSV
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

  // OpenCV HSV ranges: H: 0-179, S: 0-255, V: 0-255
  return [h / 2, s * 255, v * 255];
}

function getHsvBounds(
  hexColor: string,
  rows: number,
  cols: number,
  type: number
): { lowerBound: any; upperBound: any } {
  const [r, g, b] = hexToRgb(hexColor);
  const [h, s, v] = rgbToHsv(r, g, b);

  const hueTol = 10;
  const satTol = 50;
  const valTol = 50;

  const lowerBound = new cv.Mat(rows, cols, type, [
    Math.max(0, h - hueTol),
    Math.max(0, s - satTol),
    Math.max(0, v - valTol),
    0
  ]);
  const upperBound = new cv.Mat(rows, cols, type, [
    Math.min(179, h + hueTol),
    Math.min(255, s + satTol),
    Math.min(255, v + valTol),
    255
  ]);

  return { lowerBound, upperBound };
}

export class OpenCvExtractionEngine implements SpatialExtractionEngine {
  async extractShapes(
    canvas: HTMLCanvasElement,
    legend: LegendItem[]
  ): Promise<ExtractedPolygon[]> {
    await ensureOpenCvReady();

    if (!cv || !cv.Mat) {
      throw new Error('OpenCV.js not initialized.');
    }

    const src = cv.imread(canvas);
    const hsv = new cv.Mat();
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

    const results: ExtractedPolygon[] = [];

    for (const item of legend) {
      const { lowerBound, upperBound } = getHsvBounds(
        item.color,
        hsv.rows,
        hsv.cols,
        hsv.type()
      );

      const mask = new cv.Mat();
      cv.inRange(hsv, lowerBound, upperBound, mask);

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();

      cv.findContours(
        mask,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE
      );

      const preliminaryResults: (ExtractedPolygon & {
        _needsValidation?: boolean;
      })[] = [];

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        const perimeter = cv.arcLength(contour, true);

        const circularity =
          perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;

        if (area > 400 && circularity > 0.04) {
          const approx = new cv.Mat();
          const epsilon = 0.01 * cv.arcLength(contour, true);
          cv.approxPolyDP(contour, approx, epsilon, true);

          const coords: { x: number; y: number }[] = [];
          const data = approx.data32S;
          for (let j = 0; j < data.length; j += 2) {
            coords.push({ x: data[j], y: data[j + 1] });
          }

          if (coords.length >= 3) {
            // Close the polygon if not closed
            if (
              coords[0].x !== coords[coords.length - 1].x ||
              coords[0].y !== coords[coords.length - 1].y
            ) {
              coords.push({ x: coords[0].x, y: coords[0].y });
            }

            if (coords.length >= 4) {
              const turfCoords: Position[][] = [coords.map((c) => [c.x, c.y])];
              const turfPoly = polygon(turfCoords);
              const kinks = turfKinks(turfPoly);

              const validCoordsList: { x: number; y: number }[][] = [];
              let needsValidation = false;

              if (kinks.features.length > 0) {
                needsValidation = true;
                const unkinked = unkinkPolygon(turfPoly);
                for (const feature of unkinked.features) {
                  if (
                    feature.geometry.type === 'Polygon' &&
                    feature.geometry.coordinates.length > 0
                  ) {
                    const ring = feature.geometry.coordinates[0];

                    // Filter out tiny slivers generated during unkinking
                    let planarArea = 0;
                    for (
                      let n = 0, m = ring.length - 1;
                      n < ring.length;
                      m = n++
                    ) {
                      planarArea +=
                        (ring[m][0] + ring[n][0]) * (ring[m][1] - ring[n][1]);
                    }
                    if (Math.abs(planarArea / 2.0) < 400) continue;

                    validCoordsList.push(
                      ring.map((c) => ({ x: c[0], y: c[1] }))
                    );
                  }
                }
              } else {
                validCoordsList.push(coords);
                if (coords.length > 50 || circularity < 0.1) {
                  needsValidation = true;
                }
              }

              for (const validCoords of validCoordsList) {
                preliminaryResults.push({
                  legendItem: item,
                  pdfCoordinates: validCoords,
                  _needsValidation: needsValidation
                });
              }
            }
          }

          approx.delete();
        }
        contour.delete();
      }

      for (const res of preliminaryResults) {
        if (res._needsValidation) {
          const coords = res.pdfCoordinates;
          if (coords.length < 3) continue;

          const closedCoords = [...coords];
          if (
            closedCoords[0].x !== closedCoords[closedCoords.length - 1].x ||
            closedCoords[0].y !== closedCoords[closedCoords.length - 1].y
          ) {
            closedCoords.push(closedCoords[0]);
          }

          const turfPoly = polygon([closedCoords.map((c) => [c.x, c.y])]);
          const box = turfBbox(turfPoly);
          const PADDING = 20; // Provide context around the shape for the AI
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
            const ctx = tempCanvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(
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

              const dataUrl = tempCanvas.toDataURL('image/png');
              const base64Data = dataUrl.split(',')[1];
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
                    pdfCoordinates: res.pdfCoordinates
                  });
                }
              } catch (e) {
                results.push({
                  legendItem: res.legendItem,
                  pdfCoordinates: res.pdfCoordinates
                });
              }
            }
          }
        } else {
          results.push({
            legendItem: res.legendItem,
            pdfCoordinates: res.pdfCoordinates
          });
        }
      }

      lowerBound.delete();
      upperBound.delete();
      mask.delete();
      contours.delete();
      hierarchy.delete();
    }

    src.delete();
    hsv.delete();

    return results;
  }
}

export const spatialExtractionEngine = new OpenCvExtractionEngine();
