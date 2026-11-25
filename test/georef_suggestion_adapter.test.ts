/* eslint-disable @typescript-eslint/require-await */
import {
  createDefaultGeorefSuggestionAdapter,
  GeminiGeorefSuggestionAdapter,
  HeuristicGeorefSuggestionAdapter,
  parseGeorefSuggestionResponse,
  parseStructuredGeminiLandmarks,
  RemoteGeorefSuggestionAdapter,
  resolveGeorefSuggestionSource
} from 'app/lib/georef_suggestion_adapter';
import type { GeorefGeocoder } from 'app/lib/georef_geocoder';
import { transformPoint, type AffineTransform } from 'app/lib/transform_engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

const generateContentMock = vi.fn();

vi.mock('@google/generative-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/generative-ai')>();
  return {
    ...actual,
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: generateContentMock
        };
      }
    }
  };
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  generateContentMock.mockReset();
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

  it('parses model georef suggestions and clamps confidence', () => {
    const parsed = parseGeorefSuggestionResponse(
      JSON.stringify({
        suggestions: [
          {
            pdf: { x: 100, y: 200 },
            map: { lon: -122.4, lat: 37.7 },
            confidence: 1.4,
            rationale: 'corner candidate'
          },
          {
            pdf: { x: 300, y: 400, page: 9 },
            map: { lon: -122.3, lat: 37.8 },
            confidence: -0.2,
            rationale: 'edge candidate'
          }
        ]
      }),
      3
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0].pdf.page).toBe(3);
    expect(parsed[0].confidence).toBe(1);
    expect(parsed[1].pdf.page).toBe(9);
    expect(parsed[1].confidence).toBe(0);
  });

  it('falls back to heuristic suggestions when Gemini key is missing', async () => {
    const adapter = new GeminiGeorefSuggestionAdapter('');

    const suggestions = await adapter.suggestPoints({
      page: 2,
      mapCenter: { lon: -122.45, lat: 37.76 },
      mapBounds: {
        west: -122.52,
        south: 37.7,
        east: -122.39,
        north: 37.82
      }
    });

    expect(suggestions).toHaveLength(4);
    expect(suggestions.every((suggestion) => suggestion.pdf.page === 2)).toBe(
      true
    );
  });

  it('resolves source label in proxy -> gemini -> heuristic order', () => {
    expect(resolveGeorefSuggestionSource('https://proxy.example', 'key')).toBe(
      'Proxy'
    );
    expect(resolveGeorefSuggestionSource('', 'key')).toBe('Gemini');
    expect(resolveGeorefSuggestionSource('', '')).toBe('Heuristic');
  });

  it('selects concrete adapter in proxy -> gemini -> heuristic order', () => {
    const proxyAdapter = createDefaultGeorefSuggestionAdapter(
      'https://proxy.example',
      'key'
    );
    const geminiAdapter = createDefaultGeorefSuggestionAdapter('', 'key');
    const heuristicAdapter = createDefaultGeorefSuggestionAdapter('', '');

    expect(proxyAdapter).toBeInstanceOf(RemoteGeorefSuggestionAdapter);
    expect(geminiAdapter).toBeInstanceOf(GeminiGeorefSuggestionAdapter);
    expect(heuristicAdapter).toBeInstanceOf(HeuristicGeorefSuggestionAdapter);
  });

  it('parses native Gemini [y, x] 0..1000 spatial landmark coordinates accurately', () => {
    const { context, landmarks } = parseStructuredGeminiLandmarks(
      JSON.stringify({
        geographic_context: {
          municipality: 'Champaign',
          county: 'Champaign County',
          state: 'IL',
          country: 'USA',
          identified_region: 'Champaign, IL',
          north_up: true
        },
        landmarks: [
          {
            street_1: 'W Springfield Ave',
            street_2: 'S Neil St',
            point_2d: [250, 750], // y=250 -> 0.25, x=750 -> 0.75
            approximate_lon: -88.24,
            approximate_lat: 40.11,
            confidence: 0.9,
            rationale: 'Intersection'
          }
        ]
      }),
      1
    );

    expect(context.municipality).toBe('Champaign');
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0].normY).toBeCloseTo(0.25, 5);
    expect(landmarks[0].normX).toBeCloseTo(0.75, 5);
  });

  it('grounds Gemini landmarks against road-network intersections, rejects outliers, and returns unscaled PDF points', async () => {
    // True North-up map in Champaign, IL on an 800x600pt PDF page (while map viewport is in New York!)
    const trueTransform: AffineTransform = {
      type: 'affine',
      lon: { a: 0.0000587, b: 0, c: -88.26 },
      lat: { d: 0, e: -0.0000449, f: 40.13 }
    };

    const p1 = { x: 120, y: 120 }; // point_2d: [200, 150]
    const p2 = { x: 640, y: 120 }; // point_2d: [200, 800]
    const p3 = { x: 120, y: 480 }; // point_2d: [800, 150]
    const p4 = { x: 640, y: 480 }; // point_2d: [800, 800]

    generateContentMock.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({
            geographic_context: {
              municipality: 'City of Champaign',
              county: 'Champaign County',
              state: 'IL',
              country: 'USA',
              identified_region: 'Champaign, Champaign County, IL',
              north_up: true
            },
            landmarks: [
              {
                street_1: 'W Bradley Ave',
                street_2: 'N Mattis Ave',
                point_2d: [200, 150],
                // Deliberately wrong LLM approximate GPS (off by ~5 km!)
                approximate_lon: -88.31,
                approximate_lat: 40.16,
                confidence: 0.9,
                rationale: 'NW intersection'
              },
              {
                street_1: 'E Bradley Ave',
                street_2: 'N Neil St',
                point_2d: [200, 800],
                approximate_lon: -88.19,
                approximate_lat: 40.16,
                confidence: 0.9,
                rationale: 'NE intersection'
              },
              {
                street_1: 'W Kirby Ave',
                street_2: 'S Mattis Ave',
                point_2d: [800, 150],
                approximate_lon: -88.31,
                approximate_lat: 40.07,
                confidence: 0.9,
                rationale: 'SW intersection'
              },
              {
                street_1: 'E Kirby Ave',
                street_2: 'S Neil St',
                point_2d: [800, 800],
                approximate_lon: -88.19,
                approximate_lat: 40.07,
                confidence: 0.9,
                rationale: 'SE intersection'
              },
              {
                // Outlier 5th landmark matched to wrong street miles away
                street_1: 'WChurch St',
                street_2: 'Wrong Rd',
                point_2d: [500, 500],
                approximate_lon: -88.25,
                approximate_lat: 40.11,
                confidence: 0.95,
                rationale: 'Bad landmark'
              }
            ]
          })
      }
    });

    const mockGeocoder: GeorefGeocoder = {
      resolveJurisdiction: vi.fn(async () => ({
        displayName: 'Champaign, Champaign County, Illinois, USA',
        center: { lon: -88.2434, lat: 40.1164 },
        bbox: { west: -88.33, south: 40.05, east: -88.18, north: 40.18 },
        source: 'nominatim' as const
      })),
      resolveIntersections: vi.fn(async () => {
        const map = new Map();
        map.set('lm-0', [
          {
            ...transformPoint(trueTransform, p1),
            source: 'osm_intersection',
            confidence: 0.94,
            matchedNames: 'W Bradley Ave & N Mattis Ave'
          }
        ]);
        map.set('lm-1', [
          {
            ...transformPoint(trueTransform, p2),
            source: 'osm_intersection',
            confidence: 0.94,
            matchedNames: 'E Bradley Ave & N Neil St'
          }
        ]);
        map.set('lm-2', [
          {
            ...transformPoint(trueTransform, p3),
            source: 'osm_intersection',
            confidence: 0.94,
            matchedNames: 'W Kirby Ave & S Mattis Ave'
          }
        ]);
        map.set('lm-3', [
          {
            ...transformPoint(trueTransform, p4),
            source: 'osm_intersection',
            confidence: 0.94,
            matchedNames: 'E Kirby Ave & S Neil St'
          }
        ]);
        map.set('lm-4', [
          {
            lon: -88.11,
            lat: 40.25, // Outlier 15 km away
            source: 'osm_intersection',
            confidence: 0.94,
            matchedNames: 'Wrong Rd'
          }
        ]);
        return map;
      })
    };

    const adapter = new GeminiGeorefSuggestionAdapter(
      'test-api-key',
      undefined,
      mockGeocoder
    );

    // Note: imageWidth/imageHeight are zoomed canvas pixels (1600x1200), while unscaled PDF page is 800x600!
    // And user's mapBounds are in New York (-74.0, 40.7), nowhere near Champaign, IL!
    const suggestions = await adapter.suggestPoints({
      page: 1,
      mapCenter: { lon: -74.006, lat: 40.7128 },
      mapBounds: { west: -74.1, south: 40.6, east: -73.9, north: 40.8 },
      imageWidth: 1600,
      imageHeight: 1200,
      pdfPageWidth: 800,
      pdfPageHeight: 600
    });

    expect(suggestions).toHaveLength(4);
    expect(suggestions.every((s) => s.provenance === 'gemini_grounded')).toBe(
      true
    );
    // Must not include the outlier at -88.11, 40.25 or NYC coordinates
    expect(suggestions.every((s) => s.map.lon < -88.2)).toBe(true);
    // Must return unscaled PDF coordinates (within 800x600, e.g. x=120 and x=640, NOT 1280)
    const xs = suggestions.map((s) => s.pdf.x).sort((a, b) => a - b);
    expect(xs).toEqual([120, 120, 640, 640]);
    const expectedNw = transformPoint(trueTransform, p1);
    const nw = suggestions.find((s) => s.pdf.x === 120 && s.pdf.y === 120);
    expect(nw?.map.lon).toBeCloseTo(expectedNw.lon, 6);
    expect(nw?.map.lat).toBeCloseTo(expectedNw.lat, 6);
  });

  it('uses embedded GeoPDF control points directly when available', async () => {
    const adapter = new GeminiGeorefSuggestionAdapter('test-api-key');
    const suggestions = await adapter.suggestPoints({
      page: 1,
      mapCenter: { lon: 0, lat: 0 },
      mapBounds: { west: -10, south: -10, east: 10, north: 10 },
      extractedContext: {
        page: 1,
        pdfPageWidth: 792,
        pdfPageHeight: 612,
        embeddedGeoPoints: [
          { pdf: { x: 50, y: 50 }, map: { lon: -88.27, lat: 40.125 } },
          { pdf: { x: 742, y: 50 }, map: { lon: -88.218, lat: 40.125 } },
          { pdf: { x: 742, y: 562 }, map: { lon: -88.218, lat: 40.095 } },
          { pdf: { x: 50, y: 562 }, map: { lon: -88.27, lat: 40.095 } }
        ],
        titleTextCandidates: [],
        streetTextItems: [],
        allTextItems: []
      }
    });

    expect(generateContentMock).not.toHaveBeenCalled();
    expect(suggestions).toHaveLength(4);
    expect(suggestions[0].provenance).toBe('geopdf');
    expect(suggestions[0].confidence).toBeGreaterThan(0.95);
  });
});
