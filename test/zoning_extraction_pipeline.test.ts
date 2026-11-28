// @vitest-environment jsdom

import { PDF_DRAW_OPS, PDF_OPS } from 'app/lib/pdf_vector_extractor';
import {
  extractCalibratedLegendFromCrop,
  runZoningExtractionPipeline,
  type PipelinePdfPageLike
} from 'app/lib/zoning_extraction_pipeline';
import {
  transformPoint,
  type AffineTransform,
  type TransformControlPoint
} from 'app/lib/transform_engine';
import { describe, expect, it, vi } from 'vitest';

const knownTransform: AffineTransform = {
  type: 'affine',
  lon: { a: 0.0001, b: 0, c: -88.3 },
  lat: { d: 0, e: -0.0001, f: 40.2 }
};

const gcps: TransformControlPoint[] = [
  {
    pdf: { x: 10, y: 10 },
    map: transformPoint(knownTransform, { x: 10, y: 10 })
  },
  {
    pdf: { x: 500, y: 20 },
    map: transformPoint(knownTransform, { x: 500, y: 20 })
  },
  {
    pdf: { x: 250, y: 600 },
    map: transformPoint(knownTransform, { x: 250, y: 600 })
  }
];

describe('zoning_extraction_pipeline', () => {
  it('extracts and pixel-calibrates legend swatches from high-DPI PNG crops', async () => {
    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = 300;
    displayCanvas.height = 400;

    const swatchPixels = new Uint8ClampedArray(80 * 80 * 4).fill(255);
    for (let y = 10; y < 70; y++) {
      for (let x = 10; x < 70; x++) {
        const off = (y * 80 + x) * 4;
        swatchPixels[off] = 240;
        swatchPixels[off + 1] = 210;
        swatchPixels[off + 2] = 120;
        swatchPixels[off + 3] = 255;
      }
    }

    const getCtxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({
        drawImage: vi.fn(),
        getImageData: () => ({ width: 80, height: 80, data: swatchPixels })
      } as unknown as CanvasRenderingContext2D);
    const toDataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,iVBORw0KGgo=');

    const mockAdapter = {
      extractLegend: vi.fn().mockResolvedValue({
        boundary_line: '#000000',
        zones: [
          {
            code: 'R-2',
            description: 'Medium Residential',
            color: '#ffee99',
            swatch_box: [125, 125, 875, 875] as [number, number, number, number]
          }
        ]
      })
    };

    const calibrated = await extractCalibratedLegendFromCrop({
      displayCanvas,
      cropBoxPx: { x: 20, y: 20, width: 80, height: 80 },
      displayScale: 1,
      adapter: mockAdapter
    });

    expect(mockAdapter.extractLegend).toHaveBeenCalledWith(
      expect.stringContaining('data:image/png')
    );
    expect(calibrated?.zones[0].color).toBe('#f0d278');

    getCtxSpy.mockRestore();
    toDataUrlSpy.mockRestore();
  });

  it('recovers dozens of tiny parcels directly from PDF vector operator lists independent of display zoom', async () => {
    // Even if displayCanvas is tiny (e.g. 300x400 zoomed-out Fit view!), all 30 vector lots are extracted
    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = 306;
    displayCanvas.height = 396;

    const fnArray: number[] = [PDF_OPS.setFillRGBColor];
    const argsArray: unknown[][] = [['#f7eeb5']];

    for (let i = 0; i < 30; i++) {
      const x = 30 + (i % 10) * 15;
      const y = 100 + Math.floor(i / 10) * 18;
      const buf = new Float32Array([
        PDF_DRAW_OPS.moveTo,
        x,
        y,
        PDF_DRAW_OPS.lineTo,
        x + 10,
        y,
        PDF_DRAW_OPS.lineTo,
        x + 10,
        y + 12,
        PDF_DRAW_OPS.lineTo,
        x,
        y + 12,
        PDF_DRAW_OPS.closePath
      ]);
      fnArray.push(PDF_OPS.constructPath);
      argsArray.push([PDF_OPS.fill, [buf], [x, y, x + 10, y + 12]]);
    }

    const mockPage: PipelinePdfPageLike = {
      getViewport: ({ scale }) => ({
        width: 612 * scale,
        height: 792 * scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale]
      }),
      render: () => ({ promise: Promise.resolve() }),
      getOperatorList: () => Promise.resolve({ fnArray, argsArray })
    };

    const mockRasterEngine = {
      extractShapes: vi.fn().mockResolvedValue([])
    };

    const result = await runZoningExtractionPipeline({
      pdfPage: mockPage,
      displayCanvas,
      displayScale: 0.5,
      legend: {
        boundary_line: '#000000',
        zones: [{ code: 'R-1', description: 'Residential', color: '#f7eeb5' }]
      },
      confirmedControlPoints: gcps,
      sourceName: 'zoning_map.pdf',
      extractionEngine: mockRasterEngine
    });

    expect(result.features).toHaveLength(30);
    expect(result.summaryMessage).toContain('30 zoning shapes');
    expect(result.summaryMessage).toContain('vector PDF paths');
  });
});
