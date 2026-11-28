// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cv = vi.hoisted(() => {
  class Mat {
    rows = 100;
    cols = 100;
    data32S = new Int32Array(0);
    constructor(rows = 100, cols = 100) {
      this.rows = rows;
      this.cols = cols;
    }
    type() {
      return 0;
    }
    delete() {}
  }

  class Size {
    constructor(
      public width: number,
      public height: number
    ) {}
  }

  class MatVector {
    private items: Mat[] = [];
    constructor(items: Mat[] = []) {
      this.items = items;
    }
    size() {
      return this.items.length;
    }
    get(i: number) {
      return this.items[i];
    }
    delete() {}
  }

  return {
    Mat,
    Size,
    MatVector,
    CV_8UC1: 0,
    MORPH_RECT: 0,
    MORPH_CLOSE: 3,
    RETR_EXTERNAL: 0,
    RETR_CCOMP: 2,
    CHAIN_APPROX_SIMPLE: 2,
    COLOR_RGBA2RGB: 1,
    COLOR_RGB2HSV: 2,
    imread: vi.fn(() => new Mat()),
    cvtColor: vi.fn(),
    matFromArray: vi.fn(
      (rows: number, cols: number, _type: number, data: Uint8Array) => {
        const m = new Mat(rows, cols);
        (m as any)._bytes = data;
        return m;
      }
    ),
    findContours: vi.fn(),
    contourArea: vi.fn(() => 64),
    arcLength: vi.fn(() => 32),
    approxPolyDP: vi.fn()
  };
});

vi.mock('@techstark/opencv-js', () => ({
  default: Promise.resolve(cv)
}));

describe('OpenCV spatial extraction engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits asynchronous OpenCV initialization before extracting shapes', async () => {
    const { OpenCvExtractionEngine } =
      await import('./spatial_extraction_engine');
    const result = await new OpenCvExtractionEngine().extractShapes(
      document.createElement('canvas'),
      []
    );
    expect(result).toEqual([]);
    expect(cv.imread).toHaveBeenCalledOnce();
  });

  it('preserves small 8x8 px parcels via ground-calibrated area and RETR_CCOMP hole hierarchy', async () => {
    const { OpenCvExtractionEngine } =
      await import('./spatial_extraction_engine');

    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    // Paint an 8x8 parcel (64 px², well below old hardcoded 400 px² cutoff!)
    for (let y = 10; y < 18; y++) {
      for (let x = 10; x < 18; x++) {
        const off = (y * 100 + x) * 4;
        pixels[off] = 247;
        pixels[off + 1] = 238;
        pixels[off + 2] = 181;
        pixels[off + 3] = 255;
      }
    }

    vi.spyOn(canvas, 'getContext').mockReturnValue({
      getImageData: () => ({ width: 100, height: 100, data: pixels })
    } as unknown as CanvasRenderingContext2D);

    // Simulate RETR_CCOMP returning 1 outer contour (index 0) and 1 interior hole (index 1, parent = 0)
    const outerContour = new cv.Mat();
    (outerContour as any)._coords = [10, 10, 50, 10, 50, 50, 10, 50];
    const holeContour = new cv.Mat();
    (holeContour as any)._coords = [20, 20, 30, 20, 30, 30, 20, 30];

    cv.findContours.mockImplementation(
      (_mask: unknown, contoursOut: any, hierarchyOut: any) => {
        contoursOut.items = [outerContour, holeContour];
        // [next, prev, first_child, parent] per contour
        hierarchyOut.data32S = new Int32Array([
          -1,
          -1,
          1,
          -1, // contour 0: outer, child = 1, parent = -1
          -1,
          -1,
          -1,
          0 // contour 1: hole, parent = 0
        ]);
      }
    );
    cv.contourArea
      .mockReturnValueOnce(64) // outer parcel (64 px² < 400 px², must survive!)
      .mockReturnValueOnce(36); // hole (36 px²)
    cv.approxPolyDP.mockImplementation((srcContour: any, approxOut: any) => {
      approxOut.data32S = new Int32Array(srcContour._coords);
    });

    const extracted = await new OpenCvExtractionEngine().extractShapes(
      canvas,
      [{ code: 'R-1', description: 'Residential', color: '#f7eeb5' }],
      { metersPerPixel: 1.5, minAreaM2: 12 }
    );

    expect(extracted).toHaveLength(1);
    expect(extracted[0].legendItem.code).toBe('R-1');
    expect(extracted[0].pdfHoles).toHaveLength(1);
    expect(extracted[0].confidence).toBeGreaterThanOrEqual(0.5);
  });
});
