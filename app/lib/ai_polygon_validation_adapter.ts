import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { aiEnv } from 'app/lib/env_ai';
import { logAiError } from 'app/lib/ai_logger';

const GEMINI_TIMEOUT_MS = 15_000;

export interface PolygonValidationResult {
  isValid: boolean;
  confidence: number;
  reason: string;
}

export interface PolygonValidationRequest {
  imageBytes: Uint8Array;
  mimeType: string;
}

export interface AiPolygonValidationAdapter {
  validatePolygon(
    request: PolygonValidationRequest
  ): Promise<PolygonValidationResult>;
}

export class LookupPolygonValidationAdapter implements AiPolygonValidationAdapter {
  validatePolygon(
    request: PolygonValidationRequest
  ): Promise<PolygonValidationResult> {
    // Deterministic fallback: assume valid if no AI available
    return Promise.resolve({
      isValid: true,
      confidence: 1.0,
      reason: 'AI validation unavailable. Assuming valid by default.'
    });
  }
}

export class GeminiPolygonValidationAdapter implements AiPolygonValidationAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fallback: AiPolygonValidationAdapter = new LookupPolygonValidationAdapter()
  ) {}

  async validatePolygon(
    request: PolygonValidationRequest
  ): Promise<PolygonValidationResult> {
    if (!this.apiKey) {
      return this.fallback.validatePolygon(request);
    }

    const genAI = new GoogleGenerativeAI(this.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-pro',
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              isValid: { type: SchemaType.BOOLEAN },
              confidence: { type: SchemaType.NUMBER },
              reason: { type: SchemaType.STRING }
            },
            required: ['isValid', 'confidence', 'reason']
          }
        }
      });

      const prompt =
        'Analyze this image crop containing a detected shape from a zoning map. Does this shape look like a clear, meaningful zoning area (like a parcel, block, or district), or is it an extraction artifact? Reject slivers, very jagged kink fragments, text outlines, and single lines. Return isValid as true or false, confidence between 0.0 and 1.0, and a concise reason.';

      const base64Image = Buffer.from(request.imageBytes).toString('base64');

      const imagePart = {
        inlineData: {
          data: base64Image,
          mimeType: request.mimeType
        }
      };

      const result = await model.generateContent([prompt, imagePart]);
      const text = result.response.text();

      try {
        const parsed = JSON.parse(text) as PolygonValidationResult;
        return {
          isValid: Boolean(parsed.isValid),
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
          reason: String(parsed.reason ?? '').trim()
        };
      } catch (e) {
        logAiError('polygon_validation_parse', e);
        return this.fallback.validatePolygon(request);
      }
    } catch (error) {
      logAiError('polygon_validation', error);
      return this.fallback.validatePolygon(request);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const defaultPolygonValidationAdapter: AiPolygonValidationAdapter =
  new GeminiPolygonValidationAdapter(aiEnv.GEMINI_API_KEY);
