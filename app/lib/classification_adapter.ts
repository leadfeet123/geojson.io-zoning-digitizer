import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { aiEnv } from 'app/lib/env_ai';
import { logAiError } from 'app/lib/ai_logger';

const GEMINI_TIMEOUT_MS = 15_000;

export interface ClassificationSuggestion {
  planning_class: string;
  confidence: number;
  rationale: string;
}

export interface ClassificationSuggestionRequest {
  rawZoningLabel: string;
  municipality?: string;
}

export interface ClassificationAdapter {
  suggestPlanningClass(
    request: ClassificationSuggestionRequest
  ): Promise<ClassificationSuggestion[]>;
}

interface ClassificationResponse {
  suggestions: ClassificationSuggestion[];
}

/**
 * Parses model output and normalizes confidence values.
 */
export function parseClassificationResponse(
  jsonStr: string
): ClassificationSuggestion[] {
  try {
    const parsed = JSON.parse(jsonStr) as ClassificationResponse;
    if (!Array.isArray(parsed.suggestions)) {
      return [];
    }

    return parsed.suggestions
      .filter((item) => item && typeof item.planning_class === 'string')
      .map((item) => ({
        planning_class: item.planning_class.trim(),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        rationale: String(item.rationale ?? '').trim()
      }))
      .filter((item) => item.planning_class.length > 0);
  } catch {
    return [];
  }
}

/**
 * Lightweight deterministic fallback used when Gemini is unavailable.
 */
export class LookupClassificationAdapter implements ClassificationAdapter {
  suggestPlanningClass(
    request: ClassificationSuggestionRequest
  ): Promise<ClassificationSuggestion[]> {
    const label = request.rawZoningLabel.trim().toUpperCase();
    if (!label) {
      return Promise.resolve([]);
    }

    const table: Array<{
      pattern: RegExp;
      planning_class: string;
      confidence: number;
      rationale: string;
    }> = [
      {
        pattern: /^(R|RM|RES)/,
        planning_class: 'Residential',
        confidence: 0.62,
        rationale: 'Lookup mapping from residential zoning prefixes'
      },
      {
        pattern: /^(C|CN|CC|CG|COMM)/,
        planning_class: 'Commercial',
        confidence: 0.62,
        rationale: 'Lookup mapping from commercial zoning prefixes'
      },
      {
        pattern: /^(I|M|IND)/,
        planning_class: 'Industrial',
        confidence: 0.62,
        rationale: 'Lookup mapping from industrial/manufacturing prefixes'
      },
      {
        pattern: /^(A|AG|AGR)/,
        planning_class: 'Agricultural',
        confidence: 0.62,
        rationale: 'Lookup mapping from agricultural zoning prefixes'
      },
      {
        pattern: /^(MU|MXD|PUD|PD)/,
        planning_class: 'Mixed Use',
        confidence: 0.58,
        rationale: 'Lookup mapping from mixed-use/planned development prefixes'
      }
    ];

    const match = table.find((entry) => entry.pattern.test(label));
    return Promise.resolve(
      match
        ? [
            {
              planning_class: match.planning_class,
              confidence: match.confidence,
              rationale: match.rationale
            }
          ]
        : []
    );
  }
}

/**
 * Gemini-backed classifier with deterministic lookup fallback.
 */
export class GeminiClassificationAdapter implements ClassificationAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fallback: ClassificationAdapter = new LookupClassificationAdapter()
  ) {}

  async suggestPlanningClass(
    request: ClassificationSuggestionRequest
  ): Promise<ClassificationSuggestion[]> {
    if (!request.rawZoningLabel.trim()) {
      return [];
    }

    if (!this.apiKey) {
      return this.fallback.suggestPlanningClass(request);
    }

    const genAI = new GoogleGenerativeAI(this.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-3.5-flash',
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
                    planning_class: { type: SchemaType.STRING },
                    confidence: { type: SchemaType.NUMBER },
                    rationale: { type: SchemaType.STRING }
                  },
                  required: ['planning_class', 'confidence', 'rationale']
                }
              }
            },
            required: ['suggestions']
          }
        }
      });

      const municipalityContext = request.municipality
        ? `Municipality context: ${request.municipality}.`
        : 'Municipality context: unknown.';

      const prompt =
        `Given raw zoning label "${request.rawZoningLabel}", suggest up to 3 planning classes. ` +
        `${municipalityContext} Return confidence as numbers between 0.0 and 1.0 and include concise rationale per suggestion.`;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = parseClassificationResponse(text);

      if (parsed.length > 0) {
        return parsed;
      }

      return this.fallback.suggestPlanningClass(request);
    } catch (error) {
      logAiError('classification', error);
      return this.fallback.suggestPlanningClass(request);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const defaultClassificationAdapter: ClassificationAdapter =
  new GeminiClassificationAdapter(aiEnv.GEMINI_API_KEY);
