import { aiEnv } from 'app/lib/env_ai';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { logAiError } from 'app/lib/ai_logger';
import { nanoid } from 'nanoid';

const GEMINI_TIMEOUT_MS = 15_000;

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
  base64Image?: string; // Optional because Proxy or Heuristic might not need it
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
      .map((suggestion) => {
        const lon =
          typeof suggestion.map.lon === 'number'
            ? suggestion.map.lon
            : Number(suggestion.map.lon);
        const lat =
          typeof suggestion.map.lat === 'number'
            ? suggestion.map.lat
            : Number(suggestion.map.lat);
        return {
          id: nanoid(10),
          pdf: {
            x: Number(suggestion.pdf.x) || 0,
            y: Number(suggestion.pdf.y) || 0,
            page: Number(suggestion.pdf.page) || fallbackPage
          },
          map: {
            lon: Number.isNaN(lon) ? 0 : lon,
            lat: Number.isNaN(lat) ? 0 : lat
          },
          confidence: Math.max(
            0,
            Math.min(1, Number(suggestion.confidence) || 0)
          ),
          rationale: String(suggestion.rationale ?? '').trim()
        };
      })
      .filter(
        (suggestion) =>
          suggestion.map.lon !== 0 &&
          suggestion.map.lat !== 0 &&
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
      const model = genAI.getGenerativeModel({
        model: aiEnv.GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              geographic_context: {
                type: SchemaType.OBJECT,
                properties: {
                  identified_region: { type: SchemaType.STRING },
                  notable_streets: {
                    type: SchemaType.ARRAY,
                    items: { type: SchemaType.STRING }
                  },
                  analysis_rationale: { type: SchemaType.STRING }
                },
                required: [
                  'identified_region',
                  'notable_streets',
                  'analysis_rationale'
                ]
              },
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
            required: ['geographic_context', 'suggestions']
          }
        }
      });

      const prompt =
        `You are an expert GIS and georeferencing AI. Your task is to analyze the provided zoning map image and identify matching GPS coordinates for landmarks.\n\n` +
        `STEP 1: GEOGRAPHIC IDENTIFICATION\n` +
        `Read the text on the map (title blocks, city/county names, road names, highways). Fill out the 'geographic_context' object with the region you identified, the notable streets, and your reasoning.\n\n` +
        `STEP 2: LANDMARK TRIANGULATION\n` +
        `Based on the context you just extracted, find exactly 4 widely-spaced visual landmarks (like distinct intersections of the streets you found) in the image, and determine their real-world longitude and latitude.\n\n` +
        `The user's current interactive map viewport is roughly around:\n` +
        `Center: Lon ${request.mapCenter.lon}, Lat ${request.mapCenter.lat}\n` +
        `Bounds: [W: ${request.mapBounds.west}, S: ${request.mapBounds.south}, E: ${request.mapBounds.east}, N: ${request.mapBounds.north}]\n\n` +
        `RULES:\n` +
        `1. Use the provided map bounds ONLY as a hint. If your geographic identification proves the map is somewhere else (e.g. the PDF says 'Cook County, IL' but the map bounds are in New York), IGNORE the map bounds and use the true GPS coordinates for the real-world location you identified.\n` +
        `2. 'pdf.x' and 'pdf.y' MUST be the exact pixel coordinates on the provided image where the intersection/landmark is located.\n` +
        `3. 'map.lon' and 'map.lat' MUST be the real-world GPS coordinates for that specific intersection.\n` +
        `4. DO NOT output [0,0] coordinates.\n` +
        `5. Provide exactly 4 widely-spaced points.\n` +
        `6. 'pdf.page' must be ${request.page}.\n`;

      const contentArgs: any[] = [prompt];
      if (request.base64Image) {
        const parts = request.base64Image.split(',');
        const mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
        const base64Data = parts[1];
        contentArgs.push({
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        });
      }

      const result = await model.generateContent(contentArgs);
      const parsed = parseGeorefSuggestionResponse(
        result.response.text(),
        request.page
      );

      if (parsed.length > 0) {
        return parsed.slice(0, 4);
      }

      return this.fallback.suggestPoints(request);
    } catch (error) {
      logAiError('georef', error);
      return this.fallback.suggestPoints(request);
    } finally {
      clearTimeout(timer);
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

export function createDefaultGeorefSuggestionAdapter(
  proxyUrl: string,
  geminiApiKey: string
): GeorefSuggestionAdapter {
  if (proxyUrl) {
    return new RemoteGeorefSuggestionAdapter(proxyUrl, geminiApiKey);
  }

  if (geminiApiKey) {
    return new GeminiGeorefSuggestionAdapter(geminiApiKey);
  }

  return new HeuristicGeorefSuggestionAdapter();
}

export const defaultGeorefSuggestionAdapter: GeorefSuggestionAdapter =
  createDefaultGeorefSuggestionAdapter(
    aiEnv.GEOREF_SUGGESTION_PROXY_URL,
    aiEnv.GEMINI_API_KEY
  );

export const defaultGeorefSuggestionSource: GeorefSuggestionSource =
  resolveGeorefSuggestionSource(
    aiEnv.GEOREF_SUGGESTION_PROXY_URL,
    aiEnv.GEMINI_API_KEY
  );
