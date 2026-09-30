# VENUE-3 — the phase-3 venue gate

**Status:** COMPLETE. Merged `6a15131` (`--no-ff`; chain `8375f2d` r0 → `3625a66` r1, base `f43efe6`). HARDENING LOOP `wf_f4d0c85e-867`. The implementer was the `venue-verifier` (Opus); the verifier was a Fable adversarial-reviewer. CI: PR #26 run `36675617008`. The report is `docs/venue/verified-2026-09-30.md`.

## Reviews

### r1 on `8375f2d`: CHANGES REQUIRED
- [MEDIUM] V3-R1-01: The §14 source index omits four fetches the report relies on as evidence, so acceptance criterion 4 is not met.
- [LOW] V3-R1-02: The §W.1 diff table omits three files that did change between 983a10a7 and 0.11.0: packages/client/src/websockets/rtds.ts (+2 lines, 0 removed), packages/client/src/websockets/types.ts (+7, 0 removed) and packages/client/src/decorators/subscriptions.ts.
- [LOW] V3-R1-03: One documented CLOB reconciliation surface on an indexed page is neither recorded nor listed UNVERIFIED: GET https://clob.polymarket.com/balance-allowance/update (L2-signed with the five POLY_* headers, query asset_type=COLLATERAL|CONDITIONAL, token_id, signature_type), documented on S-D48 (trading/wallets-auth.md) under "Set Up Trading Approvals" > "Sync CLOB Allowances".
- [LOW] V3-R1-04: §0 says "Two fixtures are now stale or contested (§15)" while §15 lists three affected fixtures (fees stale, rtds deprecated source, restricted-modes contested), the README section says "three fixtures are affected", and the handoff known_risks 5 says three.

### r2 on `3625a66`: ACCEPT
- [LOW] V3-R2-01: The §W.1 "Root exports" row (docs/venue/verified-2026-09-30.md line 410) attributes `CommentParentEntityType` to head, but 0.11.0 itself added it.

## Implementer handoff r0 (structured return, verbatim)

### summary

VENUE-3 is done. The report is `/home/adriancova/proyects/tradeBot/polymarket-bot-venue-3/docs/venue/verified-2026-09-30.md`: the full phase-3 re-check of the twelve §1.2 items. Every fetch was on 2026-09-30 UTC.

VENUE-2's saved page bodies are still on this machine and their digests match its §14. So I compared every page byte-for-byte and again after stripping table formatting, because the docs site re-rendered every table since the last round.

**Verdicts:**
- **Unchanged (7):** order schemas on the guide page, order types, WebSocket schemas, heartbeat, per-market parameters, rate limits, and split/merge/redeem.
- **Drift (5):** SDK, fees, matching engine, geoblock, and RTDS.
- **Findings:** 17 drift rows (E-01 to E-17), six new conflicts (C-9 to C-14) and four new unverified items (U-18 to U-21).
- **Index:** 120 fetches, each with its SHA-256, plus 33 status probes that do not follow redirects.

**Findings that need action:**
1. **Reference prices now need credentials (E-09 to E-12, conflict C-13).** The Chainlink TWAP page is gone. Reference prices moved from the public RTDS feed to an authenticated service called PolyBolt (`wss://ws-live-v2.polymarket.com/ws`).
   - Only the 60-second TWAP remains; the 30-second window has no replacement. Prices are now decimal strings, not E18.
   - The old RTDS price topics are due for removal "one month after the `0.11.0` release". npm shows `0.11.0` published on 2026-09-23, so roughly 2026-10-23. That date is my arithmetic, not a venue statement.
   - The replacement requires CLOB API credentials, which the PAPER rules forbid. This needs a ruling from the user or orchestrator.
   - Nothing running today uses RTDS: the example configs don't enable it and the trader's reference venue is Binance.
