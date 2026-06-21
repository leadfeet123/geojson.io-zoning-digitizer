import { Matrix, solve } from 'ml-matrix';
export interface PdfCoordinate {
  x: number;
  y: number;
}

export interface LonLatCoordinate {
  lon: number;
  lat: number;
}

export interface TransformControlPoint {
  pdf: PdfCoordinate;
  map: LonLatCoordinate;
}

export interface AffineTransform {
  lon: {
    a: number;
    b: number;
    c: number;
  };
  lat: {
    d: number;
    e: number;
    f: number;
  };
}

export interface TransformResidual {
  index: number;
  predicted: LonLatCoordinate;
  actual: LonLatCoordinate;
  errorMeters: number;
}

export interface TransformSolveResult {
  transform: AffineTransform;
  residuals: TransformResidual[];
  rmsErrorMeters: number;
}

const EARTH_RADIUS_METERS = 6371008.8;

/**
 * Computes an affine PDF->WGS84 transform from control points using least squares.
 */
export function solveAffineTransform(
  controlPoints: TransformControlPoint[]
): TransformSolveResult {
  if (controlPoints.length < 3) {
    throw new Error(
      'At least 3 control points are required to solve affine transform'
    );
  }

  const aRows = controlPoints.map((point) => [point.pdf.x, point.pdf.y, 1]);
  const lonValues = controlPoints.map((point) => point.map.lon);
  const latValues = controlPoints.map((point) => point.map.lat);

  const lonParams = solveAffineParams(aRows, lonValues);
  const latParams = solveAffineParams(aRows, latValues);

  const transform: AffineTransform = {
    lon: {
      a: lonParams[0],
      b: lonParams[1],
      c: lonParams[2]
    },
    lat: {
      d: latParams[0],
      e: latParams[1],
      f: latParams[2]
    }
  };

  const residuals = controlPoints.map((point, index) => {
    const predicted = transformPoint(transform, point.pdf);
    const actual = point.map;

    return {
      index,
      predicted,
      actual,
      errorMeters: haversineDistanceMeters(predicted, actual)
    };
  });

  const sumSquares = residuals.reduce(
    (sum, residual) => sum + residual.errorMeters * residual.errorMeters,
    0
  );

  return {
    transform,
    residuals,
    rmsErrorMeters: Math.sqrt(sumSquares / residuals.length)
  };
}

/**
 * Transforms a PDF-space point into lon/lat using a solved affine transform.
 */
export function transformPoint(
  transform: AffineTransform,
  point: PdfCoordinate
): LonLatCoordinate {
  return {
    lon:
      transform.lon.a * point.x + transform.lon.b * point.y + transform.lon.c,
    lat: transform.lat.d * point.x + transform.lat.e * point.y + transform.lat.f
  };
}

function solveAffineParams(
  aRows: number[][],
  bValues: number[]
): [number, number, number] {
  const A = new Matrix(aRows);
  const B = new Matrix(bValues.map((val) => [val]));

  try {
    const X = solve(A, B, true);
    const result = X.to1DArray();
    return [result[0], result[1], result[2]];
  } catch (error) {
    throw new Error(
      'Control points are degenerate; could not solve affine transform'
    );
  }
}

function haversineDistanceMeters(
  source: LonLatCoordinate,
  target: LonLatCoordinate
): number {
  const sourceLat = toRadians(source.lat);
  const targetLat = toRadians(target.lat);
  const deltaLat = toRadians(target.lat - source.lat);
  const deltaLon = toRadians(target.lon - source.lon);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(sourceLat) *
      Math.cos(targetLat) *
      Math.sin(deltaLon / 2) *
      Math.sin(deltaLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
