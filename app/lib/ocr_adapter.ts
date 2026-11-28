import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { aiEnv } from 'app/lib/env_ai';
import { logAiError } from 'app/lib/ai_logger';

const GEMINI_TIMEOUT_MS = 20_000;

/** Single zoning entry extracted from a map legend. */
export interface LegendItem {
  color: string;
  code: string;
  description: string;
  /** Optional normalized [ymin, xmin, ymax, xmax] (0-1000) bounding box of the color swatch in the legend image. */
  swatch_box?: [number, number, number, number] | null;
}

/** Structured legend extraction output including zones and parcel boundary line color. */
export interface LegendResult {
  zones: LegendItem[];
  boundary_line: string | null;
}

/**
 * Interface for OCR extraction services.
 */
export interface OcrAdapter {
  extractLegend(base64Image: string): Promise<LegendResult | null>;
}

/**
 * Parses raw JSON string returned by the OCR legend service into a LegendResult.
 */
export function parseLegendResponse(jsonStr: string): LegendResult | null {
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed as LegendResult;
  } catch (error) {
    console.error('Failed to parse legend response JSON:', error);
    return null;
  }
}

/**
 * Gemini-based OCR Adapter for extracting structured legend rules.
 */
export class GeminiOcrAdapter implements OcrAdapter {
  async extractLegend(base64Image: string): Promise<LegendResult | null> {
    const apiKey = aiEnv.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('VITE_GEMINI_API_KEY is not set. Returning null legend.');
      return null;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    // The base64Image comes as a data URL (e.g., 'data:image/png;base64,...')
    // We need to strip the prefix for the API.
    const parts = base64Image.split(',');
    const mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
    const base64Data = parts[1];

    try {
      const model = genAI.getGenerativeModel({
        model: aiEnv.GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              zones: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    color: { type: SchemaType.STRING },
                    code: { type: SchemaType.STRING },
                    description: { type: SchemaType.STRING },
                    swatch_box: {
                      type: SchemaType.ARRAY,
                      nullable: true,
                      items: { type: SchemaType.NUMBER }
                    }
                  },
                  required: ['color', 'code', 'description']
                }
              },
              boundary_line: {
                type: SchemaType.STRING,
                nullable: true
              }
            },
            required: ['zones', 'boundary_line']
          }
        }
      });

      const imagePart = {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      };

      const prompt =
        "Analyze this zoning legend. Return a strict JSON object with two keys: 'zones' and 'boundary_line'. The 'zones' key must be an array of objects, where each object contains 'color' (hex code of the zone fill, e.g., #F4A460), 'code' (the short zoning code, e.g., R-1 or C-2), 'description' (the full name of the zone), and 'swatch_box' (normalized [ymin, xmin, ymax, xmax] coordinates from 0 to 1000 tightly bounding ONLY the colored swatch rectangle for that row). Exclude non-zoning symbols such as city limits, roads, streams, or railroads. The 'boundary_line' key must contain the hex color of lines separating parcels/lots, or null if not shown.";

      const result = await model.generateContent([prompt, imagePart]);
      const response = result.response;
      const text = response.text();

      if (!text) {
        return null;
      }

      const jsonStr = text
        .replace(/^```json/m, '')
        .replace(/^```/m, '')
        .trim();

      return parseLegendResponse(jsonStr);
    } catch (error) {
      logAiError('ocr', error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Export a singleton instance
export const ocrAdapter = new GeminiOcrAdapter();
