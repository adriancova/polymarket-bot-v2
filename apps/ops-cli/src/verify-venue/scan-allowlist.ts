/**
 * V2-9 round 7: the explicit exceptions of the generic walk (`tree-scan.ts`).
 *
 * Each entry names one exact value that a rule refuses, the (file, JSON path)
 * pairs where the committed tree holds it, the rule, the report id that
 * vouches for it (which the gate checks the report defines), and why it is
 * not personal data. Anything a rule refuses that no entry names fails the
 * gate; an entry that matches nothing fails it too (stale).
 *
 * Paths: `$` is a file's root (`$[n]` the record on line `n + 1` of a
 * `.jsonl` file); `.key` or `["key"]` a member; `[n]` an array item; `@key`
 * the key itself; `<json>` the JSON a string's own text holds.
 *
 * Generated once from the committed tree, then reviewed entry by entry; a
 * package that commits a new public value adds its entry, with its source.
 */

/** The rules of the walk. */
export const SCAN_RULES = [
  "email",
  "wallet",
  "hash",
  "cursor",
  "assignment",
  "personal-key",
  "credential",
] as const;

export type ScanRule = (typeof SCAN_RULES)[number];

/** One exception: an exact value, where it sits, and who vouches for it. */
export interface ScanAllowlistEntry {
  readonly rule: ScanRule;
  /** The exact token the rule refuses (for an object rule, the key). */
  readonly value: string;
  /** The report, and an id it defines (`F-71`, `S-A03`, or a section `§3`). */
  readonly source: { readonly report: string; readonly id: string };
  /** Why the value is public and not personal. */
  readonly reason: string;
  /** Each (file relative to `test/fixtures/venue`, JSON path) that holds it. */
  readonly at: readonly (readonly [file: string, path: string])[];
}

