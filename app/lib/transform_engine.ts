import { Matrix, solve } from 'ml-matrix';
/** PDF user-space coordinate (unscaled points, top-left viewport origin). */
export interface PdfCoordinate {
  x: number;
  y: number;
}

/** WGS-84 geographic coordinate in decimal degrees. */
export interface LonLatCoordinate {
  lon: number;
  lat: number;
}

/** Matched PDF-to-WGS-84 control point pair. */
export interface TransformControlPoint {
  pdf: PdfCoordinate;
  map: LonLatCoordinate;
}

/** Solved 6-parameter 2D affine transform from PDF coordinates to WGS-84. */
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

/** Solved thin-plate spline transform from PDF coordinates to WGS-84. */
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

/** Per-point residual diagnostic from transform fitting. */
export interface TransformResidual {
  index: number;
  predicted: LonLatCoordinate;
  actual: LonLatCoordinate;
  errorMeters: number;
}

/** Result of solving a PDF→WGS-84 coordinate transform. */
export interface TransformSolveResult {
  transform: SolvedTransform;
  residuals: TransformResidual[];
  rmsErrorMeters: number;
}

/** Candidate control point option belonging to a single PDF landmark group. */
export interface CandidateControlPointOption<T = unknown> {
  pdf: PdfCoordinate;
  map: LonLatCoordinate;
  /** Prior confidence weight in [0, 1]. */
  priorConfidence?: number;
  metadata?: T;
}

/** Candidate control point chosen as an affine-consistent inlier. */
export interface SelectedControlPoint<
  T = unknown
> extends CandidateControlPointOption<T> {
  residualMeters: number;
}

/** Options controlling similarity/affine consensus selection. */
export interface ConsistencySelectOptions {
  /** Maximum number of well-spaced inliers to return (default 4). */
  maxPoints?: number;
  /** Expected CCW map rotation in degrees from North-up (0 = North-up). */
  expectedRotationDegrees?: number;
  /** Maximum angular deviation from expectedRotationDegrees when set. */
  maxRotationDeviationDegrees?: number;
  /** Characteristic PDF page span in points used to enforce minimum spread. */
  pdfSpanHint?: number;
}

/** Result of geometric RANSAC + affine consistency filtering over candidate landmarks. */
export interface ConsistentControlPointSelection<T = unknown> {
  selected: SelectedControlPoint<T>[];
  rmsErrorMeters: number;
  scaleMetersPerPdfUnit: number;
  rotationDegrees: number;
}

const EARTH_RADIUS_METERS = 6371008.8;
const TPS_MIN_POINTS = 6;
const MAX_AFFINE_ANISOTROPY = 1.4;

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
 * Transforms a point from a rendered PDF canvas into WGS-84 using the
 * unscaled PDF coordinate space used by the control points.
 */
export function transformRenderedPoint(
  transform: SolvedTransform,
  point: PdfCoordinate,
  scale: number
): LonLatCoordinate {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('PDF render scale must be a positive number.');
  }
  return transformPoint(transform, { x: point.x / scale, y: point.y / scale });
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

/**
 * Computes great-circle distance in meters between two WGS-84 coordinates.
 */
