/**
 * Venue facts this package relies on, each with its citation.
 *
 * Authority: `docs/venue/verified-2026-09-30.md` (VENUE-3, the phase-3 gate),
 * which re-confirms `docs/venue/verified-2026-09-16.md` (VENUE-2) for every
 * surface below ("identical to VENUE-2 after normalization"). Nothing here is
 * inferred: a fact the reports do not state is NOT in this file, and the code
 * that would need it refuses or defers to reconciliation instead.
 *
 * What is deliberately ABSENT (and why):
 * - Which spender(s) each approval must target. The reports record the
 *   documented contract ADDRESSES (below) and the ORDER "approvals, then the
 *   CLOB allowance sync, then trading" (S-D48), but not the per-approval
 *   spender list. Callers declare the approvals they need; this package only
 *   refuses a spender that is not a documented venue contract.
 * - Any wrap/unwrap conversion rate. pUSD is "a standard ERC-20 wrapper that
 *   represents a USDC claim" (S-D35), but no page states a rate, so a wrap or
 *   unwrap is credited from the confirmation's OBSERVED amount, never computed
 *   (ADR-006 §7 rule 2: a conversion is an explicit recorded transaction).
 * - The redeem payout. Redeem is credited from the observed amount too; a
 *   CANCELLED market is refused outright (U-10, still undocumented on
 *   2026-09-30 §12: "Cancellation/void payout — Still undocumented").
 * - The on-chain parameter encoding (calldata). This package models
 *   operations; it never builds, signs or sends a transaction.
 * - Any bridge, deposit, withdrawal or transfer route. Out of scope in v1
 *   (handoff §9.14 "No autonomous deposit, withdrawal, or bridge behavior in
 *   v1"; ADR-006 §8), and no such operation type exists here.
 */

/** Where every fact below was verified. */
export const VENUE_FACTS_SOURCE = Object.freeze({
  report: "docs/venue/verified-2026-09-30.md",
  baseline: "docs/venue/verified-2026-09-16.md",
  retrieved: "2026-09-30",
});

/**
 * pUSD decimals: `Decimals 6` (S-D35 line 33, quoted in verified-2026-09-16
 * D-15; re-confirmed identical in verified-2026-09-30 §W.8 and §0 item 11).
 * Used only to convert an on-chain base-unit amount into a decimal amount.
 */
export const PUSD_DECIMALS = 6 as const;

export type VenueContractRole =
  | "PUSD_COLLATERAL_TOKEN"
  | "USDC_E"
  | "CONDITIONAL_TOKENS"
  | "CTF_COLLATERAL_ADAPTER"
  | "NEG_RISK_CTF_COLLATERAL_ADAPTER"
  | "CTF_EXCHANGE"
  | "NEG_RISK_CTF_EXCHANGE"
  | "COLLATERAL_ONRAMP"
  | "COLLATERAL_OFFRAMP";

export interface DocumentedVenueContract {
  readonly role: VenueContractRole;
  /** The PUBLIC Polygon address, verbatim from the cited page. Not a credential. */
  readonly address: string;
  readonly citation: string;
}

/**
 * The documented PUBLIC Polygon contract addresses (not credentials).
 *
 * - pUSD, Conditional Tokens and the two collateral adapters: verified-2026-09-16
 *   §10.2 (S-D29 lines 130–133; S-D40 lines 20, 47, 52–53), re-confirmed
 *   verified-2026-09-30 §10.2; also frozen in
 *   `test/fixtures/venue/positions/split-merge-redeem.json`.
 * - CTF Exchange and Neg Risk CTF Exchange: verified-2026-09-30 §W.8 (S-D40
 *   lines 17–18; S-D12 lines 309–310); U-5 residual resolved documentarily
 *   (verified-2026-09-16 D-26).
 * - CollateralOnramp, CollateralOfframp: verified-2026-09-30 §W.8 (S-D40).
 * - USDC.e: verified-2026-09-16 D-15 ("S-D35 names USDC.e as `0x2791…4174`";
 *   the onramp's `_asset` "Must be USDC.e").
 */
