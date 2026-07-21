/**
 * Centralised AI environment config.
 *
 * VITE_GEMINI_MODEL defaults to gemini-3.5-flash — the most capable current
 * stable multimodal model. All AI features that send images (OCR, georef
 * landmark detection, polygon validation) require a multimodal model that
 * accepts inlineData image parts. gemini-3.5-flash satisfies this and gives
 * the best visual understanding for dense zoning maps.
 *
 * Stable model options (as of 2026-07), all support multimodal input:
 *   gemini-3.5-flash       — most intelligent, best for map reading (default)
 *   gemini-3.6-flash       — latest stable, strong agentic + multimodal
 *   gemini-2.5-flash       — best price/performance if cost is a concern
 *   gemini-2.5-flash-lite  — fastest / cheapest if accuracy is less critical
 *
 * Avoid: gemini-2.0-flash (shut down), gemini-1.5-pro* (removed from v1beta)
 */
export const aiEnv = {
  GEOREF_SUGGESTION_PROXY_URL:
    import.meta.env.VITE_GEOREF_SUGGESTION_PROXY_URL ?? '',
  GEMINI_API_KEY: import.meta.env.VITE_GEMINI_API_KEY ?? '',
  GEMINI_MODEL: import.meta.env.VITE_GEMINI_MODEL || 'gemini-3.5-flash'
};
