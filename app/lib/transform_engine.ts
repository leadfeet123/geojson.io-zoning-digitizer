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
  type: 'affine';
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

export interface TpsTransform {
  type: 'tps';
  /** PDF-space x coordinates of control points. */
  cpX: ReadonlyArray<number>;
  /** PDF-space y coordinates of control points. */
  cpY: ReadonlyArray<number>;
  /** Solved lon params: [w₀…wₙ₋₁, constant, x-coeff, y-coeff]. */
  lonParams: ReadonlyArray<number>;
  /** Solved lat params: [w₀…wₙ₋₁, constant, x-coeff, y-coeff]. */
  latParams: ReadonlyArray<number>;
}

/** Discriminated union of supported PDF→WGS-84 transforms. */
export type SolvedTransform = AffineTransform | TpsTransform;

export interface TransformResidual {
  index: number;
  predicted: LonLatCoordinate;
  actual: LonLatCoordinate;
  errorMeters: number;
}

export interface TransformSolveResult {
  transform: SolvedTransform;
  residuals: TransformResidual[];
  rmsErrorMeters: number;
}

const EARTH_RADIUS_METERS = 6371008.8;
const TPS_MIN_POINTS = 6;

/**
 * Selects TPS (≥6 GCPs) or affine (3–5 GCPs) automatically for best accuracy.
 */
export function solveTransform(
  controlPoints: TransformControlPoint[]
): TransformSolveResult {
  if (controlPoints.length < 3) {
    throw new Error(
      'At least 3 control points are required to solve transform'
    );
  }
  return controlPoints.length >= TPS_MIN_POINTS
    ? solveThinPlateSpline(controlPoints)
    : solveAffineTransform(controlPoints);
}

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
    type: 'affine',
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
 * Transforms a PDF-space point into lon/lat using a solved affine or TPS transform.
 */
export function transformPoint(
  transform: SolvedTransform,
  point: PdfCoordinate
): LonLatCoordinate {
  if (transform.type === 'tps') {
    return transformPointTps(transform, point);
  }
  return {
    lon:
      transform.lon.a * point.x + transform.lon.b * point.y + transform.lon.c,
    lat: transform.lat.d * point.x + transform.lat.e * point.y + transform.lat.f
  };
}

/**
 * Computes a thin-plate spline PDF->WGS84 transform.
 * With ≥6 well-distributed GCPs this absorbs scan warp and projection distortion
 * that an affine model cannot, achieving near-zero residuals at all control points.
 */
export function solveThinPlateSpline(
  controlPoints: TransformControlPoint[]
): TransformSolveResult {
  if (controlPoints.length < 3) {
    throw new Error(
      'At least 3 control points are required to solve thin-plate spline transform'
    );
  }

  const n = controlPoints.length;
  const cpX = controlPoints.map((p) => p.pdf.x);
  const cpY = controlPoints.map((p) => p.pdf.y);
  const size = n + 3;

  const matData: number[][] = Array.from(
    { length: size },
    () => Array(size).fill(0) as number[]
  );

  // K block: TPS radial basis between each pair of control points
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      matData[i][j] = tpsKernel(cpX[i] - cpX[j], cpY[i] - cpY[j]);
    }
  }

  // P block and Pᵀ: affine terms ensuring the spline degrades to affine for uniform data
  for (let i = 0; i < n; i++) {
    matData[i][n] = 1;
    matData[i][n + 1] = cpX[i];
    matData[i][n + 2] = cpY[i];
    matData[n][i] = 1;
    matData[n + 1][i] = cpX[i];
    matData[n + 2][i] = cpY[i];
  }

  const A = new Matrix(matData);
  const lonRhs = new Matrix([
    ...controlPoints.map((p) => [p.map.lon]),
    [0],
    [0],
    [0]
  ]);
  const latRhs = new Matrix([
    ...controlPoints.map((p) => [p.map.lat]),
    [0],
    [0],
    [0]
  ]);

  let lonSol: number[];
  let latSol: number[];
  try {
    lonSol = solve(A, lonRhs).to1DArray();
    latSol = solve(A, latRhs).to1DArray();
  } catch {
    throw new Error(
      'Control points are degenerate or collinear; could not solve thin-plate spline'
    );
  }

  const transform: TpsTransform = {
    type: 'tps',
    cpX,
    cpY,
    lonParams: lonSol,
    latParams: latSol
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
    (sum, r) => sum + r.errorMeters * r.errorMeters,
    0
  );

  return {
    transform,
    residuals,
    rmsErrorMeters: Math.sqrt(sumSquares / residuals.length)
  };
}

function transformPointTps(
  transform: TpsTransform,
  point: PdfCoordinate
): LonLatCoordinate {
  const n = transform.cpX.length;
  const { lonParams, latParams, cpX, cpY } = transform;

  let lon =
    lonParams[n] + lonParams[n + 1] * point.x + lonParams[n + 2] * point.y;
  let lat =
    latParams[n] + latParams[n + 1] * point.x + latParams[n + 2] * point.y;

  for (let i = 0; i < n; i++) {
    const k = tpsKernel(point.x - cpX[i], point.y - cpY[i]);
    lon += lonParams[i] * k;
    lat += latParams[i] * k;
  }

  return { lon, lat };
}

/** TPS radial basis function: U(r²) = r² ln(r²), defined as 0 at origin. */
function tpsKernel(dx: number, dy: number): number {
  const r2 = dx * dx + dy * dy;
  return r2 === 0 ? 0 : r2 * Math.log(r2);
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
