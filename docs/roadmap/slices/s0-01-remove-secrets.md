# S0-01: Remove secrets from code and the browser

| | |
|---|---|
| Backlog | P5 (also touches items 34, E7 and F6) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0A |
| Branch | `s0-01-remove-secrets`, targeting `develop` |
| Change class | Infrastructure and host security fix. Layers: host (`src/`), CI and Bicep. No configuration schema change. |
| Size | S |
| Depends on | Nothing in code. P5 is only Completed after the manual key rotation. |
| Baseline | `fix/testing-fixes`, commit `a0a5534` |

## Blocking manual tasks (not for Claude Code)

1. Rotate the Ideal Postcodes key in the Ideal Postcodes account and revoke the old one. The old key is in git history from commit `b529056`.
2. Put the new key in Key Vault (secret `ideal-postcodes-api-key`) and in local `.env.local`. Do the same with the Anthropic key (`anthropic-api-key`) in every environment that uses AI extraction.
3. Turn on GitHub secret scanning and push protection for the repository.

Status at 6 November 2026:
- Step 1 is **deferred** by the product owner while in test, because the existing key has credits. The key is now in local `.env.local` as `IDEAL_POSTCODES_API_KEY`. It must be rotated before real client data, wider repository access, or stage 0 exit.
- Step 2 is done locally for the Anthropic key. Key Vault follows when an Azure environment exists.
- Step 3 is done.

The code can be built and merged before step 1. P5 moves to Completed only once the old key is revoked.

## What is wrong today

- `src/domain/addressLookup.ts:16-18` hard-codes an Ideal Postcodes key as a fallback. It also reads `NEXT_PUBLIC_IDEAL_POSTCODES_API_KEY`, which ships to the browser, and calls Ideal Postcodes directly from the browser with the key in the URL.
- `src/app/api/matters/extract/route.ts:2447` and `:2457` accept `apiKeyOverride` from the request body.
- `src/components/MatterFormClient.tsx` (around lines 2127–2150 and 5947–5995) offers a "Claude API Key" box and stores the key in browser storage (`onesquared_claude_api_key`). It sends the key with each request (line 2604).
- CI (`.github/workflows/ci.yml`) has no secret scanning. It also does not run on pushes to `s0-*` branches.

## Files

**Address lookup**
- `src/server/addressLookupService.ts` (new, `server-only`):
  - `searchAddresses(query)` and `resolveAddress(id)` call Ideal Postcodes using the server-side setting `process.env.IDEAL_POSTCODES_API_KEY` **only**. There is no `NEXT_PUBLIC_` variant and no fallback value in code.
  - An unset value, or an unresolved `@Microsoft.KeyVault(` reference, means "not configured".
  - Input is validated: the query must be 3 to 100 characters; the ID is restricted to the Ideal Postcodes ID character set.
  - It never logs the query or the address.
- `src/app/api/address-lookup/route.ts` (new):
  - `GET ?q=` returns suggestions, and `GET ?id=` returns a resolved address.
  - It returns 401 when not signed in, and 503 `{ code: 'NOT_CONFIGURED', message: "Address lookup isn't configured" }` when there is no key. The browser code already shows `data.message`, so the forms display that text (review finding AG7).
  - It uses `withAuthenticatedActor`, or `guardedRoute` with an `authenticated` policy if S0-02 has merged first (reason: public postcode data, no tenant data).
- `src/domain/addressLookup.ts`:
  - Delete `DEFAULT_API_KEY` and the `NEXT_PUBLIC_` read.
  - Both exported functions call `/api/address-lookup` and keep their signatures and browser caches. A 503 or `code: 'NOT_CONFIGURED'` maps to the error "Address lookup isn't configured".
  - `EnquiryFormClient.tsx` and `FormControls.tsx` need no changes.

