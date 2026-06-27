import cvModule from '@techstark/opencv-js';
import type { LegendItem } from './ocr_adapter';

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

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);

        if (area > 100) {
          const approx = new cv.Mat();
          const epsilon = 0.01 * cv.arcLength(contour, true);
          cv.approxPolyDP(contour, approx, epsilon, true);

          const coords: { x: number; y: number }[] = [];
          const data = approx.data32S;
          for (let j = 0; j < data.length; j += 2) {
            coords.push({ x: data[j], y: data[j + 1] });
          }

          if (coords.length >= 3) {
            results.push({
              legendItem: item,
              pdfCoordinates: coords
            });
          }

          approx.delete();
        }
        contour.delete();
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
