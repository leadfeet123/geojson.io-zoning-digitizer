import {
  recordSuggestionDecision,
  hasAutoConfirmedSuggestion
} from 'app/lib/ai_suggestion_helpers';
import type { AiSuggestion } from 'types/digitizer';
import { describe, expect, it } from 'vitest';

function baseSuggestion(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  return {
    field: 'planning_class',
    value: 'Commercial',
    confidence: 0.8,
    accepted: null,
    ...overrides
  };
}

describe('ai_suggestion_helpers', () => {
  it('records an accepted decision in history without setting human_confirmed', () => {
    const suggestion = baseSuggestion({ accepted: true });
    const result = recordSuggestionDecision(suggestion, 'accepted');

    expect(result.accepted).toBe(true);
    expect(result.decision_history).toHaveLength(1);
    expect(result.decision_history![0].action).toBe('accepted');
    expect(typeof result.decision_history![0].timestamp).toBe('string');
  });

  it('records a rejected decision and appends to existing history', () => {
    const suggestion = baseSuggestion({
      accepted: true,
      decision_history: [
        { action: 'accepted', timestamp: '2026-01-01T00:00:00.000Z' }
      ]
    });
    const result = recordSuggestionDecision(
      { ...suggestion, accepted: false },
      'rejected'
    );

    expect(result.accepted).toBe(false);
    expect(result.decision_history).toHaveLength(2);
    expect(result.decision_history![1].action).toBe('rejected');
  });

  it('records an overridden decision', () => {
    const suggestion = baseSuggestion({ accepted: false });
    const result = recordSuggestionDecision(suggestion, 'overridden');

    expect(result.decision_history).toHaveLength(1);
    expect(result.decision_history![0].action).toBe('overridden');
  });

  it('does not mutate the input suggestion', () => {
    const suggestion = baseSuggestion();
    recordSuggestionDecision(suggestion, 'accepted');
    expect(suggestion.decision_history).toBeUndefined();
  });

  // Step 3.3: no AI operation auto-sets human_confirmed
  it('hasAutoConfirmedSuggestion returns false when accepted has matching history', () => {
    const suggestions: AiSuggestion[] = [
      {
        field: 'planning_class',
        value: 'Residential',
        confidence: 0.7,
        accepted: true,
        decision_history: [
          { action: 'accepted', timestamp: '2026-01-01T00:00:00.000Z' }
        ]
      }
    ];
    expect(hasAutoConfirmedSuggestion(suggestions)).toBe(false);
  });

  it('hasAutoConfirmedSuggestion returns true when accepted is set without history', () => {
    const suggestions: AiSuggestion[] = [
      {
        field: 'planning_class',
        value: 'Residential',
        confidence: 0.7,
        accepted: true
        // no decision_history — auto-confirmed without user action
      }
    ];
    expect(hasAutoConfirmedSuggestion(suggestions)).toBe(true);
  });

  it('hasAutoConfirmedSuggestion returns false when all accepted are null or false', () => {
    const suggestions: AiSuggestion[] = [
      baseSuggestion({ accepted: null }),
      baseSuggestion({ accepted: false })
    ];
    expect(hasAutoConfirmedSuggestion(suggestions)).toBe(false);
  });
});
