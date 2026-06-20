import { HeuristicGeorefSuggestionAdapter } from 'app/lib/georef_suggestion_adapter';
import { describe, expect, it } from 'vitest';

describe('georef_suggestion_adapter', () => {
  it('returns 4 suggestions scoped to the requested page', async () => {
    const adapter = new HeuristicGeorefSuggestionAdapter();

    const suggestions = await adapter.suggestPoints({
      page: 3,
      mapCenter: { lon: -122.45, lat: 37.76 },
      mapBounds: {
        west: -122.52,
        south: 37.7,
        east: -122.39,
        north: 37.82
      }
    });

    expect(suggestions).toHaveLength(4);
    expect(suggestions.every((s) => s.pdf.page === 3)).toBe(true);
    expect(
      suggestions.every((s) => s.confidence >= 0 && s.confidence <= 1)
    ).toBe(true);
  });
});