export function haversineDistanceMeters(
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

/**
 * Selects a geometrically consistent, non-mirrored, well-spaced subset of control
 * points from candidate landmark groups using 2-point similarity RANSAC followed
 * by least-squares affine verification and outlier pruning.
 */
export function selectConsistentControlPoints<T = unknown>(
  groups: ReadonlyArray<ReadonlyArray<CandidateControlPointOption<T>>>,
  options: ConsistencySelectOptions = {}
): ConsistentControlPointSelection<T> | null {
  const maxPoints = Math.max(3, options.maxPoints ?? 4);
  const validGroups = groups
    .map((group) =>
      group.filter(
        (opt) =>
          Number.isFinite(opt.pdf.x) &&
          Number.isFinite(opt.pdf.y) &&
          Number.isFinite(opt.map.lon) &&
          Number.isFinite(opt.map.lat) &&
          Math.abs(opt.map.lat) <= 90 &&
          Math.abs(opt.map.lon) <= 180 &&
          !(opt.map.lon === 0 && opt.map.lat === 0)
      )
    )
    .filter((group) => group.length > 0);

  if (validGroups.length < 3) {
    return null;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const group of validGroups) {
    for (const opt of group) {
      if (opt.pdf.x < minX) minX = opt.pdf.x;
      if (opt.pdf.x > maxX) maxX = opt.pdf.x;
      if (opt.pdf.y < minY) minY = opt.pdf.y;
      if (opt.pdf.y > maxY) maxY = opt.pdf.y;
    }
  }

  const pdfSpan = Math.max(
    options.pdfSpanHint ?? 0,
    Math.hypot(maxX - minX, maxY - minY),
    100
  );
  const minPdfPairDist = Math.max(12, pdfSpan * 0.06);

  interface InlierEntry {
    groupIndex: number;
    optionIndex: number;
    option: CandidateControlPointOption<T>;
    approxErrorMeters: number;
  }

  interface ConsensusHypothesis {
    key: string;
    score: number;
    scale: number;
    inliers: InlierEntry[];
  }

  const hypothesesMap = new Map<string, ConsensusHypothesis>();

  for (let gi = 0; gi < validGroups.length; gi++) {
    for (let gj = gi + 1; gj < validGroups.length; gj++) {
      for (const p of validGroups[gi]) {
        for (const q of validGroups[gj]) {
          const pdfDist = Math.hypot(q.pdf.x - p.pdf.x, q.pdf.y - p.pdf.y);
          if (pdfDist < minPdfPairDist) continue;

          const mapDist = haversineDistanceMeters(p.map, q.map);
          if (mapDist < 25 || mapDist > 200_000) continue;

          const scale = mapDist / pdfDist;
          if (scale < 0.015 || scale > 600) continue;

          const refLon = (p.map.lon + q.map.lon) / 2;
          const refLat = (p.map.lat + q.map.lat) / 2;

          const pMeters = projectToLocalMeters(p.map, refLon, refLat);
          const qMeters = projectToLocalMeters(q.map, refLon, refLat);

          // Right-handed PDF coordinates (u = x, v = -y) so North-up maps have det > 0 and rotation ~ 0°.
          const up = p.pdf.x;
          const vp = -p.pdf.y;
          const uq = q.pdf.x;
          const vq = -q.pdf.y;
          const du = uq - up;
          const dv = vq - vp;
          const d2 = du * du + dv * dv;
          if (d2 <= 0) continue;

          const dE = qMeters.east - pMeters.east;
          const dN = qMeters.north - pMeters.north;

          const c = (du * dE + dv * dN) / d2;
          const s = (du * dN - dv * dE) / d2;
          const tE = pMeters.east - (c * up - s * vp);
          const tN = pMeters.north - (s * up + c * vp);
          const rotationDeg = (Math.atan2(s, c) * 180) / Math.PI;

          if (
            options.expectedRotationDegrees !== undefined &&
            options.maxRotationDeviationDegrees !== undefined
          ) {
            const diff = Math.abs(
              normalizeAngleDegrees(
                rotationDeg - options.expectedRotationDegrees
              )
            );
            if (diff > options.maxRotationDeviationDegrees) {
              continue;
            }
          }

          const inlierThresholdMeters = Math.max(45, Math.min(450, scale * 32));

          const inliers: InlierEntry[] = [];
          for (let gk = 0; gk < validGroups.length; gk++) {
            let bestOptionIdx = -1;
            let bestOption: CandidateControlPointOption<T> | null = null;
            let bestErr = Infinity;

            const group = validGroups[gk];
            for (let oi = 0; oi < group.length; oi++) {
              const cand = group[oi];
              const m = projectToLocalMeters(cand.map, refLon, refLat);
              const u = cand.pdf.x;
              const v = -cand.pdf.y;
              const predE = c * u - s * v + tE;
              const predN = s * u + c * v + tN;
              const err = Math.hypot(m.east - predE, m.north - predN);
              if (err < bestErr) {
                bestErr = err;
                bestOption = cand;
                bestOptionIdx = oi;
              }
            }

            if (bestOption && bestErr <= inlierThresholdMeters) {
              inliers.push({
                groupIndex: gk,
                optionIndex: bestOptionIdx,
                option: bestOption,
                approxErrorMeters: bestErr
              });
            }
          }

          if (inliers.length < 3) continue;
          if (
            maxTriangleAltitude(inliers.map((item) => item.option.pdf)) <
            minPdfPairDist * 0.55
          ) {
            continue;
          }

          const key = inliers
            .map((item) => `${item.groupIndex}:${item.optionIndex}`)
            .join('|');

          const inlierQuality = inliers.reduce(
            (sum, item) =>
              sum +
              (item.option.priorConfidence ?? 0.75) *
                Math.max(
                  0,
                  1 - item.approxErrorMeters / (inlierThresholdMeters * 1.5)
                ),
            0
          );
          const northUpBonus =
            options.expectedRotationDegrees === undefined &&
            Math.abs(rotationDeg) <= 20
              ? 0.4
              : 0;
          const spreadBonus = Math.min(
            0.6,
            computePdfSpreadScore(
              inliers.map((item) => item.option.pdf),
              pdfSpan
            )
          );
          const score =
            inliers.length * 10 + inlierQuality + northUpBonus + spreadBonus;

          const existing = hypothesesMap.get(key);
          if (!existing || score > existing.score) {
            hypothesesMap.set(key, {
              key,
              score,
              scale,
              inliers
            });
          }
        }
      }
    }
  }

  const rankedHypotheses = Array.from(hypothesesMap.values()).sort(
    (a, b) => b.score - a.score
  );

  for (const hypothesis of rankedHypotheses.slice(0, 12)) {
    let working = hypothesis.inliers.map((item) => item.option);

    const validated = refineAndValidateInliers(
      working,
      minPdfPairDist * 0.55,
      hypothesis.scale
    );
    if (!validated) continue;

    working = validated.points;
    if (working.length > maxPoints) {
      working = selectWellSpacedSubset(working, maxPoints, pdfSpan);
    }

    const finalCheck = computeAffineDiagnostics(working);
    if (!finalCheck) continue;

    return {
      selected: working.map((opt, idx) => ({
        ...opt,
        residualMeters: finalCheck.solveResult.residuals[idx].errorMeters
      })),
      rmsErrorMeters: finalCheck.solveResult.rmsErrorMeters,
      scaleMetersPerPdfUnit: finalCheck.scaleMetersPerPdfUnit,
      rotationDegrees: finalCheck.rotationDegrees
    };
  }

  return null;
}

function refineAndValidateInliers<T>(
  initialPoints: CandidateControlPointOption<T>[],
  minAltitude: number,
  approxScale: number
): {
  points: CandidateControlPointOption<T>[];
} | null {
  let current = [...initialPoints];

  while (current.length >= 3) {
    if (maxTriangleAltitude(current.map((p) => p.pdf)) < minAltitude) {
      return null;
    }

    const diag = computeAffineDiagnostics(current);
    if (!diag) {
      if (current.length === 3) return null;
      // Try dropping the point with lowest prior confidence if affine was anisotropic
      let worstIdx = 0;
      for (let i = 1; i < current.length; i++) {
        if (
          (current[i].priorConfidence ?? 0.75) <
          (current[worstIdx].priorConfidence ?? 0.75)
        ) {
          worstIdx = i;
        }
      }
      current.splice(worstIdx, 1);
      continue;
    }

    if (current.length === 3) {
      return { points: current };
    }

    const errors = diag.solveResult.residuals.map((r) => r.errorMeters);
    const sortedErrors = [...errors].sort((a, b) => a - b);
    const medianError = sortedErrors[Math.floor(sortedErrors.length / 2)];
    let maxErr = -1;
    let maxIdx = -1;
    for (let i = 0; i < errors.length; i++) {
      if (errors[i] > maxErr) {
        maxErr = errors[i];
        maxIdx = i;
      }
    }

    const pruneThreshold = Math.max(45, medianError * 2.8, approxScale * 18);
    if (maxIdx >= 0 && maxErr > pruneThreshold) {
      const next = current.filter((_, idx) => idx !== maxIdx);
      if (maxTriangleAltitude(next.map((p) => p.pdf)) >= minAltitude) {
        current = next;
        continue;
      }
    }

    return { points: current };
  }

  return null;
}

function computeAffineDiagnostics(points: TransformControlPoint[]): {
  solveResult: TransformSolveResult;
  scaleMetersPerPdfUnit: number;
  rotationDegrees: number;
} | null {
  let solveResult: TransformSolveResult;
  try {
    solveResult = solveAffineTransform(points);
  } catch {
    return null;
  }

  if (solveResult.transform.type !== 'affine') {
    return null;
  }

  const refLat = points.reduce((sum, p) => sum + p.map.lat, 0) / points.length;
  const kLon = toRadians(1) * EARTH_RADIUS_METERS * Math.cos(toRadians(refLat));
  const kLat = toRadians(1) * EARTH_RADIUS_METERS;

  const { a, b } = solveResult.transform.lon;
  const { d, e } = solveResult.transform.lat;

  // Jacobian from right-handed PDF (u = x, v = -y) to local (East, North) meters
  const m11 = a * kLon;
  const m12 = -b * kLon;
  const m21 = d * kLat;
  const m22 = -e * kLat;

  const det = m11 * m22 - m12 * m21;
  if (!(det > 0)) {
    return null;
  }

  const s1 = m11 * m11 + m12 * m12 + m21 * m21 + m22 * m22;
  const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
  const sigmaMax = Math.sqrt((s1 + disc) / 2);
  const sigmaMin = Math.sqrt(Math.max(0, (s1 - disc) / 2));

  if (!(sigmaMin > 0) || sigmaMax / sigmaMin > MAX_AFFINE_ANISOTROPY + 0.1) {
    return null;
  }

  const scaleMetersPerPdfUnit = Math.sqrt(det);
  const rotationDegrees = (Math.atan2(m21 - m12, m11 + m22) * 180) / Math.PI;

  return {
    solveResult,
    scaleMetersPerPdfUnit,
    rotationDegrees
  };
}

function selectWellSpacedSubset<T>(
  points: CandidateControlPointOption<T>[],
  maxPoints: number,
  pdfSpan: number
): CandidateControlPointOption<T>[] {
  if (points.length <= maxPoints) return points;

  let bestI = 0;
  let bestJ = 1;
  let bestPairScore = -Infinity;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dist =
        Math.hypot(
          points[j].pdf.x - points[i].pdf.x,
          points[j].pdf.y - points[i].pdf.y
        ) / pdfSpan;
      const conf =
        ((points[i].priorConfidence ?? 0.75) +
          (points[j].priorConfidence ?? 0.75)) *
        0.15;
      if (dist + conf > bestPairScore) {
        bestPairScore = dist + conf;
        bestI = i;
        bestJ = j;
      }
    }
  }

  const chosenIndices = new Set<number>([bestI, bestJ]);
  while (chosenIndices.size < maxPoints) {
    let nextIdx = -1;
    let nextScore = -Infinity;

    for (let i = 0; i < points.length; i++) {
      if (chosenIndices.has(i)) continue;
      let minDist = Infinity;
      for (const existingIdx of chosenIndices) {
        const d = Math.hypot(
          points[i].pdf.x - points[existingIdx].pdf.x,
          points[i].pdf.y - points[existingIdx].pdf.y
        );
        if (d < minDist) minDist = d;
      }
      const score =
        minDist / pdfSpan + (points[i].priorConfidence ?? 0.75) * 0.1;
      if (score > nextScore) {
        nextScore = score;
        nextIdx = i;
      }
    }

    if (nextIdx < 0) break;
    chosenIndices.add(nextIdx);
  }

  return Array.from(chosenIndices).map((idx) => points[idx]);
}

