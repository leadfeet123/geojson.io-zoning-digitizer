import {
  solveAffineTransform,
  solveTransform,
  solveThinPlateSpline,
  transformPoint,
  type AffineTransform,
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
});
