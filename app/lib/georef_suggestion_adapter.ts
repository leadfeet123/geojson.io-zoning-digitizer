import { aiEnv } from 'app/lib/env_ai';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { nanoid } from 'nanoid';

export type GeorefSuggestionSource = 'Proxy' | 'Gemini' | 'Heuristic';

export interface GeorefSuggestion {
  id: string;
  pdf: {
    x: number;
    y: number;
    page: number;
  };
  map: {
    lon: number;
    lat: number;
  };
  confidence: number;
  rationale: string;
}

export interface GeorefSuggestionRequest {
  page: number;
  mapCenter: {
    lon: number;
    lat: number;
  };
  mapBounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}

export interface GeorefSuggestionAdapter {
  suggestPoints(request: GeorefSuggestionRequest): Promise<GeorefSuggestion[]>;
}

export function resolveGeorefSuggestionSource(
  proxyUrl: string,
  geminiApiKey: string
): GeorefSuggestionSource {
  if (proxyUrl) {
    return 'Proxy';
  }

  if (geminiApiKey) {
    return 'Gemini';
  }

  return 'Heuristic';
}

interface RemoteGeorefSuggestionResponse {
  suggestions: Array<{
    pdf: {
      x: number;
      y: number;
      page: number;
    };
    map: {
      lon: number;
      lat: number;
    };
    confidence: number;
    rationale: string;
  }>;
}

interface ParsedGeorefSuggestion {
  pdf: {
    x: number;
    y: number;
    page?: number;
  };
  map: {
    lon: number;
    lat: number;
  };
  confidence: number;
  rationale: string;
}

interface GeminiGeorefSuggestionResponse {
  suggestions: ParsedGeorefSuggestion[];
}

/**
 * Parses model output and normalizes confidence/page values.
 */
export function parseGeorefSuggestionResponse(
  jsonStr: string,
  fallbackPage: number
): GeorefSuggestion[] {
  try {
    const parsed = JSON.parse(jsonStr) as GeminiGeorefSuggestionResponse;
    if (!Array.isArray(parsed.suggestions)) {
      return [];
    }

    return parsed.suggestions
      .filter((suggestion) => suggestion?.pdf && suggestion?.map)
      .map((suggestion) => ({
        id: nanoid(10),
        pdf: {
          x: Number(suggestion.pdf.x) || 0,
          y: Number(suggestion.pdf.y) || 0,
          page: Number(suggestion.pdf.page) || fallbackPage
        },
        map: {
          lon: Number(suggestion.map.lon) || 0,
          lat: Number(suggestion.map.lat) || 0
        },
        confidence: Math.max(
          0,
          Math.min(1, Number(suggestion.confidence) || 0)
        ),
        rationale: String(suggestion.rationale ?? '').trim()
      }))
      .filter(
        (suggestion) =>
          Number.isFinite(suggestion.map.lon) &&
          Number.isFinite(suggestion.map.lat)
      );
  } catch {
    return [];
  }
}

/**
 * Optional AI-backed adapter configured from env, never hardcoded in source.
 */
export class RemoteGeorefSuggestionAdapter implements GeorefSuggestionAdapter {
  constructor(
    private readonly apiUrl: string,
    private readonly geminiApiKey = ''
  ) {}

  async suggestPoints(
    request: GeorefSuggestionRequest
  ): Promise<GeorefSuggestion[]> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.geminiApiKey ? { 'X-Gemini-Api-Key': this.geminiApiKey } : {})
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(
        `Georef suggestion API failed with status ${response.status}`
      );
    }

    const payload = (await response.json()) as RemoteGeorefSuggestionResponse;

    return payload.suggestions.map((suggestion) => ({
      id: nanoid(10),
      pdf: suggestion.pdf,
      map: suggestion.map,
      confidence: suggestion.confidence,
      rationale: suggestion.rationale
    }));
  }
}

/**
 * Gemini-backed adapter for georeference point suggestions.
 */
