import {
  solveAffineTransform,
  transformPoint,
  type AffineTransform,
  type TransformControlPoint
} from 'app/lib/transform_engine';
import { describe, expect, it } from 'vitest';

function makeKnownTransform(): AffineTransform {
  return {
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

function makePoint(transform: AffineTransform, x: number, y: number): TransformControlPoint {
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

    expect(result.transform.lon.a).toBeCloseTo(knownTransform.lon.a, 12);
    expect(result.transform.lon.b).toBeCloseTo(knownTransform.lon.b, 12);
    expect(result.transform.lon.c).toBeCloseTo(knownTransform.lon.c, 12);
    expect(result.transform.lat.d).toBeCloseTo(knownTransform.lat.d, 12);
    expect(result.transform.lat.e).toBeCloseTo(knownTransform.lat.e, 12);
    expect(result.transform.lat.f).toBeCloseTo(knownTransform.lat.f, 12);
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
    ).toThrow('At least 3 control points are required to solve affine transform');
  });
});
