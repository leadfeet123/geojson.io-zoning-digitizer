import type { AiSuggestion, AiSuggestionDecision } from 'types/digitizer';

/**
 * Appends a decision to the history of a single AiSuggestion.
 * Never modifies human_confirmed — callers are responsible for that.
 */
export function recordSuggestionDecision(
  suggestion: AiSuggestion,
  action: AiSuggestionDecision['action']
): AiSuggestion {
  const entry: AiSuggestionDecision = {
    action,
    timestamp: new Date().toISOString()
  };

  return {
    ...suggestion,
    decision_history: [...(suggestion.decision_history ?? []), entry]
  };
}

/**
 * Returns true if the feature's AI suggestions have at least one accepted
 * entry set programmatically rather than by explicit user action.
 *
 * AGENTS.md rule: human_confirmed must only be set true by explicit user
 * action (button/checkbox/shortcut). This guard verifies no background code
 * set accepted=true without a corresponding decision_history entry.
 */
export function hasAutoConfirmedSuggestion(
  suggestions: AiSuggestion[]
): boolean {
  return suggestions.some(
    (suggestion) =>
      suggestion.accepted === true &&
      (suggestion.decision_history ?? []).filter(
        (entry) => entry.action === 'accepted'
      ).length === 0
  );
}
