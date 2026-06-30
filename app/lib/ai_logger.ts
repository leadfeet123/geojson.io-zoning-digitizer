/**
 * Safe AI error logger that strips potential secret values from error messages
 * before writing to the console. Never logs the Gemini API key.
 */
export function logAiError(context: string, error: unknown): void {
  const raw = error instanceof Error ? error.message : String(error);

  const sanitized = raw
    .replace(/key[=:\s]+[A-Za-z0-9_-]{8,}/gi, 'key=[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{35}/g, '[redacted-api-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');

  console.error(`[AI:${context}]`, sanitized);
}