export const SCAN_ALLOWLIST: readonly ScanAllowlistEntry[] = [
  {
    rule: "hash",
    value: "7fdbed42484b5d279c71aa36d3757d18968260da",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§1" },
    reason: "the pinned SDK reference commit (SDK_REFERENCE_COMMIT), a git commit id",
    at: [
      ["fees/fee-reward-parameters.json", "$.notes"],
      ["orders/rest-trades.json", "$.source"],
      ["orders/rest-trades.json", "$.notes"],
      ["user-ws/trade-settlement.json", "$.source"],
      ["user-ws/trade-settlement.json", "$.notes"],
    ],
  },
  {
    rule: "hash",
    value: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§6" },
    reason: "the documentation examples' market condition id",
    at: [
      ["fees/fee-reward-parameters.json", "$.examples[3].payload.market_settings_example.clobRewards[0].conditionId"],
      ["fees/fee-reward-parameters.json", "$.examples[3].payload.market_settings_example.clobRewards[1].conditionId"],
    ],
  },
  {
    rule: "hash",
    value: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§3" },
    reason: "the documentation examples' market condition id",
    at: [
      ["market-ws/best-bid-ask.json", "$.examples[0].payload.market"],
      ["market-ws/book-snapshot.json", "$.examples[0].payload.market"],
      ["market-ws/last-trade-price.json", "$.examples[0].payload.market"],
      ["market-ws/lifecycle.json", "$.examples[0].payload.market"],
      ["market-ws/lifecycle.json", "$.examples[1].payload.market"],
      ["market-ws/price-change.json", "$.examples[0].payload.market"],
      ["market-ws/price-change.json", "$.examples[1].payload.market"],
      ["market-ws/tick-size-change.json", "$.examples[0].payload.market"],
    ],
  },
  {
    rule: "hash",
    value: "3024eabbb25ef7f514bba9b93deee7b5b96690f72fc4cf3a8eba41f2a5293445",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-W01" },
    reason: "the S-W01 session's raw sha256, which the report's source index records",
    at: [
      ["market-ws/book-snapshot-v2.json", "$.notes"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-W01" },
    reason: "a public market condition id that the report read",
    at: [
      ["market-ws/book-snapshot-v2.json", "$.examples[0].payload.market"],
      ["protocol-v2/ws-market-v2-session.jsonl", "$[2].data"],
      ["protocol-v2/ws-market-v2-session.jsonl", "$[2].data<json>[0].market"],
    ],
  },
  {
    rule: "hash",
    value: "fc3846cab0c35a0977b6e5f605a4e5ff0d0b2277",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-W01" },
    reason: "the book hash the venue served on the public market channel (a digest of a public book)",
    at: [
      ["market-ws/book-snapshot-v2.json", "$.examples[0].payload.hash"],
      ["protocol-v2/ws-market-v2-session.jsonl", "$[2].data"],
      ["protocol-v2/ws-market-v2-session.jsonl", "$[2].data<json>[0].hash"],
    ],
  },
  {
    rule: "hash",
    value: "56621a121a47ed9333273e21c83b660cff37ae50",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§3" },
    reason: "the documentation example's price-change book hash (a digest of a public book)",
    at: [
      ["market-ws/price-change.json", "$.examples[0].payload.price_changes[0].hash"],
    ],
  },
  {
    rule: "hash",
    value: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§4" },
    reason: "the documentation examples' market condition id",
    at: [
      ["orders/rest-trades.json", "$.examples[0].payload.market"],
      ["orders/rest-trades.json", "$.examples[1].payload.market"],
      ["orders/rest-trades.json", "$.examples[2].payload.market"],
      ["user-ws/order-lifecycle.json", "$.examples[0].payload.market"],
      ["user-ws/order-lifecycle.json", "$.examples[1].payload.market"],
      ["user-ws/order-lifecycle.json", "$.examples[2].payload.market"],
      ["user-ws/order-lifecycle.json", "$.examples[3].payload.market"],
      ["user-ws/order-lifecycle.json", "$.examples[4].payload.market"],
      ["user-ws/trade-settlement.json", "$.examples[0].payload.market"],
      ["user-ws/trade-settlement.json", "$.examples[1].payload.market"],
      ["user-ws/trade-settlement.json", "$.examples[2].payload.market"],
      ["user-ws/trade-settlement.json", "$.examples[3].payload.market"],
      ["user-ws/trade-settlement.json", "$.examples[4].payload.market"],
    ],
  },
  {
    rule: "wallet",
    value: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "F-71" },
    reason: "a documented Polymarket Protocol V2 contract address (F-71; PUBLIC_CONTRACT_ADDRESSES)",
    at: [
      ["positions/router-v2.json", "$.examples[0].payload.contracts.ExchangeV3"],
    ],
  },
  {
    rule: "wallet",
    value: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "F-71" },
    reason: "a documented Polymarket Protocol V2 contract address (F-71; PUBLIC_CONTRACT_ADDRESSES)",
    at: [
      ["positions/router-v2.json", "$.examples[0].payload.contracts.PositionManager"],
      ["positions/router-v2.json", "$.examples[2].payload.token_contract"],
      ["positions/router-v2.json", "$.examples[7].payload.target"],
    ],
  },
  {
    rule: "wallet",
    value: "0x12121212006e4CD160D18e3f00711DA5c3372600",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "F-71" },
    reason: "a documented Polymarket Protocol V2 contract address (F-71; PUBLIC_CONTRACT_ADDRESSES)",
    at: [
      ["positions/router-v2.json", "$.examples[0].payload.contracts.Router"],
      ["positions/router-v2.json", "$.examples[1].payload.spender"],
      ["positions/router-v2.json", "$.examples[2].payload.operator"],
      ["positions/router-v2.json", "$.examples[3].payload.target"],
      ["positions/router-v2.json", "$.examples[4].payload.target"],
      ["positions/router-v2.json", "$.examples[5].payload.target"],
      ["positions/router-v2.json", "$.examples[6].payload.target"],
    ],
  },
  {
    rule: "wallet",
    value: "0xa1200000d0002264C9a1698e001292D00E1b00af",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "F-71" },
    reason: "a documented Polymarket Protocol V2 contract address (F-71; PUBLIC_CONTRACT_ADDRESSES)",
    at: [
      ["positions/router-v2.json", "$.examples[0].payload.contracts.AutoRedeemer"],
    ],
  },
  {
    rule: "wallet",
    value: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "F-71" },
    reason: "a documented Polymarket Protocol V2 contract address (F-71; PUBLIC_CONTRACT_ADDRESSES)",
    at: [
      ["positions/router-v2.json", "$.examples[0].payload.contracts.pUSD"],
      ["positions/router-v2.json", "$.examples[1].payload.token_contract"],
    ],
  },
  {
    rule: "hash",
    value: "0x017089ce3ba22aaa0a4cba8250b8c8e1eb0000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-D17" },
    reason: "a public market condition id that the report read",
    at: [
      ["positions/router-v2.json", "$.examples[3].payload.request.conditionId"],
      ["positions/router-v2.json", "$.examples[4].payload.request.conditionId"],
      ["positions/router-v2.json", "$.examples[5].payload.request.conditionId"],
      ["positions/router-v2.json", "$.examples[6].payload.request.conditionId"],
      ["positions/router-v2.json", "$.examples[8].payload.condition_id"],
      ["positions/router-v2.json", "$.examples[9].payload.condition_id"],
      ["positions/router-v2.json", "$.examples[10].payload.condition_id_bytes31"],
      ["protocol-v2/gamma-event-v2-docs-example.jsonc", "$.markets[0].conditionId"],
    ],
  },
  {
    rule: "hash",
    value: "0x017089ce3ba22aaa0a4cba8250b8c8e1eb000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-D04" },
    reason: "a public market condition id that the report read",
    at: [
      ["positions/router-v2.json", "$.examples[10].payload.condition_id_bytes32"],
    ],
  },
  {
    rule: "assignment",
    value: "transactionHash: TxHash",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§10.2" },
    reason: "the documentation's type annotation (outcome.transactionHash: TxHash), not a value",
    at: [
      ["positions/split-merge-redeem.json", "$.notes"],
    ],
  },
  {
    rule: "wallet",
    value: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§10.2" },
    reason: "a documented Polymarket contract address that the 2026-08-24 report records (§10.2), not a wallet",
    at: [
      ["positions/split-merge-redeem.json", "$.examples[0].payload.contracts.pUSD"],
      ["positions/split-merge-redeem.json", "$.examples[1].payload.request.collateralToken"],
      ["positions/split-merge-redeem.json", "$.examples[2].payload.request.collateralToken"],
      ["positions/split-merge-redeem.json", "$.examples[3].payload.request.collateralToken"],
      ["positions/split-merge-redeem.json", "$.examples[4].payload.request.collateralToken"],
      ["positions/split-merge-redeem.json", "$.examples[5].payload.collateral_token"],
    ],
  },
  {
    rule: "wallet",
    value: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§10.2" },
    reason: "a documented Polymarket contract address that the 2026-08-24 report records (§10.2), not a wallet",
    at: [
      ["positions/split-merge-redeem.json", "$.examples[0].payload.contracts.ConditionalTokens"],
    ],
  },
  {
    rule: "wallet",
    value: "0xAdA100Db00Ca00073811820692005400218FcE1f",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§10.2" },
    reason: "a documented Polymarket contract address that the 2026-08-24 report records (§10.2), not a wallet",
    at: [
      ["positions/split-merge-redeem.json", "$.examples[0].payload.contracts.CtfCollateralAdapter"],
    ],
  },
  {
    rule: "wallet",
    value: "0xadA2005600Dec949baf300f4C6120000bDB6eAab",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§10.2" },
    reason: "a documented Polymarket contract address that the 2026-08-24 report records (§10.2), not a wallet",
    at: [
      ["positions/split-merge-redeem.json", "$.examples[0].payload.contracts.NegRiskCtfCollateralAdapter"],
      ["positions/split-merge-redeem.json", "$.examples[6].payload.adapter"],
    ],
  },
  {
    rule: "hash",
    value: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
    source: { report: "docs/venue/verified-2026-08-24.md", id: "§10.2" },
    reason: "the documentation examples' market condition id",
    at: [
      ["positions/split-merge-redeem.json", "$.examples[1].payload.request.conditionId"],
      ["positions/split-merge-redeem.json", "$.examples[2].payload.request.conditionId"],
      ["positions/split-merge-redeem.json", "$.examples[3].payload.request.conditionId"],
      ["positions/split-merge-redeem.json", "$.examples[4].payload.request.conditionId"],
    ],
  },
  {
    rule: "hash",
    value: "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L11" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/book-v1.jsonc", "$.market"],
    ],
  },
  {
    rule: "hash",
    value: "d796068a0a4a7c05d139b2f5d683414249ba941d",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L11" },
    reason: "the book hash the venue served on the public market channel (a digest of a public book)",
    at: [
      ["protocol-v2/book-v1.jsonc", "$.hash"],
    ],
  },
  {
    rule: "hash",
    value: "5449bd35334c63fc1f852af5150b524af4d1c9a15977c886c5d8e2b61a7b521a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L11" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/book-v1.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "5449bd35334c63fc1f852af5150b524af4d1c9a15977c886c5d8e2b61a7b521a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L11" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/book-v1.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L03" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/book-v2.jsonc", "$.market"],
    ],
  },
  {
    rule: "hash",
    value: "fc3846cab0c35a0977b6e5f605a4e5ff0d0b2277",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L03" },
    reason: "the book hash the venue served on the public market channel (a digest of a public book)",
    at: [
      ["protocol-v2/book-v2.jsonc", "$.hash"],
    ],
  },
  {
    rule: "hash",
    value: "c2934793c1d5a1d7263936f71c54161f6ddc86cb94ce3f29ad855f88f1409a37",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L03" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/book-v2.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "c2934793c1d5a1d7263936f71c54161f6ddc86cb94ce3f29ad855f88f1409a37",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L03" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/book-v2.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L10" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/clob-markets-v1.jsonc", "$.c"],
      ["protocol-v2/clob-markets-v1.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "69c01d4f87b14b9e3aed6845c7067546fb38367a4aa57478a3f1887583d258e8",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L10" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/clob-markets-v1.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "69c01d4f87b14b9e3aed6845c7067546fb38367a4aa57478a3f1887583d258e8",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L10" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/clob-markets-v1.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f0000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L02" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/clob-markets-v2-62hex-not-found.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "15b39f9a317495428d04b3871d903b1e05fdf85bb80b89c50f731f631d95e16c",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L02" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/clob-markets-v2-62hex-not-found.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "15b39f9a317495428d04b3871d903b1e05fdf85bb80b89c50f731f631d95e16c",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L02" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/clob-markets-v2-62hex-not-found.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L01" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/clob-markets-v2.jsonc", "$.c"],
      ["protocol-v2/clob-markets-v2.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "729762a0a6c71e4118012f4623d3810614bab1138d0544f5a3d41b25be8ed010",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L01" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/clob-markets-v2.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "729762a0a6c71e4118012f4623d3810614bab1138d0544f5a3d41b25be8ed010",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L01" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/clob-markets-v2.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A06" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-oi-v2.jsonc", "$.data[0].condition_id"],
      ["protocol-v2/data-v2-oi-v2.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "8b6f9091bddf33d188334d901b3e2b9a1030528140625ccb9c30237f03c679a4",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A06" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-oi-v2.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "8b6f9091bddf33d188334d901b3e2b9a1030528140625ccb9c30237f03c679a4",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A06" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-oi-v2.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "cursor",
    value: "eyJkYXRhIjp7InR5cGUiOiJwcmljZXNfaGlzdG9yeSIsInBhcmFtcyI6eyJsIjozLCJ0cyI6MTc5MTIzOTEwMCwic3EiOiIzMDAiLCJkIjozfX0sInNpZyI6IjQ1MGNjZDQ1ZWU0NmI5NTgwZWQ5ODNhMDkzZThkYjBlIn0",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A02" },
    reason: "a public prices_history market cursor (a market's price series, no account; PUBLIC_MARKET_CURSORS), not a trade or activity cursor",
    at: [
      ["protocol-v2/data-v2-prices-history-page1.jsonc", "$.pagination.next_cursor"],
    ],
  },
  {
    rule: "hash",
    value: "c8a9c8422ae340d433dcef9de61d1522d13082867e802e5ff13277b7429dfc89",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A02" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-prices-history-page1.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "c8a9c8422ae340d433dcef9de61d1522d13082867e802e5ff13277b7429dfc89",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A02" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-prices-history-page1.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "cursor",
    value: "eyJkYXRhIjp7InR5cGUiOiJwcmljZXNfaGlzdG9yeSIsInBhcmFtcyI6eyJsIjozLCJ0cyI6MTc5MTI0MDAwMCwic3EiOiIzMDAiLCJkIjo2fX0sInNpZyI6IjNhOWJjYmZiNWViZDY0OGZlMzJmZmM0OGJhZTVmYjE5In0",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A03" },
    reason: "a public prices_history market cursor (a market's price series, no account; PUBLIC_MARKET_CURSORS), not a trade or activity cursor",
    at: [
      ["protocol-v2/data-v2-prices-history-page2.jsonc", "$.pagination.next_cursor"],
    ],
  },
  {
    rule: "cursor",
    value: "eyJkYXRhIjp7InR5cGUiOiJwcmljZXNfaGlzdG9yeSIsInBhcmFtcyI6eyJsIjozLCJ0cyI6MTc5MTIzOTEwMCwic3EiOiIzMDAiLCJkIjozfX0sInNpZyI6IjQ1MGNjZDQ1ZWU0NmI5NTgwZWQ5ODNhMDkzZThkYjBlIn0",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A03" },
    reason: "a public prices_history market cursor (a market's price series, no account; PUBLIC_MARKET_CURSORS), not a trade or activity cursor",
    at: [
      ["protocol-v2/data-v2-prices-history-page2.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "04999230e2e1149d66819cd589dc986339f5448ecdf19ec74304a9e31e00f531",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A03" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-prices-history-page2.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "04999230e2e1149d66819cd589dc986339f5448ecdf19ec74304a9e31e00f531",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A03" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-prices-history-page2.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f0000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L05" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-resolutions-62hex-invalid.jsonc", "$.error"],
      ["protocol-v2/data-v2-resolutions-62hex-invalid.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "864498688ff5e19f73d572f4207e6fc3b74007cd4fc8ba3c4122f923fff98294",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L05" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-resolutions-62hex-invalid.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "864498688ff5e19f73d572f4207e6fc3b74007cd4fc8ba3c4122f923fff98294",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L05" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-resolutions-62hex-invalid.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x156b8d520e362e159d70d7428f08371ecc9dc91d3437a903d97ae97908f73bec",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A10" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-resolutions-v1-resolved.jsonc", "$.data[0].condition_id"],
      ["protocol-v2/data-v2-resolutions-v1-resolved.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "0x3f8f1bc229eb5740645a6df7037adec23d95a3cb0c0236bbe22cd62331b89a00",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A10" },
    reason: "the market's resolution transaction (public market data, not a trader's)",
    at: [
      ["protocol-v2/data-v2-resolutions-v1-resolved.jsonc", "$.data[0].transaction_hash"],
    ],
  },
  {
    rule: "hash",
    value: "9de68cd8ac82034bd7d67afd9b1f33a063182fb806c7afe791f9a3fdd0915e1d",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A10" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-resolutions-v1-resolved.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "9de68cd8ac82034bd7d67afd9b1f33a063182fb806c7afe791f9a3fdd0915e1d",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A10" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-resolutions-v1-resolved.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L04" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-resolutions-v2-active.jsonc", "$.data[0].condition_id"],
      ["protocol-v2/data-v2-resolutions-v2-active.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "7603270de994df1ad0582259c7fd6cc8991a8b8e824f7b844cdf17b347bd216a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L04" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-resolutions-v2-active.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "7603270de994df1ad0582259c7fd6cc8991a8b8e824f7b844cdf17b347bd216a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-L04" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-resolutions-v2-active.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x015ecdbafe90dfcb60b2f38afe44f4be85000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A11" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-resolutions-v2-resolved.jsonc", "$.data[0].condition_id"],
      ["protocol-v2/data-v2-resolutions-v2-resolved.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "f6a404b7c78f4ef641046612980a42eb1c9e546ebb9ff79d1acd2a403d869db8",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A11" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-resolutions-v2-resolved.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "f6a404b7c78f4ef641046612980a42eb1c9e546ebb9ff79d1acd2a403d869db8",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A11" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-resolutions-v2-resolved.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.jsonc", "$.data[0].condition_id"],
      ["protocol-v2/data-v2-trades-v1-page1.jsonc", "$.data[1].condition_id"],
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "fc04422b7ae5df343be8cf62e0865c90a432660180415731a39c6d26300417f6",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "assignment",
    value: "proxy_wallet: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.redactions[0]"],
    ],
  },
  {
    rule: "assignment",
    value: "pseudonym: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.redactions[1]"],
    ],
  },
  {
    rule: "assignment",
    value: "profile_image_optimized: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.redactions[2]"],
    ],
  },
  {
    rule: "assignment",
    value: "transaction_hash: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.redactions[3]"],
    ],
  },
  {
    rule: "hash",
    value: "2cfe6934c07042de3e25066646a9dd7c5f17b32c56f3492385f855eaeeb1abc7",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A08" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-trades-v1-page1.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.jsonc", "$.data[0].condition_id"],
      ["protocol-v2/data-v2-trades-v1-page2.jsonc", "$.data[1].condition_id"],
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "7969f2e91a266b542964d34c4de233db2ddf284d5a029ee5f2c6b649f2943183",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "assignment",
    value: "proxy_wallet: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.redactions[0]"],
    ],
  },
  {
    rule: "assignment",
    value: "pseudonym: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.redactions[1]"],
    ],
  },
  {
    rule: "assignment",
    value: "profile_image_optimized: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.redactions[2]"],
    ],
  },
  {
    rule: "assignment",
    value: "transaction_hash: replaced",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "a redaction's subject list (the field it names before its colon), not a value",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.redactions[3]"],
    ],
  },
  {
    rule: "hash",
    value: "3fc177b0e33a61cedb5c371be75eecdfd5de5b9d8475a1bbe22fbe5ccd7c59eb",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A09" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-trades-v1-page2.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A07" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/data-v2-trades-v2-empty.provenance.jsonc", "$.url"],
    ],
  },
  {
    rule: "hash",
    value: "8eca10dcd085fa846e31e7eabb051f024de6bd15f5eae58686c8443a0620a0be",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A07" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/data-v2-trades-v2-empty.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "8eca10dcd085fa846e31e7eabb051f024de6bd15f5eae58686c8443a0620a0be",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-A07" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/data-v2-trades-v2-empty.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "b570fc4cb67910455b4958e7a38ebf3f6427b51bf588b7b764c336e832b9c085",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-D17" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/gamma-event-v2-docs-example.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "61a846f2d1a52bdaffeb3ec8701c3211aa2dffdd586ecab2d9ad7ce74e015743",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-D17" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/gamma-event-v2-docs-example.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G05" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/gamma-events-keyset-series10192.jsonc", "$.events[0].markets[0].conditionId"],
    ],
  },
  {
    rule: "hash",
    value: "0x628ae806dae448ab4f15e9cbf68dcbaa995435405334985e774182680fdafead",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G05" },
    reason: "a public market's question id (Gamma market metadata)",
    at: [
      ["protocol-v2/gamma-events-keyset-series10192.jsonc", "$.events[0].markets[0].questionID"],
    ],
  },
  {
    rule: "hash",
    value: "0x2cacf58f61ecae4da864dcc50346e82e0cd6910e6bcd9de88db257d2e806c4cf",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G05" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/gamma-events-keyset-series10192.jsonc", "$.events[1].markets[0].conditionId"],
    ],
  },
  {
    rule: "hash",
    value: "0x88166ff696729c5fc3b9a4598f1f6f1a6eaca1177f4bf0d39beb429b5fb59407",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G05" },
    reason: "a public market's question id (Gamma market metadata)",
    at: [
      ["protocol-v2/gamma-events-keyset-series10192.jsonc", "$.events[1].markets[0].questionID"],
    ],
  },
  {
    rule: "hash",
    value: "e28e186ea93f0156a833bd05d0de64db06e0aed4226543dbb89adbbfc265fdd4",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G05" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/gamma-events-keyset-series10192.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "e28e186ea93f0156a833bd05d0de64db06e0aed4226543dbb89adbbfc265fdd4",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G05" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/gamma-events-keyset-series10192.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G04" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/gamma-market-v1-btc15m.jsonc", "$.conditionId"],
    ],
  },
  {
    rule: "hash",
    value: "0x628ae806dae448ab4f15e9cbf68dcbaa995435405334985e774182680fdafead",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G04" },
    reason: "a public market's question id (Gamma market metadata)",
    at: [
      ["protocol-v2/gamma-market-v1-btc15m.jsonc", "$.questionID"],
    ],
  },
  {
    rule: "hash",
    value: "ec1abfdb433c4a0d0d9834aed3898362451c66de8dac9f577f95f9d8b8291571",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G04" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/gamma-market-v1-btc15m.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "ec1abfdb433c4a0d0d9834aed3898362451c66de8dac9f577f95f9d8b8291571",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-G04" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/gamma-market-v1-btc15m.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "00be2ab64b017c31524715c4ae43c08571e5bfa444e77ee885d0adc388aafd99",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-D16" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/gamma-market-v2-docs-example.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "725249ca063514923d9f64cce168b844de50d5073bb11277ffb817a7797ea6fe",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-D16" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/gamma-market-v2-docs-example.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "0xab449b45ddb6c2682ec7e931dfb18705cf611cddf42ae35aa300c79453913dca",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-W01" },
    reason: "a public market condition id that the report read",
    at: [
      ["protocol-v2/ws-market-v2-session.jsonl", "$[11].data"],
      ["protocol-v2/ws-market-v2-session.jsonl", "$[11].data<json>.market"],
      ["protocol-v2/ws-market-v2-session.jsonl", "$[11].data<json>.condition_id"],
    ],
  },
  {
    rule: "hash",
    value: "3024eabbb25ef7f514bba9b93deee7b5b96690f72fc4cf3a8eba41f2a5293445",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-W01" },
    reason: "the sha256 of the raw response, which the report's source index records",
    at: [
      ["protocol-v2/ws-market-v2-session.provenance.jsonc", "$.raw_sha256"],
    ],
  },
  {
    rule: "hash",
    value: "d38c050a708933e6f7355057ce27687945bc1e169acde70b754788326b5cb006",
    source: { report: "docs/venue/verified-2026-10-05.md", id: "S-W01" },
    reason: "the sha256 of the committed capture bytes, which the gate checks",
    at: [
      ["protocol-v2/ws-market-v2-session.provenance.jsonc", "$.fixture_sha256"],
    ],
  },
];
