import {
  computePdfPageBoundsOnMap,
  estimateMetersPerPdfUnit,
  inverseTransformPoint,
  selectConsistentControlPoints,
  solveAffineTransform,
  solveTransform,
  solveThinPlateSpline,
  transformPoint,
  transformRenderedPoint,
  type AffineTransform,
  type CandidateControlPointOption,
  type TpsTransform,
  type TransformControlPoint
} from 'app/lib/transform_engine';
import { describe, expect, it } from 'vitest';

function makeKnownTransform(): AffineTransform {
  return {
    type: 'affine',
    lon: {
      a: 0.0001,
      b: -0.00002,
      c: -122.5
    },
    lat: {
      d: 0.00003,
      e: 0.00011,
      f: 37.6
    }
  };
}

function makePoint(
  transform: AffineTransform,
  x: number,
  y: number
): TransformControlPoint {
  const map = transformPoint(transform, { x, y });

  return {
    pdf: { x, y },
    map
  };
}

describe('transform_engine', () => {
  it('uses unscaled PDF coordinates for a rendered canvas point', () => {
    const transform = makeKnownTransform();
    const expected = transformPoint(transform, { x: 100, y: 200 });
    expect(transformRenderedPoint(transform, { x: 200, y: 400 }, 2)).toEqual(
      expected
    );
    expect(transformRenderedPoint(transform, { x: 50, y: 100 }, 0.5)).toEqual(
      expected
    );
    expect(() => transformRenderedPoint(transform, { x: 1, y: 1 }, 0)).toThrow(
      'PDF render scale must be a positive number.'
    );
  });
  it('solves an exact affine transform from three points', () => {
    const knownTransform = makeKnownTransform();
    const controlPoints: TransformControlPoint[] = [
      makePoint(knownTransform, 100, 120),
      makePoint(knownTransform, 300, 200),
      makePoint(knownTransform, 180, 460)
    ];

    const result = solveAffineTransform(controlPoints);
    expect(result.transform.type).toBe('affine');
    const t = result.transform as AffineTransform;

    expect(t.lon.a).toBeCloseTo(knownTransform.lon.a, 12);
    expect(t.lon.b).toBeCloseTo(knownTransform.lon.b, 12);
    expect(t.lon.c).toBeCloseTo(knownTransform.lon.c, 12);
    expect(t.lat.d).toBeCloseTo(knownTransform.lat.d, 12);
    expect(t.lat.e).toBeCloseTo(knownTransform.lat.e, 12);
    expect(t.lat.f).toBeCloseTo(knownTransform.lat.f, 12);
    expect(result.rmsErrorMeters).toBeCloseTo(0, 6);
  });

  it('produces low RMS error with small noise across multiple control points', () => {
    const knownTransform = makeKnownTransform();
    const cleanPoints: TransformControlPoint[] = [
      makePoint(knownTransform, 10, 10),
      makePoint(knownTransform, 410, 30),
      makePoint(knownTransform, 150, 260),
      makePoint(knownTransform, 350, 400),
      makePoint(knownTransform, 220, 520)
    ];

    const noisyPoints = cleanPoints.map((point, index) => ({
      ...point,
      map: {
        lon: point.map.lon + (index % 2 === 0 ? 0.000002 : -0.0000015),
        lat: point.map.lat + (index % 2 === 0 ? -0.0000018 : 0.0000012)
      }
    }));

    const result = solveAffineTransform(noisyPoints);

    expect(result.rmsErrorMeters).toBeLessThan(1);
    expect(result.residuals).toHaveLength(noisyPoints.length);
  });

  it('throws when there are fewer than three points', () => {
    expect(() =>
      solveAffineTransform([
        {
          pdf: { x: 0, y: 0 },
          map: { lon: -122.5, lat: 37.7 }
        },
        {
          pdf: { x: 100, y: 100 },
          map: { lon: -122.4, lat: 37.8 }
        }
      ])
    ).toThrow(
      'At least 3 control points are required to solve affine transform'
    );
  });

  it('thin-plate spline achieves near-zero residuals at control points with non-affine warp', () => {
    const base = makeKnownTransform();
    // Add a small bilinear distortion (not expressible by an affine transform)
    const WARP = 5e-9;
    const rawPoints: TransformControlPoint[] = [
      { pdf: { x: 50, y: 50 }, map: transformPoint(base, { x: 50, y: 50 }) },
      { pdf: { x: 400, y: 80 }, map: transformPoint(base, { x: 400, y: 80 }) },
      {
        pdf: { x: 250, y: 300 },
        map: transformPoint(base, { x: 250, y: 300 })
      },
      { pdf: { x: 80, y: 450 }, map: transformPoint(base, { x: 80, y: 450 }) },
      {
        pdf: { x: 450, y: 420 },
        map: transformPoint(base, { x: 450, y: 420 })
      },
      { pdf: { x: 220, y: 180 }, map: transformPoint(base, { x: 220, y: 180 }) }
    ];
    const warpedPoints = rawPoints.map((p) => ({
      pdf: p.pdf,
      map: {
        lon: p.map.lon + WARP * p.pdf.x * p.pdf.y,
        lat: p.map.lat - WARP * p.pdf.x * p.pdf.x
      }
    }));

    const tpsResult = solveThinPlateSpline(warpedPoints);
    const affineResult = solveAffineTransform(warpedPoints);

    expect(tpsResult.transform.type).toBe('tps');
    // TPS passes exactly through every GCP; residuals must be near-zero
    expect(tpsResult.rmsErrorMeters).toBeLessThan(0.01);
    tpsResult.residuals.forEach((r) => {
      expect(r.errorMeters).toBeLessThan(0.01);
    });
    // Affine cannot model the warp, so its error must be larger
    expect(affineResult.rmsErrorMeters).toBeGreaterThan(
      tpsResult.rmsErrorMeters
    );
  });

  it('solveTransform returns affine for fewer than 6 points', () => {
    const base = makeKnownTransform();
    const points: TransformControlPoint[] = [
      {
        pdf: { x: 100, y: 120 },
        map: transformPoint(base, { x: 100, y: 120 })
      },
      {
        pdf: { x: 300, y: 200 },
        map: transformPoint(base, { x: 300, y: 200 })
      },
      {
        pdf: { x: 180, y: 460 },
        map: transformPoint(base, { x: 180, y: 460 })
      },
      { pdf: { x: 400, y: 50 }, map: transformPoint(base, { x: 400, y: 50 }) },
      { pdf: { x: 50, y: 350 }, map: transformPoint(base, { x: 50, y: 350 }) }
    ];
    expect(solveTransform(points).transform.type).toBe('affine');
  });

  it('solveTransform returns TPS for 6 or more points', () => {
    const base = makeKnownTransform();
    const points: TransformControlPoint[] = [
      { pdf: { x: 50, y: 50 }, map: transformPoint(base, { x: 50, y: 50 }) },
      { pdf: { x: 400, y: 80 }, map: transformPoint(base, { x: 400, y: 80 }) },
      {
        pdf: { x: 250, y: 300 },
        map: transformPoint(base, { x: 250, y: 300 })
      },
      { pdf: { x: 80, y: 450 }, map: transformPoint(base, { x: 80, y: 450 }) },
      {
        pdf: { x: 450, y: 420 },
        map: transformPoint(base, { x: 450, y: 420 })
      },
      { pdf: { x: 220, y: 180 }, map: transformPoint(base, { x: 220, y: 180 }) }
    ];
    const result = solveTransform(points);
    expect(result.transform.type).toBe('tps');
    const t = result.transform as TpsTransform;
    expect(t.cpX).toHaveLength(6);
    expect(t.lonParams).toHaveLength(9); // n + 3
  });

  it('selectConsistentControlPoints rejects severe outliers and picks 4 spread inliers', () => {
    // Realistic North-up municipal map at lat ~40.11° (cos(40.11°) ≈ 0.7648):
    // 1 PDF point ≈ 5 meters => dLon/dx ≈ 5 / (111320 * 0.7648) ≈ 0.0000587, dLat/dy ≈ -5 / 111320 ≈ -0.0000449
    const northUpTransform: AffineTransform = {
      type: 'affine',
      lon: { a: 0.0000587, b: 0.0000005, c: -88.26 },
      lat: { d: 0.0000004, e: -0.0000449, f: 40.13 }
    };

    const goodCoords = [
      { x: 100, y: 100 },
      { x: 650, y: 120 },
      { x: 120, y: 520 },
      { x: 640, y: 510 },
      { x: 380, y: 310 }
    ];

    const groups: CandidateControlPointOption<string>[][] = [
      ...goodCoords.map((pt, idx) => [
        {
          pdf: pt,
          map: transformPoint(northUpTransform, pt),
          priorConfidence: 0.9,
          metadata: `inlier-${idx}`
        }
      ]),
      // Severe outlier 1: wrong branch 3 km away
      [
        {
          pdf: { x: 400, y: 150 },
          map: { lon: -88.2, lat: 40.16 },
          priorConfidence: 0.95,
          metadata: 'outlier-branch'
        }
      ],
      // Severe outlier 2: completely wrong state
      [
        {
          pdf: { x: 200, y: 400 },
          map: { lon: -74.006, lat: 40.7128 },
          priorConfidence: 0.95,
          metadata: 'outlier-nyc'
        }
      ]
    ];

    const selection = selectConsistentControlPoints(groups, {
      maxPoints: 4,
      pdfSpanHint: 792
    });

    expect(selection).not.toBeNull();
    expect(selection!.selected).toHaveLength(4);
    expect(selection!.rmsErrorMeters).toBeLessThan(2);
    expect(
      selection!.selected.every((item) => item.metadata?.startsWith('inlier-'))
    ).toBe(true);
    expect(Math.abs(selection!.rotationDegrees)).toBeLessThan(2);
  });

  it('selectConsistentControlPoints disambiguates multi-candidate street intersections', () => {
    const northUpTransform: AffineTransform = {
      type: 'affine',
      lon: { a: 0.0000587, b: 0, c: -88.26 },
      lat: { d: 0, e: -0.0000449, f: 40.13 }
    };

    const p1 = { x: 120, y: 110 };
    const p2 = { x: 620, y: 130 };
    const p3 = { x: 140, y: 490 };
    const p4 = { x: 610, y: 480 };

    const groups: CandidateControlPointOption<string>[][] = [
      [{ pdf: p1, map: transformPoint(northUpTransform, p1), metadata: 'p1' }],
      [{ pdf: p2, map: transformPoint(northUpTransform, p2), metadata: 'p2' }],
      [{ pdf: p3, map: transformPoint(northUpTransform, p3), metadata: 'p3' }],
      [
        // Ambiguous road crossing twice: wrong East/West crossing vs true crossing
        {
          pdf: p4,
          map: { lon: -88.29, lat: 40.09 },
          metadata: 'p4-wrong'
        },
        {
          pdf: p4,
          map: transformPoint(northUpTransform, p4),
          metadata: 'p4-true'
        }
      ]
    ];

    const selection = selectConsistentControlPoints(groups, { maxPoints: 4 });
    expect(selection).not.toBeNull();
    expect(selection!.selected).toHaveLength(4);
    expect(selection!.selected.map((s) => s.metadata)).toContain('p4-true');
    expect(selection!.selected.map((s) => s.metadata)).not.toContain(
      'p4-wrong'
    );
  });

  it('selectConsistentControlPoints rejects mirror-flipped coordinate sets', () => {
    // East-West flipped (det < 0 in right-handed space)
    const mirroredTransform: AffineTransform = {
      type: 'affine',
      lon: { a: -0.0000587, b: 0, c: -88.26 },
      lat: { d: 0, e: -0.0000449, f: 40.13 }
    };

    const pts = [
      { x: 100, y: 100 },
      { x: 600, y: 100 },
      { x: 100, y: 500 },
      { x: 600, y: 500 }
    ];
    const groups = pts.map((pdf) => [
      { pdf, map: transformPoint(mirroredTransform, pdf) }
    ]);

    expect(selectConsistentControlPoints(groups)).toBeNull();
  });

  it('inverts affine transforms back to exact PDF coordinates', () => {
    const transform = makeKnownTransform();
    const samples = [
      { x: 0, y: 0 },
      { x: 145.25, y: 312.75 },
      { x: 580.5, y: 740.125 }
    ];

    for (const pt of samples) {
      const mapped = transformPoint(transform, pt);
      const recovered = inverseTransformPoint(transform, mapped);
      expect(recovered.x).toBeCloseTo(pt.x, 8);
      expect(recovered.y).toBeCloseTo(pt.y, 8);
    }
  });

  it('inverts warped thin-plate spline transforms via Newton-Raphson', () => {
    const base = makeKnownTransform();
    const WARP = 5e-9;
    const rawCoords = [
      { x: 50, y: 50 },
      { x: 400, y: 80 },
      { x: 250, y: 300 },
      { x: 80, y: 450 },
      { x: 450, y: 420 },
      { x: 220, y: 180 }
    ];
    const warpedPoints: TransformControlPoint[] = rawCoords.map((pdf) => {
      const m = transformPoint(base, pdf);
      return {
        pdf,
        map: {
          lon: m.lon + WARP * pdf.x * pdf.y,
          lat: m.lat - WARP * pdf.x * pdf.x
        }
      };
    });

    const { transform } = solveThinPlateSpline(warpedPoints);
    const interiorQuery = { x: 235.4, y: 265.8 };
    const mapped = transformPoint(transform, interiorQuery);
    const recovered = inverseTransformPoint(transform, mapped);

    expect(recovered.x).toBeCloseTo(interiorQuery.x, 5);
    expect(recovered.y).toBeCloseTo(interiorQuery.y, 5);
  });

  it('estimates meters per PDF unit and computes buffered page map bounds', () => {
    const northUpTransform: AffineTransform = {
      type: 'affine',
      lon: { a: 0.0000587, b: 0, c: -88.26 },
      lat: { d: 0, e: -0.0000449, f: 40.13 }
    };

    const metersPerUnit = estimateMetersPerPdfUnit(northUpTransform);
    expect(metersPerUnit).toBeGreaterThan(4.5);
    expect(metersPerUnit).toBeLessThan(5.5);

    const bounds = computePdfPageBoundsOnMap(northUpTransform, 612, 792, 20);
    const topLeft = transformPoint(northUpTransform, { x: 0, y: 0 });
    const bottomRight = transformPoint(northUpTransform, { x: 612, y: 792 });

    expect(bounds[0]).toBeLessThan(Math.min(topLeft.lon, bottomRight.lon));
    expect(bounds[1]).toBeLessThan(Math.min(topLeft.lat, bottomRight.lat));
    expect(bounds[2]).toBeGreaterThan(Math.max(topLeft.lon, bottomRight.lon));
    expect(bounds[3]).toBeGreaterThan(Math.max(topLeft.lat, bottomRight.lat));
  });
});
