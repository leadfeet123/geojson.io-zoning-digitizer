import { GoogleGenerativeAI } from '@google/generative-ai';

export interface LegendItem {
  color: string;
  zone: string;
  code: string;
}

/**
 * Interface for OCR extraction services.
 */
export interface OcrAdapter {
  extractLegend(base64Image: string): Promise<LegendItem[]>;
}

/**
 * Gemini-based OCR Adapter for extracting structured legend rules.
 */
export class GeminiOcrAdapter implements OcrAdapter {
  async extractLegend(base64Image: string): Promise<LegendItem[]> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('VITE_GEMINI_API_KEY is not set. Returning empty legend.');
      return [];
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // The base64Image comes as a data URL (e.g., 'data:image/jpeg;base64,...')
    // We need to strip the prefix for the API.
    const parts = base64Image.split(',');
    const mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const base64Data = parts[1];

    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const imagePart = {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      };

      const prompt = 'Read this zoning legend. Return a strict JSON array linking every hex color to its exact zoning code and description (e.g., [{"color": "#E53E3E", "zone": "Commercial", "code": "C-1"}]).';

      const result = await model.generateContent([prompt, imagePart]);
      const response = result.response;
      const text = response.text();

      if (!text) {
        return [];
      }

      // Attempt to find the array in case Gemini returned markdown json blocks
      const jsonStr = text.replace(/^```json/m, '').replace(/^```/m, '').trim();

      return JSON.parse(jsonStr) as LegendItem[];
    } catch (error) {
      console.error('Error extracting legend with Gemini:', error);
      return [];
    }
  }
}

// Export a singleton instance
export const ocrAdapter = new GeminiOcrAdapter();
