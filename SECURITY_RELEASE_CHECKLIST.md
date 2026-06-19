# Security Release Checklist

Use this checklist before any production release.

## Secrets and Credentials

- [ ] Confirm no private key is present in any `VITE_*` variable.
- [ ] Confirm frontend config only uses `VITE_GEOREF_SUGGESTION_PROXY_URL` for AI georef suggestions.
- [ ] Confirm real AI provider key is stored only in server/proxy runtime secrets.
- [ ] Rotate AI provider key if the previous key may have been exposed.
- [ ] Revoke old/unused keys after rotation.

## Repository Hygiene

- [ ] Verify `.env` files are still git-ignored.
- [ ] Verify no secret values are committed in tracked files.
- [ ] Verify `.env.example` contains placeholders only.
- [ ] Review recent commits for accidental key leaks in code, docs, or logs.

## Runtime Hardening

- [ ] Set strict rate limits on the proxy endpoint.
- [ ] Restrict key usage by origin and/or IP where supported.
- [ ] Limit provider key scopes to minimum required permissions.
- [ ] Set usage quota and billing alerts for the provider account.
- [ ] Ensure proxy returns generic errors without leaking secret details.

## Monitoring and Response

- [ ] Check provider dashboard for unusual traffic spikes.
- [ ] Confirm logs/alerts are enabled for proxy auth failures and abuse patterns.
- [ ] Document incident response owner and escalation path.
- [ ] Confirm key rollback/rotation steps are documented and tested.

## Build and Deployment Verification

- [ ] Run `npm test` and verify tests pass.
- [ ] Run `npm run build` and verify build passes.
- [ ] Validate app behavior with AI proxy configured.
- [ ] Validate fallback heuristic behavior when proxy URL is unset.

## Sign-off

- [ ] Security checklist reviewed and approved for this release.
- [ ] Release date recorded.
- [ ] Reviewer name recorded.
