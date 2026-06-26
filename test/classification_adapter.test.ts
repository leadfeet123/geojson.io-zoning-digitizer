import {
  LookupClassificationAdapter,
  parseClassificationResponse
} from 'app/lib/classification_adapter';
import { describe, expect, it } from 'vitest';

describe('classification_adapter', () => {
  it('parses and clamps confidence from model response', () => {
    const suggestions = parseClassificationResponse(
      JSON.stringify({
        suggestions: [
          {
            planning_class: 'Commercial',
            confidence: 1.2,
            rationale: 'matched prefix'
          },
          {
            planning_class: '  Residential  ',
            confidence: -0.2,
            rationale: 'fallback'
          }
        ]
      })
    );

    expect(suggestions).toEqual([
      {
        planning_class: 'Commercial',
        confidence: 1,
        rationale: 'matched prefix'
      },
      {
        planning_class: 'Residential',
        confidence: 0,
        rationale: 'fallback'
      }
    ]);
  });

  it('returns empty array for malformed payload', () => {
    expect(parseClassificationResponse('{not-json')).toEqual([]);
  });

  it('returns lookup suggestion for known zoning prefix', async () => {
    const adapter = new LookupClassificationAdapter();

    await expect(
      adapter.suggestPlanningClass({ rawZoningLabel: 'C-2' })
    ).resolves.toEqual([
      {
        planning_class: 'Commercial',
        confidence: 0.62,
        rationale: 'Lookup mapping from commercial zoning prefixes'
      }
    ]);
  });

  it('returns no lookup suggestion for unknown prefix', async () => {
    const adapter = new LookupClassificationAdapter();

    await expect(
      adapter.suggestPlanningClass({ rawZoningLabel: 'ZZ-1' })
    ).resolves.toEqual([]);
  });
});