function maxTriangleAltitude(points: ReadonlyArray<PdfCoordinate>): number {
  if (points.length < 3) return 0;

  let bestBaseA = points[0];
  let bestBaseB = points[1];
  let maxBaseLen = -1;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const len = Math.hypot(
        points[j].x - points[i].x,
        points[j].y - points[i].y
      );
      if (len > maxBaseLen) {
        maxBaseLen = len;
        bestBaseA = points[i];
        bestBaseB = points[j];
      }
    }
  }

  if (maxBaseLen <= 1e-6) return 0;

  const dx = bestBaseB.x - bestBaseA.x;
  const dy = bestBaseB.y - bestBaseA.y;
  let maxAlt = 0;
  for (const p of points) {
    const cross = Math.abs(dx * (p.y - bestBaseA.y) - dy * (p.x - bestBaseA.x));
    const alt = cross / maxBaseLen;
    if (alt > maxAlt) maxAlt = alt;
  }

  return maxAlt;
}

function computePdfSpreadScore(
  points: ReadonlyArray<PdfCoordinate>,
  pdfSpan: number
): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const areaRatio = ((maxX - minX) * (maxY - minY)) / (pdfSpan * pdfSpan);
  return Math.max(0, Math.min(1, areaRatio));
}

function projectToLocalMeters(
  coord: LonLatCoordinate,
  refLon: number,
  refLat: number
): { east: number; north: number } {
  return {
    east:
      toRadians(coord.lon - refLon) *
      EARTH_RADIUS_METERS *
      Math.cos(toRadians(refLat)),
    north: toRadians(coord.lat - refLat) * EARTH_RADIUS_METERS
  };
}

function normalizeAngleDegrees(angle: number): number {
  let normalized = ((((angle + 180) % 360) + 360) % 360) - 180;
  if (normalized === -180) normalized = 180;
  return normalized;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