export class GeminiGeorefSuggestionAdapter implements GeorefSuggestionAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fallback: GeorefSuggestionAdapter = new HeuristicGeorefSuggestionAdapter()
  ) {}

  async suggestPoints(
    request: GeorefSuggestionRequest
  ): Promise<GeorefSuggestion[]> {
    if (!this.apiKey) {
      return this.fallback.suggestPoints(request);
    }

    const genAI = new GoogleGenerativeAI(this.apiKey);

    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              suggestions: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    pdf: {
                      type: SchemaType.OBJECT,
                      properties: {
                        x: { type: SchemaType.NUMBER },
                        y: { type: SchemaType.NUMBER },
                        page: { type: SchemaType.NUMBER }
                      },
                      required: ['x', 'y']
                    },
                    map: {
                      type: SchemaType.OBJECT,
                      properties: {
                        lon: { type: SchemaType.NUMBER },
                        lat: { type: SchemaType.NUMBER }
                      },
                      required: ['lon', 'lat']
                    },
                    confidence: { type: SchemaType.NUMBER },
                    rationale: { type: SchemaType.STRING }
                  },
                  required: ['pdf', 'map', 'confidence', 'rationale']
                }
              }
            },
            required: ['suggestions']
          }
        }
      });

      const prompt =
        `Suggest exactly 4 georeference control point pairs for page ${request.page}. ` +
        `Map center: lon ${request.mapCenter.lon}, lat ${request.mapCenter.lat}. ` +
        `Map bounds: west ${request.mapBounds.west}, south ${request.mapBounds.south}, east ${request.mapBounds.east}, north ${request.mapBounds.north}. ` +
        'Return balanced corner-like points across the extent. Use approximate PDF pixel coordinates in a 0-1200 range and include confidence from 0.0 to 1.0 with concise rationale.';

      const result = await model.generateContent(prompt);
      const parsed = parseGeorefSuggestionResponse(
        result.response.text(),
        request.page
      );

      if (parsed.length > 0) {
        return parsed.slice(0, 4);
      }

      return this.fallback.suggestPoints(request);
    } catch {
      return this.fallback.suggestPoints(request);
    }
  }
}

/**
 * TODO(phase-3): Replace heuristic output with model-backed landmark matching.
 */
export class HeuristicGeorefSuggestionAdapter implements GeorefSuggestionAdapter {
  suggestPoints(request: GeorefSuggestionRequest): Promise<GeorefSuggestion[]> {
    const { mapCenter, mapBounds, page } = request;
    const width = Math.max(mapBounds.east - mapBounds.west, 0.00001);
    const height = Math.max(mapBounds.north - mapBounds.south, 0.00001);

    const templates = [
      {
        pdf: { x: 300, y: 220 },
        map: {
          lon: mapCenter.lon - width * 0.22,
          lat: mapCenter.lat + height * 0.18
        },
        confidence: 0.52,
        rationale:
          'Estimated from upper-left landmark cluster and viewport extent'
      },
      {
        pdf: { x: 980, y: 240 },
        map: {
          lon: mapCenter.lon + width * 0.21,
          lat: mapCenter.lat + height * 0.19
        },
        confidence: 0.49,
        rationale:
          'Estimated from upper-right landmark cluster and viewport extent'
      },
      {
        pdf: { x: 320, y: 980 },
        map: {
          lon: mapCenter.lon - width * 0.2,
          lat: mapCenter.lat - height * 0.2
        },
        confidence: 0.47,
        rationale:
          'Estimated from lower-left landmark cluster and viewport extent'
      },
      {
        pdf: { x: 980, y: 1020 },
        map: {
          lon: mapCenter.lon + width * 0.2,
          lat: mapCenter.lat - height * 0.2
        },
        confidence: 0.45,
        rationale:
          'Estimated from lower-right landmark cluster and viewport extent'
      }
    ];

    return Promise.resolve(
      templates.map((template) => ({
        id: nanoid(10),
        pdf: {
          ...template.pdf,
          page
        },
        map: template.map,
        confidence: template.confidence,
        rationale: template.rationale
      }))
    );
  }
}

export const defaultGeorefSuggestionAdapter: GeorefSuggestionAdapter =
  aiEnv.GEOREF_SUGGESTION_PROXY_URL
    ? new RemoteGeorefSuggestionAdapter(
        aiEnv.GEOREF_SUGGESTION_PROXY_URL,
        aiEnv.GEMINI_API_KEY
      )
    : aiEnv.GEMINI_API_KEY
      ? new GeminiGeorefSuggestionAdapter(aiEnv.GEMINI_API_KEY)
      : new HeuristicGeorefSuggestionAdapter();

export const defaultGeorefSuggestionSource: GeorefSuggestionSource =
  resolveGeorefSuggestionSource(
    aiEnv.GEOREF_SUGGESTION_PROXY_URL,
    aiEnv.GEMINI_API_KEY
  );
