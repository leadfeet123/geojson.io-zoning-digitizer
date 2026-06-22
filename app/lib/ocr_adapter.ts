import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

export interface LegendItem {
  color: string;
  code: string;
  description: string;
}

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
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('VITE_GEMINI_API_KEY is not set. Returning null legend.');
      return null;
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // The base64Image comes as a data URL (e.g., 'data:image/jpeg;base64,...')
    // We need to strip the prefix for the API.
    const parts = base64Image.split(',');
    const mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const base64Data = parts[1];

    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
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
                    description: { type: SchemaType.STRING }
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

      const prompt = "Analyze this zoning legend. Return a strict JSON object with two keys: 'zones' and 'boundary_line'. The 'zones' key must be an array of objects, where each object contains 'color' (the exact hex code of the zone), 'code' (the short zoning code, e.g., C-1), and 'description' (the full name of the zone). The 'boundary_line' key must contain the exact hex color of the lines used to separate parcels, lots, or properties. If no specific boundary line color is explicitly defined in the legend, return null for 'boundary_line'.";

      const result = await model.generateContent([prompt, imagePart]);
      const response = result.response;
      const text = response.text();

      if (!text) {
        return null;
      }

      const jsonStr = text.replace(/^```json/m, '').replace(/^```/m, '').trim();

      return parseLegendResponse(jsonStr);
    } catch (error) {
      console.error('Error extracting legend with Gemini:', error);
      return null;
    }
  }
}

// Export a singleton instance
export const ocrAdapter = new GeminiOcrAdapter();
