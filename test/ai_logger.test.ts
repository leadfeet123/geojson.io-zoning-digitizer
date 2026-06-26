import { logAiError } from 'app/lib/ai_logger';
import { describe, expect, it, vi } from 'vitest';

describe('ai_logger', () => {
  it('redacts Gemini API key patterns from error messages', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logAiError(
      'test',
      new Error('Failed with key=FAKE_GEMINI_KEY_FOR_TEST_ONLY_NOT_REAL')
    );

    expect(spy).toHaveBeenCalledOnce();
    const [prefix, message] = spy.mock.calls[0];
    expect(prefix).toBe('[AI:test]');
    expect(message).not.toContain('FAKE_GEMINI_KEY_FOR_TEST_ONLY');
    expect(message).toContain('[redacted');

    spy.mockRestore();
  });

  it('redacts Bearer tokens', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logAiError(
      'ocr',
      new Error('Unauthorized: Bearer eyJhbGciOiJSUzI1NiJ9.abc')
    );

    const [, message] = spy.mock.calls[0];
    expect(message).not.toContain('eyJhbGci');
    expect(message).toContain('[redacted]');

    spy.mockRestore();
  });

  it('passes through non-sensitive error messages unchanged', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logAiError('georef', new Error('Network request failed: timeout'));

    const [, message] = spy.mock.calls[0];
    expect(message).toBe('Network request failed: timeout');

    spy.mockRestore();
  });

  it('handles non-Error values safely', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logAiError('classification', 'plain string error');

    const [prefix] = spy.mock.calls[0];
    expect(prefix).toBe('[AI:classification]');

    spy.mockRestore();
  });
});