2. **Data API v1 shuts down on 2026-10-24 (E-15).** WP-290 and WP-330 must use the `/v2` routes.
3. **SDK pin for WP-260 (E-01, E-02, §W.1).** Pin `@polymarket/client` at exactly `0.11.0`. That is npm's `latest`, and its npm build attestation names commit `d527956f47cf893849a25a6d2f7d5bee03d04965`.
   - Do not pin to the repository head `6842ffa4…` (2026-09-24): it includes changes that no release has shipped yet.
   - From `983a10a7` to `0.11.0`, none of the order, auth, user-WebSocket or signing files changed, and the release notes declare no breaking change.
   - §W.1 lists a five-step check to run when the dependency is added.
4. **The SDK has no order-heartbeat method (C-12, E-17).** The handoff says to wrap only the SDK and also to send order heartbeats, so this needs an ADR before WP-320.
5. **Cancel-only responses changed (E-05, C-9).** A 503 on order placement now reads `{"error": "trading is disabled"}` in both cancel-only and fully disabled modes. The docs say it doesn't tell you whether cancels still work. The API reference still shows the old wording.
6. **Batch-cancel limit conflict (C-11).** The API reference says 1,000 IDs per request; the guide says 3,000. Use 1,000 or fewer until resolved.
7. **Liquidity-rewards epoch (E-04).** An epoch is now one UTC day with up to 1,440 samples, not 10,080.
8. **Wave 3 surfaces.** All are covered in §W: authentication headers and key flows, order and cancel shapes, the user WebSocket, heartbeats, geoblock (read from the docs only), rate limits and restricted modes, pUSD and contract addresses, and reconciliation (including session-key visibility limits).
9. **Archived-SDK claim (C-4).** Still not reproduced; the quickstart and overview pages are byte-identical to last round and show only `@polymarket/client`.

No fixture payload was edited. The fixture README gained a dated section listing three affected fixtures. The four register rows got dated notes.

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-venue-3/docs/venue/verified-2026-09-30.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-venue-3/test/fixtures/venue/README.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-venue-3/docs/contracts/protected-contracts.md"
]

### tests_run

- `pnpm run lint` (with `pnpm_config_verify_deps_before_run=false`): passed.
- `pnpm ops:verify-venue`: passed, every check PASS.
- `npx vitest run --config test/vitest.config.ts apps/ops-cli/src/verify-venue`: 2 files, 375 tests passed.
- `git diff --name-only f43efe6`: shows exactly the three allowed paths.
- Every fetch used `curl -sS -L` with `sha256sum`, recorded in `fetchlog.tsv`. Status probes used `curl` without following redirects (`probelog.tsv`, `probelog-early.tsv`).
- Pages were compared byte-for-byte and after stripping table formatting (`norm.py`) against the surviving VENUE-2 bodies.
- SDK changes came from GitHub compare JSON (983a10a7→6842ffa4 and d527956f→6842ffa4) and file bodies at three commits.
- The npm build attestation was decoded to link `0.11.0` to its commit.
- All evidence is saved in the scratch directory and in `~/pmb-rounds/venue-3/`.

### assumptions

1. VENUE-2's surviving saved bodies are a valid byte-for-byte baseline, since their SHA-256 digests match its §14.
2. A difference that disappears once table formatting is stripped is not drift.
3. npm's package metadata plus its build attestation, which names the official `Polymarket/ts-sdk` repository and commit, is valid evidence for U-7, even though npm is not a Polymarket domain.
4. "One month after 0.11.0" means about 2026-10-23. That is my arithmetic from npm's publish date, not a venue statement (U-20).
5. Pages read for the first time this round (the CLOB API reference, wallets/auth, session keys, Data API v2) cannot drift. Where one contradicts another official page, I recorded a conflict and adopted neither.
6. Official docs and the official SDK control venue facts. Anything only the SDK says is listed as unverified.

### deviations

