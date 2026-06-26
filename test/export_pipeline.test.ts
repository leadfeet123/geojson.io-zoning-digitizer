import { toGeoJSON, guardExport } from 'app/lib/export_pipeline';
import type { DigitizerFeature } from 'types/digitizer';
import { describe, expect, it } from 'vitest';

function makeFeature(
  overrides: Partial<DigitizerFeature> = {}
): DigitizerFeature {
  return {
    id: 'feature-1',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-122.5, 37.7],
          [-122.4, 37.7],
          [-122.4, 37.8],
          [-122.5, 37.8],
          [-122.5, 37.7]
        ]
      ]
    },
    properties: {
      planning_class: 'Residential',
      raw_zoning_label: 'R-1',
      confidence: 1,
      source_type: 'digitized',
      source_name: 'ignored-in-export.pdf',
      human_confirmed: true,
      notes: 'manual',
      digitized_by: 'planner@example.org'
    },
    ...overrides
  };
}

describe('export_pipeline', () => {
  it('exports a schema-compliant feature collection', () => {
    const fixedNow = new Date('2026-06-15T12:00:00.000Z');
    const result = toGeoJSON([makeFeature()], 'zoning-source.pdf', fixedNow);

    expect(result).toEqual({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-122.5, 37.7],
                [-122.4, 37.7],
                [-122.4, 37.8],
                [-122.5, 37.8],
                [-122.5, 37.7]
              ]
            ]
          },
          properties: {
            planning_class: 'Residential',
            raw_zoning_label: 'R-1',
            confidence: 1,
            source_type: 'digitized',
            source_name: 'zoning-source.pdf',
            human_confirmed: true,
            notes: 'manual',
            digitized_at: '2026-06-15T12:00:00.000Z',
            digitized_by: 'planner@example.org'
          }
        }
      ]
    });
  });

  it('overrides source_type and source_name from export inputs', () => {
    const feature = makeFeature({
      properties: {
        planning_class: 'Residential',
        raw_zoning_label: 'R-1',
        confidence: 0.9,
        source_type: 'digitized',
        source_name: 'old.pdf',
        human_confirmed: false
      }
    });

    const result = toGeoJSON(
      [feature],
      'new.pdf',
      new Date('2026-01-01T00:00:00.000Z')
    );

    expect(result.features[0].properties).toEqual(
      expect.objectContaining({
        source_type: 'digitized',
        source_name: 'new.pdf'
      })
    );
  });

  it('exports an empty collection when there are no features', () => {
    const result = toGeoJSON(
      [],
      'empty.pdf',
      new Date('2026-06-15T12:00:00.000Z')
    );

    expect(result).toEqual({
      type: 'FeatureCollection',
      features: []
    });
  });
});

describe('guardExport', () => {
  it('returns ok when all features are high-confidence or human-confirmed', () => {
    const highConf = makeFeature({
      properties: {
        planning_class: 'Residential',
        raw_zoning_label: 'R-1',
        confidence: 0.9,
        source_type: 'digitized',
        source_name: 'a.pdf',
        human_confirmed: false
      }
    });
    const confirmed = makeFeature({
      id: 'feature-2',
      properties: {
        planning_class: 'Commercial',
        raw_zoning_label: 'C-1',
        confidence: 0.3,
        source_type: 'digitized',
        source_name: 'a.pdf',
        human_confirmed: true
      }
    });

    const result = guardExport([highConf, confirmed]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('blocks export when a low-confidence feature is not confirmed', () => {
    const lowConf = makeFeature({
      properties: {
        planning_class: 'Mixed Use',
        raw_zoning_label: 'MU-1',
        confidence: 0.3,
        source_type: 'digitized',
        source_name: 'a.pdf',
        human_confirmed: false
      }
    });

    const result = guardExport([lowConf]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].featureId).toBe('feature-1');
    expect(result.errors[0].message).toMatch(/30%/);
    expect(result.errors[0].message).toMatch(/MU-1/);
  });

  it('unblocks when feature is confirmed after being low-confidence', () => {
    const confirmed = makeFeature({
      properties: {
        planning_class: 'Mixed Use',
        raw_zoning_label: 'MU-1',
        confidence: 0.3,
        source_type: 'digitized',
        source_name: 'a.pdf',
        human_confirmed: true
      }
    });

    const result = guardExport([confirmed]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns one error per blocking feature', () => {
    const a = makeFeature({
      properties: {
        planning_class: 'R',
        raw_zoning_label: 'R-1',
        confidence: 0.1,
        source_type: 'digitized',
        source_name: 'a.pdf',
        human_confirmed: false
      }
    });
    const b = makeFeature({
      id: 'feature-b',
      properties: {
        planning_class: 'C',
        raw_zoning_label: 'C-1',
        confidence: 0.2,
        source_type: 'digitized',
        source_name: 'a.pdf',
        human_confirmed: false
      }
    });

    const result = guardExport([a, b]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.featureId)).toContain('feature-1');
    expect(result.errors.map((e) => e.featureId)).toContain('feature-b');
  });
});
