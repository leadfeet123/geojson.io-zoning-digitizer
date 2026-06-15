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
    throw new Error('At least 3 control points are required to solve affine transform');
  }

  const aRows = controlPoints.map((point) => [point.pdf.x, point.pdf.y, 1]);
  const lonValues = controlPoints.map((point) => point.map.lon);
  const latValues = controlPoints.map((point) => point.map.lat);

  const lonParams = solveLeastSquares3(aRows, lonValues);
  const latParams = solveLeastSquares3(aRows, latValues);

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
    lon: transform.lon.a * point.x + transform.lon.b * point.y + transform.lon.c,
    lat: transform.lat.d * point.x + transform.lat.e * point.y + transform.lat.f
  };
}

function solveLeastSquares3(aRows: number[][], bValues: number[]): [number, number, number] {
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const atb = [0, 0, 0];

  for (let i = 0; i < aRows.length; i++) {
    const row = aRows[i];
    const value = bValues[i];

    for (let r = 0; r < 3; r++) {
      atb[r] += row[r] * value;

      for (let c = 0; c < 3; c++) {
        ata[r][c] += row[r] * row[c];
      }
    }
  }

  return solveLinear3x3(ata, atb);
}

function solveLinear3x3(matrix: number[][], vector: number[]): [number, number, number] {
  const augmented = matrix.map((row, rowIndex) => [...row, vector[rowIndex]]);

  for (let pivot = 0; pivot < 3; pivot++) {
    let maxRow = pivot;

    for (let row = pivot + 1; row < 3; row++) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[maxRow][pivot])) {
        maxRow = row;
      }
    }

    if (Math.abs(augmented[maxRow][pivot]) < 1e-12) {
      throw new Error('Control points are degenerate; could not solve affine transform');
    }

    if (maxRow !== pivot) {
      const temp = augmented[pivot];
      augmented[pivot] = augmented[maxRow];
      augmented[maxRow] = temp;
    }

    const pivotValue = augmented[pivot][pivot];
    for (let col = pivot; col < 4; col++) {
      augmented[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < 3; row++) {
      if (row === pivot) {
        continue;
      }

      const factor = augmented[row][pivot];
      for (let col = pivot; col < 4; col++) {
        augmented[row][col] -= factor * augmented[pivot][col];
      }
    }
  }

  return [augmented[0][3], augmented[1][3], augmented[2][3]];
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
