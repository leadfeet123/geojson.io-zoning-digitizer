import measureArea from '@turf/area';
import booleanDisjoint from '@turf/boolean-disjoint';
import { feature as turfFeature, featureCollection } from '@turf/helpers';
import turfIntersect from '@turf/intersect';
import { difference as polyclipDifference } from 'polyclip-ts';
import type { MultiPolygon, Polygon } from 'types';
import type {
  DigitizerFeature,
  OverlapIssue,
  OverlapRepairResult,
  OverlapType
} from 'types/digitizer';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Minimum fraction of the smaller polygon for an overlap to be a duplicate (≥95%). */
const DUPLICATE_FRACTION = 0.95;

/**
 * Maximum size ratio (larger / smaller) between two features for them to still
 * be classified as duplicates rather than containment.
 * E.g. 2.0 means the polygons must be within 2× of each other in area.
 */
const DUPLICATE_SIZE_RATIO = 2.0;

/** Minimum fraction of the smaller polygon for an overlap to be containment (≥85%). */
const CONTAINMENT_FRACTION = 0.85;

/** Maximum fraction of the smaller polygon for an overlap to be a sliver (≤2%). */
const SLIVER_FRACTION = 0.02;

/** Sub-centimeter overlaps are treated as floating-point noise and ignored. */
const NOISE_THRESHOLD_M2 = 0.01;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PolygonLike = Polygon | MultiPolygon;

/** Wraps a DigitizerFeature geometry in a minimal turf Feature for geo operations. */
function toTurf(f: DigitizerFeature) {
  return turfFeature(f.geometry as PolygonLike);
}

/**
 * Classifies an overlap given the intersection area and the two feature areas.
 */
function classifyOverlap(
  overlapAreaM2: number,
  areaAM2: number,
  areaBM2: number
): { overlapType: OverlapType; overlapFraction: number } {
  const smallerArea = Math.min(areaAM2, areaBM2);
  const largerArea = Math.max(areaAM2, areaBM2);

  if (smallerArea <= 0) {
    return { overlapType: 'significant', overlapFraction: 0 };
  }

  const overlapFraction = overlapAreaM2 / smallerArea;
  const sizeRatio = largerArea / smallerArea;

  if (
    overlapFraction >= DUPLICATE_FRACTION &&
    sizeRatio < DUPLICATE_SIZE_RATIO
  ) {
    return { overlapType: 'duplicate', overlapFraction };
  }
  if (overlapFraction >= CONTAINMENT_FRACTION) {
    return { overlapType: 'containment', overlapFraction };
  }
  if (overlapFraction <= SLIVER_FRACTION) {
    return { overlapType: 'sliver', overlapFraction };
  }
  return { overlapType: 'significant', overlapFraction };
}

/** Formats the overlap fraction as a percentage string for descriptions. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function buildDescription(
  overlapType: OverlapType,
  labelA: string,
  labelB: string,
  overlapFraction: number
): string {
  switch (overlapType) {
    case 'duplicate':
      return (
        `Features "${labelA}" and "${labelB}" share ${pct(overlapFraction)} of ` +
        `the smaller polygon — likely duplicates.`
      );
    case 'containment':
      return (
        `Feature "${labelA}" or "${labelB}" appears to contain the other ` +
        `(${pct(overlapFraction)} overlap) — one may be redundant.`
      );
    case 'sliver':
      return (
        `Features "${labelA}" and "${labelB}" share a sliver overlap ` +
        `(${pct(overlapFraction)}) — likely a boundary alignment issue.`
      );
    case 'significant':
      return (
        `Features "${labelA}" and "${labelB}" have a significant overlap ` +
        `(${pct(overlapFraction)}) that requires manual resolution.`
      );
  }
}

// ---------------------------------------------------------------------------
// Public API: detectOverlaps
// ---------------------------------------------------------------------------

/**
 * Detects all pairwise overlaps between digitizer features.
 *
 * Runs in O(n²) — for sets larger than a few hundred features a spatial index
 * would be appropriate. TODO(phase-3): add RBush pre-filter for large sets.
 */