export const DOCUMENTED_VENUE_CONTRACTS: readonly DocumentedVenueContract[] = Object.freeze([
  Object.freeze({
    role: "PUSD_COLLATERAL_TOKEN",
    address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    citation: "verified-2026-09-30 §W.8 (S-D40); verified-2026-09-16 §10.2",
  }),
  Object.freeze({
    role: "USDC_E",
    address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    citation: "verified-2026-09-16 D-15 (S-D35)",
  }),
  Object.freeze({
    role: "CONDITIONAL_TOKENS",
    address: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    citation: "verified-2026-09-16 §10.2 and D-26 (S-D29, S-D40); re-confirmed 2026-09-30 §10.2",
  }),
  Object.freeze({
    role: "CTF_COLLATERAL_ADAPTER",
    address: "0xAdA100Db00Ca00073811820692005400218FcE1f",
    citation: "verified-2026-09-16 §10.2 (S-D29, S-D40); re-confirmed 2026-09-30 §10.2",
  }),
  Object.freeze({
    role: "NEG_RISK_CTF_COLLATERAL_ADAPTER",
    address: "0xadA2005600Dec949baf300f4C6120000bDB6eAab",
    citation: "verified-2026-09-16 §10.2 (S-D29, S-D40); re-confirmed 2026-09-30 §10.2",
  }),
  Object.freeze({
    role: "CTF_EXCHANGE",
    address: "0xE111180000d2663C0091e4f400237545B87B996B",
    citation: "verified-2026-09-30 §W.8 (S-D40 lines 17–18; S-D12 lines 309–310)",
  }),
  Object.freeze({
    role: "NEG_RISK_CTF_EXCHANGE",
    address: "0xe2222d279d744050d28e00520010520000310F59",
    citation: "verified-2026-09-30 §W.8 (S-D40 lines 17–18; S-D12 lines 309–310)",
  }),
  Object.freeze({
    role: "COLLATERAL_ONRAMP",
    address: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
    citation: "verified-2026-09-30 §W.8 (S-D40); verified-2026-09-16 D-15",
  }),
  Object.freeze({
    role: "COLLATERAL_OFFRAMP",
    address: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
    citation: "verified-2026-09-30 §W.8 (S-D40); verified-2026-09-16 D-15",
  }),
]);

/**
 * The roles an approval may name as its SPENDER: documented venue contracts
 * that operate on the account's tokens. Token contracts themselves (pUSD,
 * USDC.e, Conditional Tokens) are not spenders. An approval to any address
 * outside this set is refused: an approval to an arbitrary address is a way to
 * move funds off the venue, and this package has none.
 */
export const APPROVAL_SPENDER_ROLES: readonly VenueContractRole[] = Object.freeze([
  "CTF_EXCHANGE",
  "NEG_RISK_CTF_EXCHANGE",
  "CTF_COLLATERAL_ADAPTER",
  "NEG_RISK_CTF_COLLATERAL_ADAPTER",
  "COLLATERAL_ONRAMP",
  "COLLATERAL_OFFRAMP",
]);

/** The documented contract at `address` (case-insensitive hex match), if any. */
export function documentedContractAt(address: string): DocumentedVenueContract | undefined {
  const wanted = address.toLowerCase();
  return DOCUMENTED_VENUE_CONTRACTS.find((contract) => contract.address.toLowerCase() === wanted);
}

/** Whether `address` is a documented contract in an approval-spender role. */
export function isDocumentedApprovalSpender(address: string): boolean {
  const contract = documentedContractAt(address);
  return contract !== undefined && APPROVAL_SPENDER_ROLES.includes(contract.role);
}

/**
 * The trading-readiness order after approvals, verbatim from S-D48
 * (`trading/wallets-auth.md`, "Set Up Trading Approvals", step "Sync CLOB
 * Allowances", lines 1186–1228; recorded in verified-2026-09-30 §W.9):
 * "Finally, update the CLOB allowance cache" with `GET /balance-allowance/update`
 * (`asset_type=COLLATERAL`, or `asset_type=CONDITIONAL` with `token_id`), and
 * "Refresh the conditional-token allowance for each token before its first
 * sell order." An approval confirmed on chain is therefore NOT yet trading
 * readiness; the sync is an L2-authenticated call and is out of reach in PAPER.
 */
export const CLOB_ALLOWANCE_SYNC_CITATION =
  "verified-2026-09-30 §W.8/§W.9 (S-D48 lines 1186–1228): approvals, then GET /balance-allowance/update, then trading; refresh the conditional-token allowance per token before its first sell";