1. I added a Wave 3 section (§W) between §10 and §11 to cover the packet's item 2. Otherwise the numbering follows VENUE-2.
2. I did not fetch the PolyBolt API spec at `ws-live-v2.polymarket.com/asyncapi.json`: that domain is not on the allowed list. It is recorded as U-21.
3. I fetched SDK files at three commits (983a10a7, d527956f, 6842ffa4), not two, so the pin could be checked against the actual release. Files that neither GitHub compare lists as changed were fetched once, at head.
4. The first five status probes (05:14:56–05:14:58Z) were re-entered into `probelog-early.tsv` from the command output after the log file was truncated. The values are exactly as printed.

### known_risks

1. Every finding comes from documentation. I did not connect to RTDS, so I can't say whether it still publishes.
2. Stripping formatting could hide a whitespace-only change inside a code block. I treated those as non-semantic.
3. The SDK breaking-change check covers only the secure-client files listed in §W.1, not the whole package.
4. The old RTDS price topics could be removed before C-13 is ruled on. Any consumer would then lose reference prices.
5. `ops:verify-venue` still passes on three stale or contested fixtures, because the validator pins the 2026-08-24 snapshot and asserts the old cancel-only string word for word:
   - `fees` (`samples_per_epoch` 10080),
   - `restricted-modes` (the `http-503-cancel-only` example),
   - `rtds/twap-update`.
6. The recommended `0.11.0` pin lacks the `REDEEMABLE_LOST`/`MERGEABLE` position filters that the docs already describe; only the unreleased head has them.

### follow_up

1. **User/orchestrator:** rule on C-13 (the reference TWAP now needs CLOB credentials) before the old RTDS price topics are removed (~2026-10-23 by my arithmetic). Then the RTDS adapter, data-gateway, settlement ADR-009 §6 (the 30-second window) and the fixture owner act on E-09 to E-12.
2. **Orchestrator:** write an ADR for C-12 (sending order heartbeats when the SDK has no heartbeat method) before WP-320.
3. **WP-260:** pin `@polymarket/client@0.11.0` and run the §W.1 fresh check. Do not validate `signatureType` against the API reference's narrower list (C-10). Treat unknown error codes as UNKNOWN (U-4).
4. **WP-290 / WP-330:** use Data API `/v2` only (v1 shuts down 2026-10-24). An order missing from the open-orders list is not proof it was cancelled; resolve it by ID (E-14). A session key sees only its own orders and trades (E-16).
5. **WP-310 / WP-330:** detect modes by status and `code`, never by the error text. On a 425, honour `Retry-After` when present. Cap batch cancels at 1,000 or fewer (C-11). Retry only restart rejections (E-05 to E-07).
6. **Fixture owner and `apps/ops-cli`:** issue dated replacements for E-04, E-05 and E-09/E-10 once the validator accepts dated snapshots.
7. **Handoff owner:** the §24 SDK-migration and Chainlink TWAP links now redirect, and the §23 RTDS note is out of date.
8. **Orchestrator:** everything VENUE-2 §16.3 carried forward is still owed (C-2 amendment, U-11, `feeSchedule`, C-7, validator pins).
9. The phase-4 start gate needs its own report.

### commit_sha

8375f2d96c5884d4e3baf3fcae00405506f36f7c

## Implementer handoff r1 (structured return, verbatim)

### summary

VENUE-3 remediation round 1 adds one commit, 3625a66, on top of candidate 8375f2d. All four findings are fixed. Every change is in docs/venue/verified-2026-09-30.md.