export function detectOverlaps(features: DigitizerFeature[]): OverlapIssue[] {
  const issues: OverlapIssue[] = [];

  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      const a = features[i];
      const b = features[j];

      const fa = toTurf(a);
      const fb = toTurf(b);

      // Fast reject: booleanDisjoint returns true when geometries do not touch
      if (booleanDisjoint(fa, fb)) continue;

      const intersection = turfIntersect(featureCollection([fa, fb]));
      if (!intersection) continue;

      const overlapAreaM2 = measureArea(intersection);
      if (overlapAreaM2 < NOISE_THRESHOLD_M2) continue;

      const areaAM2 = measureArea(fa);
      const areaBM2 = measureArea(fb);

      const { overlapType, overlapFraction } = classifyOverlap(
        overlapAreaM2,
        areaAM2,
        areaBM2
      );

      const labelA = a.properties.raw_zoning_label || a.id;
      const labelB = b.properties.raw_zoning_label || b.id;

      issues.push({
        featureAId: a.id,
        featureBId: b.id,
        overlapType,
        overlapAreaM2,
        overlapFraction,
        description: buildDescription(
          overlapType,
          labelA,
          labelB,
          overlapFraction
        )
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Internal: geometry difference via JSTS
// ---------------------------------------------------------------------------

/**
 * Returns `target` geometry with `subtractee` removed from it using polyclip-ts.
 * Returns `null` if the result is empty (e.g. the sliver was the entire feature).
 *
 * polyclip-ts accepts GeoJSON coordinate arrays directly and returns MultiPoly
 * coordinates. WGS-84 lon/lat is fine here — topology, not metric accuracy,
 * is what matters for sliver trimming.
 */
function subtractGeometry(
  target: PolygonLike,
  subtractee: PolygonLike
): PolygonLike | null {
  // polyclip-ts Geom = Poly | MultiPoly, which matches GeoJSON coordinates exactly
  const targetCoords = target.coordinates as Parameters<
    typeof polyclipDifference
  >[0];
  const subtracteeCoords = subtractee.coordinates as Parameters<
    typeof polyclipDifference
  >[0];

  const result = polyclipDifference(targetCoords, subtracteeCoords);

  if (!result || result.length === 0) return null;

  if (result.length === 1) {
    return { type: 'Polygon', coordinates: result[0] } as Polygon;
  }
  return { type: 'MultiPolygon', coordinates: result } as MultiPolygon;
}

// ---------------------------------------------------------------------------
// Internal: repair decision helpers
// ---------------------------------------------------------------------------

/**
 * Returns which feature to trim for a sliver repair.
 * Trims the lower-confidence feature; breaks ties by choosing `b`.
 */
function sliverTrimTarget(a: DigitizerFeature, b: DigitizerFeature): 'a' | 'b' {
  if (a.properties.confidence < b.properties.confidence) return 'a';
  if (b.properties.confidence < a.properties.confidence) return 'b';
  return 'b';
}

/**
 * Returns which feature survives a duplicate collapse.
 * Prefers human-confirmed features, then higher confidence.
 */
function duplicateSurvivor(
  a: DigitizerFeature,
  b: DigitizerFeature
): 'a' | 'b' {
  if (a.properties.human_confirmed && !b.properties.human_confirmed) return 'a';
  if (b.properties.human_confirmed && !a.properties.human_confirmed) return 'b';
  return a.properties.confidence >= b.properties.confidence ? 'a' : 'b';
}

// ---------------------------------------------------------------------------
// Public API: repairOverlaps
// ---------------------------------------------------------------------------

/**
 * Detects overlaps between all features and attempts to auto-repair obvious cases.
 *
 * **Auto-repaired:**
 * - `sliver` — the overlap is subtracted from the lower-confidence feature.
 * - `duplicate` with the same `raw_zoning_label` — the lower-priority feature is removed.
 *
 * **Left to human review (unresolvedIssues):**
 * - `duplicate` with different labels — cannot determine the correct label automatically.
 * - `containment` — structural issue that requires domain judgment.
 * - `significant` — meaningful zone boundary conflict.
 *
 * The returned `repairedFeatures` map contains only mutated features.
 * A `null` value means the feature was removed.
 */
export function repairOverlaps(
  features: DigitizerFeature[]
): OverlapRepairResult {
  const working = new Map<string, DigitizerFeature>(
    features.map((f) => [f.id, f])
  );

  const issues = detectOverlaps(features);
  const repairedFeatures = new Map<string, DigitizerFeature | null>();
  const unresolvedIssues: OverlapIssue[] = [];

  for (const issue of issues) {
    const a = working.get(issue.featureAId);
    const b = working.get(issue.featureBId);

    // Skip if a previous repair already removed one of the pair
    if (!a || !b) continue;

    if (issue.overlapType === 'sliver') {
      const fa = toTurf(a);
      const fb = toTurf(b);
      const intersection = turfIntersect(featureCollection([fa, fb]));
      if (!intersection) continue;

      const overlapGeom = intersection.geometry as PolygonLike;
      const trimSide = sliverTrimTarget(a, b);
      const target = trimSide === 'a' ? a : b;

      const newGeom = subtractGeometry(
        target.geometry as PolygonLike,
        overlapGeom
      );

      if (newGeom) {
        const repaired: DigitizerFeature = { ...target, geometry: newGeom };
        working.set(repaired.id, repaired);
        repairedFeatures.set(repaired.id, repaired);
      } else {
        // Subtraction collapsed the feature — needs human review
        unresolvedIssues.push(issue);
      }
    } else if (issue.overlapType === 'duplicate') {
      const sameLabel =
        a.properties.raw_zoning_label === b.properties.raw_zoning_label;

      if (sameLabel) {
        const survivor = duplicateSurvivor(a, b);
        const removedId = survivor === 'a' ? b.id : a.id;
        working.delete(removedId);
        repairedFeatures.set(removedId, null);
      } else {
        // Different labels on near-identical geometries — needs human resolution
        unresolvedIssues.push(issue);
      }
    } else {
      // containment, significant — cannot auto-repair without domain knowledge
      unresolvedIssues.push(issue);
    }
  }

  return { issues, repairedFeatures, unresolvedIssues };
}
