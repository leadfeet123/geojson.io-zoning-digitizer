import { toGeoJSON } from 'app/lib/export_pipeline';
import type { DigitizerFeature } from 'types/digitizer';
import { describe, expect, it } from 'vitest';

function makeFeature(overrides: Partial<DigitizerFeature> = {}): DigitizerFeature {
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

    const result = toGeoJSON([feature], 'new.pdf', new Date('2026-01-01T00:00:00.000Z'));

    expect(result.features[0].properties).toEqual(
      expect.objectContaining({
        source_type: 'digitized',
        source_name: 'new.pdf'
      })
    );
  });

  it('exports an empty collection when there are no features', () => {
    const result = toGeoJSON([], 'empty.pdf', new Date('2026-06-15T12:00:00.000Z'));

    expect(result).toEqual({
      type: 'FeatureCollection',
      features: []
    });
  });
});
