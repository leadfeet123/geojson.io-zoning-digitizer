# AI Features Checklist

This checklist tracks practical Gemini-enabled features for the zoning digitizer.

## 1. Planning Class Suggestions (No.1)

- [x] Add Gemini-backed planning class adapter with lookup fallback
- [x] Add "Suggest Planning Class" action and apply flow in digitizer feature editor
- [x] Add unit tests for parser and fallback behavior
- [x] Wire digitizer feature editor into active digitizer UI
- [x] Add explicit accept/reject persistence controls for suggestions
- [ ] Add municipality context input for improved classification quality
- [ ] Add integration test for suggest -> apply workflow

## 2. Georeference AI Suggestions (No.2)

- [x] Add Gemini-backed georeference suggestion adapter with heuristic fallback
- [x] Add parser normalization/clamping for model responses
- [x] Add unit tests for parser and fallback behavior
- [ ] Add UI source badges (Gemini/Proxy/Heuristic)
- [ ] Add retry/fallback messaging in control point panel
- [ ] Add confidence ordering and low-confidence visual warning
- [ ] Add integration test for adapter selection order

## 3. Human-in-the-Loop Controls (No.3)

- [ ] Add explicit accept/reject/override controls for AI suggestions
- [ ] Record per-suggestion decision history on feature properties
- [ ] Ensure no AI operation auto-sets human_confirmed=true
- [ ] Add tests proving explicit human action is required

## 4. Low-Confidence Guardrails (No.4)

- [ ] Flag confidence < 0.5 suggestions in editor UI
- [ ] Block export for low-confidence, unconfirmed features with clear errors
- [ ] Add quick navigation from export errors to affected features
- [ ] Add tests for block/unblock export paths

## 5. Cross-Cutting Quality

- [ ] Add timeout/cancellation states for AI requests
- [ ] Add safe error logging without secrets
- [ ] Update README docs for AI behavior and fallback paths
- [ ] Run full test suite and build validation after each feature batch
