import {
  extractVectorZoningFromOperatorList,
  PDF_DRAW_OPS,
  PDF_OPS
} from 'app/lib/pdf_vector_extractor';
import { describe, expect, it } from 'vitest';

function makeRectDrawOps(
  x: number,
  y: number,
  w: number,
  h: number
): Float32Array {
  return new Float32Array([
    PDF_DRAW_OPS.moveTo,
    x,
    y,
    PDF_DRAW_OPS.lineTo,
    x + w,
    y,
    PDF_DRAW_OPS.lineTo,
    x + w,
    y + h,
    PDF_DRAW_OPS.lineTo,
    x,
    y + h,
    PDF_DRAW_OPS.closePath
  ]);
}

describe('pdf_vector_extractor', () => {
  const viewport = {
    width: 612,
    height: 792,
    // Standard PDF bottom-left to top-left viewport transform
    transform: [1, 0, 0, -1, 0, 792]
  };

  const legend = [
    { code: 'R-1', description: 'Residential', color: '#f7eeb5' },
    { code: 'C-1', description: 'Commercial', color: '#e63946' }
  ];

  it('extracts small vector zoning lots and ignores page background and stroke lines', () => {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];

    // 1. Page-sized background rectangle (should be ignored even if close to R-1)
    fnArray.push(PDF_OPS.setFillRGBColor);
    argsArray.push(['#ffffff']);
    fnArray.push(PDF_OPS.constructPath);
    argsArray.push([
      PDF_OPS.fill,
      [makeRectDrawOps(0, 0, 612, 792)],
      [0, 0, 612, 792]
    ]);

    // 2. Twenty tiny 8x10 pt residential parcels (far smaller than 400 px², all preserved!)
    fnArray.push(PDF_OPS.setFillRGBColor);
    argsArray.push(['#f7eeb5']);
    for (let lot = 0; lot < 20; lot++) {
      const lx = 40 + lot * 12;
      const ly = 200;
      fnArray.push(PDF_OPS.constructPath);
      argsArray.push([
        PDF_OPS.fill,
        [makeRectDrawOps(lx, ly, 8, 10)],
        [lx, ly, lx + 8, ly + 10]
      ]);
    }

    // 3. Stroke-only parcel border lines drawn on top (should not emit polygons)
    fnArray.push(PDF_OPS.constructPath);
    argsArray.push([
      PDF_OPS.stroke,
      [makeRectDrawOps(40, 200, 240, 10)],
      [40, 200, 280, 210]
    ]);

    const extracted = extractVectorZoningFromOperatorList(
      { fnArray, argsArray },
      viewport,
      legend,
      { metersPerPdfUnit: 2, minAreaM2: 8 }
    );

    expect(extracted).toHaveLength(20);
    expect(extracted.every((p) => p.legendItem.code === 'R-1')).toBe(true);
    // Verify top-left viewport Y flip: PDF y:[200..210] -> viewport y:[582..592]
    const ys = extracted[0].outerRing.map((pt) => pt.y);
    expect(Math.min(...ys)).toBeCloseTo(582, 5);
    expect(Math.max(...ys)).toBeCloseTo(592, 5);
  });

  it('subtracts z-ordered spot zones to create topological cutout holes without containment overlap', () => {
    // Large R-1 block [100..300] x [100..300], with C-1 spot parcel [160..220] x [160..220] painted on top
    const fnArray = [
      PDF_OPS.setFillRGBColor,
      PDF_OPS.constructPath,
      PDF_OPS.setFillRGBColor,
      PDF_OPS.constructPath
    ];
    const argsArray: unknown[][] = [
      ['#f7eeb5'],
      [
        PDF_OPS.fill,
        [makeRectDrawOps(100, 100, 200, 200)],
        [100, 100, 300, 300]
      ],
      ['#e63946'],
      [PDF_OPS.fill, [makeRectDrawOps(160, 160, 60, 60)], [160, 160, 220, 220]]
    ];

    const extracted = extractVectorZoningFromOperatorList(
      { fnArray, argsArray },
      viewport,
      legend,
      { metersPerPdfUnit: 2, minAreaM2: 8 }
    );

    expect(extracted).toHaveLength(2);
    const r1 = extracted.find((p) => p.legendItem.code === 'R-1')!;
    const c1 = extracted.find((p) => p.legendItem.code === 'C-1')!;

    expect(r1.holes).toHaveLength(1);
    expect(r1.pdfArea).toBeCloseTo(200 * 200 - 60 * 60, 2);
    expect(c1.holes).toHaveLength(0);
    expect(c1.pdfArea).toBeCloseTo(60 * 60, 2);
  });
});
