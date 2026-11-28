import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { aiEnv } from 'app/lib/env_ai';
import { logAiError } from 'app/lib/ai_logger';

const GEMINI_TIMEOUT_MS = 15_000;

/** Outcome of AI visual validation for an extracted candidate zoning polygon. */
export interface PolygonValidationResult {
  isValid: boolean;
  confidence: number;
  reason: string;
}

/** Image crop payload sent to the polygon validation adapter. */
export interface PolygonValidationRequest {
  imageBytes: Uint8Array;
  mimeType: string;
}

/** Adapter contract for validating ambiguous or repaired polygon candidates. */
export interface AiPolygonValidationAdapter {
  validatePolygon(
    request: PolygonValidationRequest
  ): Promise<PolygonValidationResult>;
}

/** Deterministic offline fallback adapter when no remote AI key is configured. */
export class LookupPolygonValidationAdapter implements AiPolygonValidationAdapter {
  validatePolygon(
    _request: PolygonValidationRequest
  ): Promise<PolygonValidationResult> {
    // Deterministic fallback: assume valid if no AI available
    return Promise.resolve({
      isValid: true,
      confidence: 0.75,
      reason: 'AI validation unavailable. Keeping candidate for human review.'
    });
  }
}

/** Gemini Vision adapter evaluating highlighted candidate zoning outlines in context. */
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
        model: aiEnv.GEMINI_MODEL,
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
        'Analyze this zoning map crop. A candidate polygon is highlighted with a bright cyan (#00FFFF) outline. Determine whether the cyan outline bounds a real colored zoning parcel, lot, corridor, or district (isValid: true), or whether it is purely a non-zoning artifact such as a stray border line, text glyph outline, scale bar, or microscopic kink sliver (isValid: false). Valid zoning parcels can be small lots or elongated road corridors. Return isValid, confidence between 0.0 and 1.0, and a concise reason.';

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
