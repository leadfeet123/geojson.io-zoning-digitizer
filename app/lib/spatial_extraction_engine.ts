import * as cv from '@techstark/opencv-js';
import type { LegendItem } from './ocr_adapter';

export interface ExtractedPolygon {
  legendItem: LegendItem;
  pdfCoordinates: { x: number; y: number }[];
}

export interface SpatialExtractionEngine {
  extractShapes(canvas: HTMLCanvasElement, legend: LegendItem[]): Promise<ExtractedPolygon[]>;
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

export class OpenCvExtractionEngine implements SpatialExtractionEngine {
  async extractShapes(
    canvas: HTMLCanvasElement,
    legend: LegendItem[]
  ): Promise<ExtractedPolygon[]> {
    return new Promise((resolve, reject) => {
      try {
        if (!cv || !cv.Mat) {
          reject(new Error('OpenCV.js not initialized.'));
          return;
        }

        const src = cv.imread(canvas);
        const hsv = new cv.Mat();
        cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

        const results: ExtractedPolygon[] = [];

        for (const item of legend) {
          const [r, g, b] = hexToRgb(item.color);
          const [h, s, v] = rgbToHsv(r, g, b);

          const hueTol = 10;
          const satTol = 50;
          const valTol = 50;

          const lowerBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
            Math.max(0, h - hueTol),
            Math.max(0, s - satTol),
            Math.max(0, v - valTol),
            0
          ]);
          const upperBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
            Math.min(179, h + hueTol),
            Math.min(255, s + satTol),
            Math.min(255, v + valTol),
            255
          ]);

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

        resolve(results);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

export const spatialExtractionEngine = new OpenCvExtractionEngine();
