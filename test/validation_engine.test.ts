import {
  validateFeature,
  validateFeatureCollection
} from 'app/lib/validation_engine';
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
      source_name: 'example.pdf',
      human_confirmed: true,
      notes: 'manual entry'
    },
    ...overrides
  };
}

describe('validation_engine', () => {
  it('accepts a valid digitizer feature', () => {
    const result = validateFeature(makeFeature());
    expect(result).toEqual([]);
  });

  it('returns required field errors', () => {
    const result = validateFeature(
      makeFeature({
        properties: {
          planning_class: '   ',
          raw_zoning_label: '',
          confidence: 1,
          source_type: 'digitized',
          source_name: '',
          human_confirmed: true
        }
      })
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'planning_class' }),
        expect.objectContaining({ field: 'raw_zoning_label' }),
        expect.objectContaining({ field: 'source_name' })
      ])
    );
  });

  it('enforces confidence range', () => {
    const result = validateFeature(
      makeFeature({
        properties: {
          planning_class: 'Residential',
          raw_zoning_label: 'R-1',
          confidence: 1.2,
          source_type: 'digitized',
          source_name: 'source.pdf',
          human_confirmed: true
        }
      })
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'confidence',
          message: 'confidence must be a number between 0.0 and 1.0'
        })
      ])
    );
  });

  it('blocks low-confidence features without human confirmation', () => {
    const result = validateFeature(
      makeFeature({
        properties: {
          planning_class: 'Residential',
          raw_zoning_label: 'R-1',
          confidence: 0.2,
          source_type: 'digitized',
          source_name: 'source.pdf',
          human_confirmed: false
        }
      })
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'confidence',
          message:
            'features with confidence < 0.5 must be human-confirmed before export'
        })
      ])
    );
  });

  it('validates collections and aggregates errors', () => {
    const valid = makeFeature();
    const invalid = makeFeature({
      id: 'feature-2',
      properties: {
        planning_class: '',
        raw_zoning_label: 'R-2',
        confidence: 1,
        source_type: 'digitized',
        source_name: 'example.pdf',
        human_confirmed: true
      }
    });

    const result = validateFeatureCollection([valid, invalid]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        featureId: 'feature-2',
        field: 'planning_class'
      })
    );
  });
});
