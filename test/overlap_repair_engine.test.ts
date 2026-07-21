import { detectOverlaps, repairOverlaps } from 'app/lib/overlap_repair_engine';
import type { DigitizerFeature } from 'types/digitizer';
import { beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeFeature(
  coordinates: number[][][],
  overrides: Partial<DigitizerFeature> = {}
): DigitizerFeature {
  idCounter++;
  return {
    id: `feature-${idCounter}`,
    geometry: { type: 'Polygon', coordinates },
    properties: {
      planning_class: 'Residential',
      raw_zoning_label: 'R-1',
      confidence: 1.0,
      source_type: 'digitized',
      source_name: 'test.pdf',
      human_confirmed: true
    },
    ...overrides
  };
}

// Base polygon A: 0.1° × 0.1° square near San Francisco
// Longitude: -122.5 → -122.4 (west → east)
// Latitude:   37.7  →  37.8  (south → north)
const BASE_A: number[][][] = [
  [
    [-122.5, 37.7],
    [-122.4, 37.7],
    [-122.4, 37.8],
    [-122.5, 37.8],
    [-122.5, 37.7]
  ]
];

// Sliver neighbour B: overlaps A by a 0.001° strip on A's eastern edge
// B spans -122.401 → -122.3, so overlap region is -122.401 to -122.4 = 0.001° wide
// Overlap fraction ≈ 0.001/0.1 = 1% → sliver
const SLIVER_B: number[][][] = [
  [
    [-122.401, 37.7],
    [-122.3, 37.7],
    [-122.3, 37.8],
    [-122.401, 37.8],
    [-122.401, 37.7]
  ]
];

// Significant neighbour: overlaps A on the *west* side by 0.05° → 50% of A's width → significant
// Placed to the west of A so it is disjoint from SLIVER_B (which extends east).
const SIGNIFICANT_B: number[][][] = [
  [
    [-122.55, 37.7],
    [-122.45, 37.7],
    [-122.45, 37.8],
    [-122.55, 37.8],
    [-122.55, 37.7]
  ]
];

// Small polygon fully inside BASE_A — makes BASE_A 9× larger → containment
const INNER_B: number[][][] = [
  [
    [-122.48, 37.72],
    [-122.42, 37.72],
    [-122.42, 37.78],
    [-122.48, 37.78],
    [-122.48, 37.72]
  ]
];

// Non-overlapping polygon (completely disjoint from BASE_A)
const DISJOINT_B: number[][][] = [
  [
    [-121.5, 36.7],
    [-121.4, 36.7],
    [-121.4, 36.8],
    [-121.5, 36.8],
    [-121.5, 36.7]
  ]
];

// ---------------------------------------------------------------------------
// detectOverlaps
// ---------------------------------------------------------------------------

describe('detectOverlaps', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it('returns no issues for a single feature', () => {
    const issues = detectOverlaps([makeFeature(BASE_A)]);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues for disjoint features', () => {
    const issues = detectOverlaps([
      makeFeature(BASE_A),
      makeFeature(DISJOINT_B)
    ]);
    expect(issues).toHaveLength(0);
  });

  it('classifies a thin edge overlap as sliver', () => {
    const issues = detectOverlaps([makeFeature(BASE_A), makeFeature(SLIVER_B)]);
    expect(issues).toHaveLength(1);
    expect(issues[0].overlapType).toBe('sliver');
    expect(issues[0].overlapFraction).toBeLessThanOrEqual(0.02);
  });

  it('classifies a 50% area overlap as significant', () => {
    const issues = detectOverlaps([
      makeFeature(BASE_A),
      makeFeature(SIGNIFICANT_B)
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].overlapType).toBe('significant');
    expect(issues[0].overlapFraction).toBeGreaterThan(0.02);
    expect(issues[0].overlapFraction).toBeLessThan(0.85);
  });

  it('classifies a small polygon fully inside a large polygon as containment', () => {
    const issues = detectOverlaps([makeFeature(BASE_A), makeFeature(INNER_B)]);
    expect(issues).toHaveLength(1);
    expect(issues[0].overlapType).toBe('containment');
    expect(issues[0].overlapFraction).toBeGreaterThanOrEqual(0.85);
  });

  it('classifies two near-identical polygons as duplicate', () => {
    const issues = detectOverlaps([makeFeature(BASE_A), makeFeature(BASE_A)]);
    expect(issues).toHaveLength(1);
    expect(issues[0].overlapType).toBe('duplicate');
    expect(issues[0].overlapFraction).toBeCloseTo(1.0, 2);
  });

  it('populates featureAId and featureBId correctly', () => {
    const a = makeFeature(BASE_A);
    const b = makeFeature(SLIVER_B);
    const issues = detectOverlaps([a, b]);
    expect(issues[0].featureAId).toBe(a.id);
    expect(issues[0].featureBId).toBe(b.id);
  });

  it('provides a human-readable description', () => {
    const issues = detectOverlaps([
      makeFeature(BASE_A),
      makeFeature(SIGNIFICANT_B)
    ]);
    expect(issues[0].description).toMatch(/R-1/);
    expect(issues[0].description).toMatch(/significant/i);
  });

  it('reports overlap area in m² (positive number)', () => {
    const issues = detectOverlaps([
      makeFeature(BASE_A),
      makeFeature(SIGNIFICANT_B)
    ]);
    expect(issues[0].overlapAreaM2).toBeGreaterThan(0);
  });

  it('detects all pairs in a three-feature set', () => {
    // A overlaps with B (sliver) and C (significant); B and C are disjoint from each other
    const a = makeFeature(BASE_A);
    const b = makeFeature(SLIVER_B);
    const c = makeFeature(SIGNIFICANT_B);
    const issues = detectOverlaps([a, b, c]);
    // A–B sliver, A–C significant; B (east of A) and C (west of A) do not overlap
    expect(issues).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// repairOverlaps
// ---------------------------------------------------------------------------

describe('repairOverlaps', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it('returns empty maps and no unresolved issues when there are no overlaps', () => {
    const result = repairOverlaps([
      makeFeature(BASE_A),
      makeFeature(DISJOINT_B)
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.repairedFeatures.size).toBe(0);
    expect(result.unresolvedIssues).toHaveLength(0);
  });

  it('auto-repairs a sliver by trimming the lower-confidence feature', () => {
    const a = makeFeature(BASE_A, {
      properties: {
        planning_class: 'Residential',
        raw_zoning_label: 'R-1',
        confidence: 0.9,
        source_type: 'digitized',
        source_name: 'test.pdf',
        human_confirmed: true
      }
    });
    const b = makeFeature(SLIVER_B, {
      properties: {
        planning_class: 'Commercial',
        raw_zoning_label: 'C-1',
        confidence: 0.6, // lower → gets trimmed
        source_type: 'digitized',
        source_name: 'test.pdf',
        human_confirmed: false
      }
    });

    const result = repairOverlaps([a, b]);

    // The sliver should be auto-repaired
    expect(result.unresolvedIssues).toHaveLength(0);
    // b was trimmed — it should appear in repairedFeatures
    const repairedB = result.repairedFeatures.get(b.id);
    expect(repairedB).not.toBeNull();
    expect(repairedB).toBeDefined();
    // After trimming, the two features should no longer overlap
    if (repairedB) {
      const issues = detectOverlaps([a, repairedB]);
      expect(issues).toHaveLength(0);
    }
  });

  it('auto-removes the duplicate with lower priority (same label)', () => {
    const a = makeFeature(BASE_A, {
      id: 'dup-a',
      properties: {
        planning_class: 'Residential',
        raw_zoning_label: 'R-1',
        confidence: 0.9,
        source_type: 'digitized',
        source_name: 'test.pdf',
        human_confirmed: true // higher priority
      }
    });
    const b = makeFeature(BASE_A, {
      id: 'dup-b',
      properties: {
        planning_class: 'Residential',
        raw_zoning_label: 'R-1', // same label
        confidence: 0.7,
        source_type: 'digitized',
        source_name: 'test.pdf',
        human_confirmed: false
      }
    });

    const result = repairOverlaps([a, b]);

    expect(result.unresolvedIssues).toHaveLength(0);
    // b should be removed (a is human-confirmed, b is not)
    expect(result.repairedFeatures.get('dup-b')).toBeNull();
    expect(result.repairedFeatures.has('dup-a')).toBe(false);
  });

  it('leaves a duplicate with different labels as unresolved', () => {
    const a = makeFeature(BASE_A, {
      properties: {
        planning_class: 'Residential',
        raw_zoning_label: 'R-1',
        confidence: 1.0,
        source_type: 'digitized',
        source_name: 'test.pdf',
        human_confirmed: true
      }
    });
    const b = makeFeature(BASE_A, {
      properties: {
        planning_class: 'Commercial',
        raw_zoning_label: 'C-2', // different label → cannot auto-resolve
        confidence: 1.0,
        source_type: 'digitized',
        source_name: 'test.pdf',
        human_confirmed: true
      }
    });

    const result = repairOverlaps([a, b]);

    expect(result.unresolvedIssues).toHaveLength(1);
    expect(result.unresolvedIssues[0].overlapType).toBe('duplicate');
  });

  it('leaves containment overlaps as unresolved', () => {
    const result = repairOverlaps([makeFeature(BASE_A), makeFeature(INNER_B)]);
    expect(result.unresolvedIssues).toHaveLength(1);
    expect(result.unresolvedIssues[0].overlapType).toBe('containment');
  });

  it('leaves significant overlaps as unresolved', () => {
    const result = repairOverlaps([
      makeFeature(BASE_A),
      makeFeature(SIGNIFICANT_B)
    ]);
    expect(result.unresolvedIssues).toHaveLength(1);
    expect(result.unresolvedIssues[0].overlapType).toBe('significant');
  });

  it('all detected issues are included in issues regardless of repair outcome', () => {
    const result = repairOverlaps([
      makeFeature(BASE_A),
      makeFeature(SIGNIFICANT_B)
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].overlapType).toBe('significant');
  });
});