**AI extraction**
- `src/app/api/matters/extract/route.ts`: remove `apiKeyOverride` from the body type and from the key resolution. Without a server key, return 503 with "AI extraction isn't configured. Ask your administrator."
- `src/components/MatterFormClient.tsx`:
  - Remove the key state, its handler, the "Claude API Key" button and the input.
  - Remove `apiKeyOverride` from the request.
  - On mount, call `localStorage.removeItem('onesquared_claude_api_key')` once, inside try/catch, so keys already saved in browsers are deleted.

**Configuration and infrastructure**
- `.env.example`: add `IDEAL_POSTCODES_API_KEY=""` and `ANTHROPIC_API_KEY=""`, with a note that deployed environments take them from Key Vault.
- `core/infra/main.bicep`: add `IDEAL_POSTCODES_API_KEY` and `ANTHROPIC_API_KEY` Key Vault references (secrets `ideal-postcodes-api-key` and `anthropic-api-key`), and list them in the operator-populated secrets comment. S0-13 carries these over to Container Apps (ADR 0024).

**CI**
- `.gitleaks.toml` (new):
  - extends the default rules
  - adds rule `ideal-postcodes-api-key` (`\bak_[A-Za-z0-9]{20,}\b`)
  - allow-lists invented test placeholders
- `.github/workflows/ci.yml`:
  - add `'s0-*'` to the push branches
  - add a "Secret scan" step before install, using a pinned gitleaks v8 release to run `gitleaks dir . --config .gitleaks.toml --redact`
- `scripts/verify-ci.mjs`: add the same step for local parity. If `gitleaks` is not on PATH, fail with install instructions (for example `winget install gitleaks`).
- `CLAUDE.md` and `AGENTS.md`, Commands section: mention the secret scan and its local prerequisite.

**Documentation**
- `src/docs/articles/deployment-and-security.ts`: list the Ideal Postcodes and Anthropic keys as Key Vault secrets, and state that no keys are sent to the browser.
- `docs/release-notes.md`: add an entry.
- `docs/roadmap/feature-list.md`:
  - P5: Partly built, or Completed once the rotation is confirmed.
  - Item 34: remove "Remove the hard-coded API key" from What's missing.
  - E7 and F6: drop the browser-supplied key from What's missing.

## Tests

- `src/server/__tests__/addressLookupRoute.test.ts`:
  - returns 401 without a session (`setTestEntraSessionOverride(undefined)`)
  - returns 503 with the "Address lookup isn't configured" message when the key is unset, or is an unresolved Key Vault reference, and `searchAddressSuggestions` surfaces that message
  - with the key set and `fetch` mocked, the outbound URL carries the server key and the response body contains no key
  - a query that is too short returns an empty list without calling `fetch`
- `core/tests/entra-auth.test.ts`: an extraction POST with `apiKeyOverride` and no server key returns 503, and `fetch` to `api.anthropic.com` is never called.
- `src/server/__tests__/noClientSecrets.test.ts`: scans `src/` and fails on any `NEXT_PUBLIC_` name containing KEY, SECRET or TOKEN, and on any `ak_` or `sk-ant-` literal.
- Two-tenant tests are not needed: this slice touches no tenant data. The PR description says so.

## Acceptance criteria

1. The tree contains no Ideal Postcodes key and no `NEXT_PUBLIC_*KEY` setting. After `npm run build`, searching `.next/static` for `ak_` finds nothing.
2. Address lookup works in the enquiry, person and organisation forms when the server key is set. Without it, the forms show "Address lookup isn't configured".
3. The AI extraction screen has no key box, any key saved in a browser is removed, and the route ignores keys sent from the browser.
4. CI runs on `s0-*` pushes and has a secret-scan step. A fake `ak_…` value planted in a scratch branch makes it fail.
5. `npm run ci` passes.
6. The old key has been revoked (manual; confirmed by the product owner). Deferred while in test; until then P5 stays Partly built.

## Pull request description must state

- **Change class:** infrastructure and host security fix.
- **Both hosting models:** the key comes from an environment variable populated from Key Vault in both models (the client's Key Vault in Model A, ours in Model B).
- **Migration and rollback:** no data migration. Roll back by reverting the PR; the rotated key stays valid.
- **Manual blockers:** the three tasks listed above.
