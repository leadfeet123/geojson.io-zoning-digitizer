import {
  HeuristicGeorefSuggestionAdapter,
  RemoteGeorefSuggestionAdapter
} from 'app/lib/georef_suggestion_adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

  it('forwards Gemini key header to remote suggestion endpoint when configured', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          suggestions: [
            {
              pdf: { x: 10, y: 20, page: 1 },
              map: { lon: -122.4, lat: 37.7 },
              confidence: 0.77,
              rationale: 'test'
            }
          ]
        })
      })
    ) as unknown as typeof fetch;

    globalThis.fetch = fetchMock;

    const adapter = new RemoteGeorefSuggestionAdapter(
      'https://example.com/suggest',
      'gemini-key'
    );

    const suggestions = await adapter.suggestPoints({
      page: 1,
      mapCenter: { lon: -122.45, lat: 37.76 },
      mapBounds: {
        west: -122.52,
        south: 37.7,
        east: -122.39,
        north: 37.82
      }
    });

    expect(suggestions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/suggest',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Gemini-Api-Key': 'gemini-key'
        })
      })
    );
  });

  it('omits Gemini key header when no key is configured', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ suggestions: [] })
      })
    ) as unknown as typeof fetch;

    globalThis.fetch = fetchMock;

    const adapter = new RemoteGeorefSuggestionAdapter(
      'https://example.com/suggest'
    );

    await adapter.suggestPoints({
      page: 1,
      mapCenter: { lon: -122.45, lat: 37.76 },
      mapBounds: {
        west: -122.52,
        south: 37.7,
        east: -122.39,
        north: 37.82
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/suggest',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json'
        }
      })
    );
  });
});