| Finding | Severity | Fix | Pin |
| --- | --- | --- | --- |
| V3-R1-01 | MEDIUM | §14 now has rows for the four SDK fetches the report cites but had not indexed: actions/subscriptions.ts and websockets/rtds.ts at 983a10a7 and at head. It also has a row for a new fetch, S-S09: the github.com compare 983a10a7...d527956f.diff (HTTP 200, 136 566 bytes, SHA-256 c161b97d...8112). §14 now has 125 rows, one for each fetch log entry. The fetch window and the §13 domain list are updated to include this fetch. | PIN-V3R1-01 |
| V3-R1-02 | LOW | The §W.1 table now accounts for all 39 files in the direct 0.11.0 release diff, with add/remove counts. This includes rtds.ts, types.ts, decorators/subscriptions.ts, the two index files, realtime/*, and a row for files that are not shipped. The 23 lines removed from actions/subscriptions.ts are shown to be moves, with head-line citations. The "no breaking change" conclusion is unchanged. | PIN-V3R1-02 |
| V3-R1-03 | LOW | §W.9 now records the documented L2-signed GET /balance-allowance/update cache sync (S-D48 lines 1186-1228), with its S-D24 rate limits and the S-D10 SecureClient note. §W.8 points to it. A new U-22 records that the read route and both response bodies are not documented (/balance-allowance appears only in the SDK). §16 carries this forward to WP-290 and WP-300. | PIN-V3R1-03 |
| V3-R1-04 | LOW | §0 now says "Three fixtures", which matches §15, the fixture README and the r0 handoff. | PIN-V3R1-04 |

No verdict, drift row, conflict or SDK pin recommendation changed. The pin recommendation is still @polymarket/client 0.11.0, provenance commit d527956f, with the same fresh check. The handoff is at /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/venue-3/handoff-r1.md, with a copy in ~/pmb-rounds/venue-3/. It contains the table mapping each finding to its fix and pin.

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-venue-3/docs/venue/verified-2026-09-30.md"
]

### tests_run

- **Pins** (script: scratchpad/venue-3/pins-r1.sh):
  - On 3625a66: all 4 pass, exit 0.
  - With docs/venue/verified-2026-09-30.md temporarily restored from 8375f2d: all 4 fail, exit 1. The failures were 5 unindexed fetch log rows, 10 source files missing from §W.1, no balance-allowance record and no U-22, and §0 saying "Two" where §15 lists 3.
  - Restoring the file back was checked with sha256sum -c against 5ecd9046...: OK.
- **pnpm run lint:** exit 0.
- **pnpm ops:verify-venue:** exit 0, 18 PASS, 0 FAIL.
- **npx vitest run --config test/vitest.config.ts apps/ops-cli/src/verify-venue:** 2 files, 375 of 375 tests passed.
- **git diff --name-only f43efe6:** docs/contracts/protected-contracts.md, docs/venue/verified-2026-09-30.md and test/fixtures/venue/README.md. These are only the allowed paths.

### assumptions

- github.com is on the packet's allowed network list, so the one new GET (S-S09, unauthenticated) is within the rules.
- Four files are treated as identical at head and at 0.11.0: actions/subscriptions.ts, websockets/rtds.ts, websockets/types.ts and decorators/subscriptions.ts. This is inferred from their absence from the S-S08 (d527956f...6842ffa4) file list. No 0.11.0 copy of these files was fetched.
- signature_type=3 in the S-D48 example is not interpreted beyond being that page's Deposit Wallet example.

### deviations

- PIN-V3R1-02 is stricter than the candidate's wording. On 8375f2d it also flags the realtime/* files, which the candidate had covered with a glob. The new table names each of them.
- The pins are a shell script in scratch, not a repository test, because this package's allowed paths contain no test file.
- The domain list in §13 now includes github.com, because of S-S09.

### known_risks

- The known risks from r0 are unchanged.
- S-S09 is GitHub's rendered compare diff, so its digest may change if GitHub re-renders it, even when the content is the same.
- U-22: the balance/allowance read shape is undocumented, so a WP-290 balance reconciler has no documented response to build against. The cache refresh needs L2 credentials, which PAPER does not have.

### follow_up

- The r0 carry-forward list (§16) still applies.
- New: U-22 goes to WP-290 and WP-300. WP-300 should follow S-D48's order: approvals first, then GET /balance-allowance/update, then trading.
- A fresh reviewer should re-verify this round, including a re-fetch of S-S09.

### commit_sha

3625a66e8069cac63a5f3928e526da35c46ad02e
