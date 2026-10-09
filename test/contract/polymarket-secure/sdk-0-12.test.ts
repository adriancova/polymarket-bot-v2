/**
 * Contract: the pinned `@polymarket/client@0.12.0` (V2-5, Protocol V2 plan
 * rows C3-C6 and C16), driven through `polymarket-secure/testing` with the
 * REAL SDK code behind the network tripwire. Every HTTP answer is an
 * in-memory fixture; the signer is the test mock, which refuses every venue
 * domain, so no order is ever signed and nothing leaves the process.
 *
 * What is pinned, each against the published package's own code:
 *
 * 1. THE PIN: the lockfile resolves exactly 0.12.0 (client and bindings) with
 *    the integrity recorded in `docs/runbooks/signer.md` §7, whose provenance
 *    commit the runbook names; `zod` did not move (ADR-020 §7).
 * 2. F-47: the SDK chooses the order's EIP-712 domain from the id's reserved
 *    bits. A V2-shaped id is signed against ExchangeV3 with domain version
 *    `"3"`; a V1 id against the CTF Exchange (or the Neg Risk exchange) with
 *    `"2"`. Read from the domain the SDK asks the mock signer to sign.
 * 3. F-53: `CONDITIONAL-V2` exists in the pinned SDK, and a balance read for
 *    a V2 SELL selected that way reaches the wire as `asset_type=CONDITIONAL-V2`.
 *    The SDK's OWN choice for a V2 SELL (`resolveBalanceAllowanceAssetType`,
 *    used only by the `place*` allowance recovery this package never calls)
 *    is pinned statically in the shipped JS, tied to the same reserved-bit
 *    predicate that picks the signing domain (2).
 * 4. `place*` is never touched: every venue-client method, run over the real
 *    SDK client, reads only the ten port members.
 * 5. ky (the SDK's transport, 1.14.3): a DELETE (every cancel) and a GET are
 *    retried twice on a network error; a POST never is; each attempt times
 *    out at 10 s, and a timeout is not retried.
 * 6. `createLimitOrder` caches the market metadata for 10 minutes
 *    (`actions/orders/cache.ts` lines 16-17) and the token's condition for
 *    the client's life; an off-grid price forces one fresh metadata read.
 * 7. ROUNDING (`venue-client.ts` `SHARE_ROUNDING_BASE_UNITS` and
 *    `QUOTE_ROUNDING_MAX_BASE_UNITS`): for each of the six tick sizes, the
 *    real SDK's signed amounts are the shares rounded DOWN to 2 decimals and
 *    the quote rounded DOWN to the tick's amount decimals, and the venue
 *    client's cross-check accepts exactly those amounts.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SignedOrderEnvelope, type SecureVenueClient } from "../../../packages/polymarket-secure/src/index.js";
import {
  contractVenueResponder,
  createFakeSdkFactory,
  createMockSignerHandle,
  createPinnedSdkFactoryForContract,
  createRecordingPinnedSdkFactoryForContract,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  MOCK_FIXTURE_DOMAIN_NAME,
  MOCK_SIGNER_ADDRESS,
  pinnedSdkAssetTypes,
  pinnedSdkDistDirectory,
  readBalanceAllowanceWithPinnedSdk,
  type ContractMarket,
  type ContractRequest,
  type MockSignerProbe,
  type NetworkTripwire,
} from "../../../packages/polymarket-secure/src/testing/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const BYTES32_ZERO = `0x${"0".repeat(64)}`;

/** The pin (`docs/runbooks/signer.md` §7, V2-5 fresh check). */
const CLIENT_INTEGRITY = "sha512-ZciRp/j0bLQYB3ownLtQDarBTgT3WwXuk/Gp+Ppt7bz/9U4X5EL6DlrLUMBKcYyvFJfK17dKUhe/YPZSngMhqw==";
const BINDINGS_INTEGRITY = "sha512-x/7CA6+n20joFvjk0GpUYn01XNbARAe4UwnUsGp/LnE+xaCM1DJjAq6dhI/ZiMmVdgbyVn1ukNeXPrhQ8GhTIQ==";
const PROVENANCE_COMMIT = "71f9723f70f065af79670ac6269ab51729fcfb5e";

/** Venue contracts (`environments.ts` of 0.12.0, line 170 for ExchangeV3; venue report 2026-10-05 F-46, F-48). */
const EXCHANGE_V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
const CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

/** Observed ids and their `/clob-markets` bodies (committed captures, `test/fixtures/venue/protocol-v2/`, S-L01 and its V1 twin). */
const V2_UP = "663574927012476832975694178961957910328055987427402067619466963999000625152";
const V2_DOWN = "663574927012476832975694178961957910328055987427402067619466963999000625153";
const V2_CONDITION = "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000";
const V1_UP = "25070934348813416902477876984955073880416401960631253331845590271167412497744";
const V1_DOWN = "111614563957165270026378011809694313565736745512637881727398424401624030147043";
const V1_CONDITION = "0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a";
/** The documentation's V2 example id (S-D16 line 174) and its YES/NO condition (F-44). */
const V2_DOCS_YES = "651150819117105875331414918119047680898421632356043490229292782433651916800";
const V2_DOCS_CONDITION = "0x017089ce3ba22aaa0a4cba8250b8c8e1eb000000000000000000000000000000";

/** The ten SDK port members (`sdk-port.ts`). */
const PORT_MEMBERS = [
  "account",
  "createLimitOrder",
  "postOrder",
  "postOrders",
  "cancelOrder",
  "cancelOrders",
  "cancelMarketOrders",
  "cancelAll",
  "fetchOrder",
  "closeSubscriptions",
] as const;

let tripwire: NetworkTripwire | undefined;
afterEach(() => {
  vi.useRealTimers();
  if (tripwire !== undefined) {
    tripwire.uninstall();
    expect(tripwire.refused()).toEqual([]);
    tripwire = undefined;
  }
});

async function capture(name: string): Promise<Readonly<Record<string, unknown>>> {
  const text = await readFile(resolve(REPO_ROOT, "test/fixtures/venue/protocol-v2", name), "utf8");
  return JSON.parse(text) as Readonly<Record<string, unknown>>;
}

async function capturedMarkets(): Promise<ContractMarket[]> {
  return [
    { conditionId: V2_CONDITION, clobMarket: await capture("clob-markets-v2.jsonc") },
    { conditionId: V1_CONDITION, clobMarket: await capture("clob-markets-v1.jsonc") },
  ];
}

function market(conditionId: string, tickSize: number, negRisk: boolean, assetIds: readonly string[]): ContractMarket {
  return { conditionId, clobMarket: { mts: tickSize, nr: negRisk, t: assetIds.map((t, index) => ({ t, o: index === 0 ? "Yes" : "No" })) } };
}

/** A venue client over the REAL SDK, behind a tripwire answering from `markets` (and `other`). */
async function realSdkClient(
  markets: readonly ContractMarket[],
  other?: (request: ContractRequest) => Response | Promise<Response> | undefined,
  factory = createPinnedSdkFactoryForContract(),
): Promise<{ client: SecureVenueClient; probe: MockSignerProbe; requests: () => readonly ContractRequest[] }> {
  const venue = contractVenueResponder({ markets, ...(other === undefined ? {} : { other }) });
  tripwire = installNetworkTripwire({ responder: venue.responder });
  const { handle, probe } = createMockSignerHandle();
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle, wallet: MOCK_SIGNER_ADDRESS }, factory);
  return { client, probe, requests: venue.requests };
}

/** A persisted-shape signed order (mock signature: never valid), to drive the POST paths. */
function persistedEnvelope(): SignedOrderEnvelope {
  const envelope = SignedOrderEnvelope.fromPersistedPayload({
    builder: BYTES32_ZERO,
    expiration: 0,
    maker: MOCK_SIGNER_ADDRESS,
    makerAmount: "5200000",
    metadata: BYTES32_ZERO,
    orderType: "GTC",
    salt: "12345",
    side: "BUY",
    signature: `0x${"00".repeat(65)}`,
    signatureType: 0,
    signer: MOCK_SIGNER_ADDRESS,
    takerAmount: "10000000",
    timestamp: "1767225600000",
    tokenId: V2_UP,
  });
  if (envelope === undefined) throw new Error("fixture envelope refused");
  return envelope;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------

describe("1. the pin: exactly 0.12.0, with the recorded integrity and provenance; zod did not move", () => {
  it("package.json pins 0.12.0 exactly; the lockfile resolves only 0.12.0 of the client and the bindings, with the recorded integrity", async () => {
    const manifest = JSON.parse(await readFile(resolve(REPO_ROOT, "packages/polymarket-secure/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@polymarket/client"]).toBe("0.12.0");
    const lock = await readFile(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain(`  '@polymarket/client@0.12.0':\n    resolution: {integrity: ${CLIENT_INTEGRITY}}`);
    expect(lock).toContain(`  '@polymarket/bindings@0.12.0':\n    resolution: {integrity: ${BINDINGS_INTEGRITY}}`);
    expect([...new Set(lock.match(/'@polymarket\/(?:client|bindings)@[^'(]+/gu) ?? [])].sort()).toEqual([
      "'@polymarket/bindings@0.12.0",
      "'@polymarket/client@0.12.0",
    ]);
  });

  it("ADR-020 §7: the SDK resolves the repository's one zod, 4.4.3, and no second zod exists", async () => {
    const lock = await readFile(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    const snapshot = (key: string): string => {
      const start = lock.indexOf(`\n  ${key}:\n`, lock.indexOf("\nsnapshots:\n"));
      expect(start).toBeGreaterThan(0);
      const end = lock.indexOf("\n\n", start + 1);
      return lock.slice(start, end);
    };
    expect(snapshot("'@polymarket/client@0.12.0(typescript@5.9.3)'")).toContain("      zod: 4.4.3\n");
    expect(snapshot("'@polymarket/client@0.12.0(typescript@5.9.3)'")).toContain("      '@polymarket/bindings': 0.12.0\n");
    expect(`${snapshot("'@polymarket/bindings@0.12.0'")}\n`).toContain("      zod: 4.4.3\n");
    expect([...new Set(lock.match(/^ {2}zod@[^:]+:/gmu) ?? [])]).toEqual(["  zod@4.4.3:"]);
  });

  it("the runbook records the same integrity and the npm provenance commit", async () => {
    const runbook = await readFile(resolve(REPO_ROOT, "docs/runbooks/signer.md"), "utf8");
    expect(runbook).toContain(CLIENT_INTEGRITY);
    expect(runbook).toContain(BINDINGS_INTEGRITY);
    expect(runbook).toContain(PROVENANCE_COMMIT);
    expect(runbook).toContain("pinned to **exactly `0.12.0`**");
  });
});

// ---------------------------------------------------------------------------

describe("2. F-47: the order's EIP-712 domain follows the id's reserved bits", () => {
  async function domainFor(markets: readonly ContractMarket[], assetId: string, side: "BUY" | "SELL" = "BUY") {
    const { client, probe } = await realSdkClient(markets);
    const outcome = await client.createLimitOrder({ assetId, side, price: "0.52", size: "10" });
    // The mock refused the venue domain: no order was signed.
    expect(outcome).toMatchObject({ kind: "FAILED" });
    const requests = probe.signTypedDataRequests;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.refused).toBe(true);
    await client.close();
    return requests[0] as NonNullable<(typeof requests)[0]>;
  }

  it.each([
    ["the observed V2 Up id (75 digits)", V2_UP, "BUY"],
    ["the observed V2 Down id", V2_DOWN, "SELL"],
  ] as const)("%s → ExchangeV3, domain version \"3\", chain 137 (%s)", async (_label, assetId, side) => {
    const request = await domainFor(await capturedMarkets(), assetId, side);
    expect(request.primaryType).toBe("Order");
    expect(request.domain).toEqual({ name: "Polymarket CTF Exchange", version: "3", chainId: "137", verifyingContract: EXCHANGE_V3 });
    expect(request.message).toMatchObject({ tokenId: assetId, side: side === "BUY" ? "0" : "1", signatureType: "0", maker: MOCK_SIGNER_ADDRESS, signer: MOCK_SIGNER_ADDRESS, builder: BYTES32_ZERO, metadata: BYTES32_ZERO });
  });

  it("the documentation's V2 example id → ExchangeV3, \"3\"", async () => {
    const request = await domainFor([market(V2_DOCS_CONDITION, 0.01, false, [V2_DOCS_YES])], V2_DOCS_YES);
    expect(request.domain).toMatchObject({ version: "3", verifyingContract: EXCHANGE_V3 });
  });

  it.each([
    ["the observed V1 Up id", V1_UP],
    ["the observed V1 Down id", V1_DOWN],
  ] as const)("%s → the CTF Exchange, domain version \"2\"", async (_label, assetId) => {
    const request = await domainFor(await capturedMarkets(), assetId);
    expect(request.domain).toEqual({ name: "Polymarket CTF Exchange", version: "2", chainId: "137", verifyingContract: CTF_EXCHANGE });
    expect(request.message).toMatchObject({ tokenId: assetId });
  });

  it("a V1 id on a neg-risk market → the Neg Risk exchange, \"2\"", async () => {
    const request = await domainFor([market(V1_CONDITION, 0.01, true, [V1_UP, V1_DOWN])], V1_UP);
    expect(request.domain).toMatchObject({ version: "2", verifyingContract: NEG_RISK_EXCHANGE });
  });

  it("a V2 id on a market flagged neg-risk is still ExchangeV3, \"3\": the id's bits decide before `negRisk`", async () => {
    const request = await domainFor([market(V2_CONDITION, 0.01, true, [V2_UP, V2_DOWN])], V2_UP);
    expect(request.domain).toMatchObject({ version: "3", verifyingContract: EXCHANGE_V3 });
  });
});

// ---------------------------------------------------------------------------

describe("3. F-53: a V2 SELL's balance and allowance read uses CONDITIONAL-V2", () => {
  async function balanceRead(assetType: string, assetId: string) {
    const venue = contractVenueResponder({
      markets: [],
      other: (request) => (request.method === "GET" && request.path === "/balance-allowance" ? jsonResponse(200, { balance: "0", allowances: {} }) : undefined),
    });
    tripwire = installNetworkTripwire({ responder: venue.responder });
    const reading = await readBalanceAllowanceWithPinnedSdk({ assetType, assetId });
    const reads = venue.requests().filter((request) => request.path === "/balance-allowance");
    return { reading, reads };
  }

  it("the pinned SDK's AssetType has CONDITIONAL-V2 next to COLLATERAL and CONDITIONAL", () => {
    expect([...pinnedSdkAssetTypes()].sort()).toEqual(["COLLATERAL", "CONDITIONAL", "CONDITIONAL-V2"]);
  });

  it("a V2 position SELL: the SDK sends `asset_type=CONDITIONAL-V2` with the position id, EOA signature type 0", async () => {
    const { reading, reads } = await balanceRead("CONDITIONAL-V2", V2_UP);
    expect(reading).toBe("RESOLVED");
    expect(reads).toHaveLength(1);
    const query = new URLSearchParams(reads[0]?.query);
    expect(Object.fromEntries(query)).toEqual({ asset_type: "CONDITIONAL-V2", token_id: V2_UP, signature_type: "0" });
  });

  it("guard: a CTF (V1) SELL keeps CONDITIONAL", async () => {
    const { reading, reads } = await balanceRead("CONDITIONAL", V1_UP);
    expect(reading).toBe("RESOLVED");
    expect(new URLSearchParams(reads[0]?.query).get("asset_type")).toBe("CONDITIONAL");
  });

  it("the SDK's own SELL selector (shipped JS): BUY → COLLATERAL, a V2-shaped id → CONDITIONAL-V2, else CONDITIONAL, with the predicate that picks domain \"3\"", async () => {
    const dist = pinnedSdkDistDirectory();
    const chunks = (await readdir(dist)).filter((name) => name.endsWith(".js"));
    const texts = await Promise.all(chunks.map((name) => readFile(resolve(dist, name), "utf8")));
    const shipped = texts.filter((text) => text.includes("AssetType.CONDITIONAL_V2"));
    expect(shipped).toHaveLength(1);
    const bundle = shipped[0] ?? "";
    // resolveBalanceAllowanceAssetType (actions/orders/allowance.ts lines 8-20), minified.
    const selectors = [
      ...bundle.matchAll(
        /function [\w$]+\(([\w$]+),([\w$]+)\)\{return \1===OrderSide\.BUY\?AssetType\.COLLATERAL:([\w$]+)\(\2\)\?AssetType\.CONDITIONAL_V2:AssetType\.CONDITIONAL\}/gu,
      ),
    ];
    expect(selectors).toHaveLength(1);
    // createUnsignedOrder's domain choice (actions/orders/orders.ts lines 31-33), whose behaviour section 2 pins at runtime.
    const domains = [...bundle.matchAll(/protocolVersion:([\w$]+)\([\w$]+\.assetId\)\?"3":"2"/gu)];
    expect(domains).toHaveLength(1);
    expect(selectors[0]?.[3]).toBe(domains[0]?.[1]);
  });

  it("guard: an asset type the SDK does not know is refused before anything is sent (as 0.11.0 refused CONDITIONAL-V2)", async () => {
    const { reading, reads } = await balanceRead("CONDITIONAL-V3", V2_UP);
    expect(reading).toBe("REFUSED_BEFORE_SENDING");
    expect(reads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("4. `place*` is never touched: the venue client reads only the ten port members of the real SDK client", () => {
  it("every venue-client method, run over the real SDK, reads port members only", async () => {
    const recording = createRecordingPinnedSdkFactoryForContract();
    const disabled = (): Response => jsonResponse(503, { error: "Trading is currently disabled. Check polymarket.com for updates" });
    const { client } = await realSdkClient(await capturedMarkets(), disabled, recording.factory);
    await client.createLimitOrder({ assetId: V2_UP, side: "BUY", price: "0.52", size: "10" });
    await client.postOrder(persistedEnvelope());
    await client.postOrders([persistedEnvelope()]);
    await client.cancelOrder("order-1");
    await client.cancelOrders(["order-1", "order-2"]);
    await client.cancelMarketOrders({ assetId: V2_UP });
    await client.cancelAll();
    await client.fetchOrder("order-1");
    await client.close();
    const accessed = new Set(recording.accessed());
    expect([...accessed].filter((name) => /^place/u.test(name))).toEqual([]);
    expect([...accessed].filter((name) => !(PORT_MEMBERS as readonly string[]).includes(name))).toEqual([]);
    // Positive control: the recorder saw every member the methods use.
    expect([...accessed].sort()).toEqual([...PORT_MEMBERS].sort());
  });
});

// ---------------------------------------------------------------------------

describe("5. the transport: ky retries a DELETE or GET twice on a network error, never a POST; 10 s per attempt; a timeout is not retried", () => {
  async function failingTransport() {
    let attempts = 0;
    const fixture = await realSdkClient(await capturedMarkets(), () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    });
    const count = async (run: (client: SecureVenueClient) => Promise<unknown>): Promise<{ attempts: number; outcome: unknown }> => {
      attempts = 0;
      const outcome = await run(fixture.client);
      return { attempts, outcome };
    };
    return { ...fixture, count };
  }

  it.each([
    ["cancelOrder (DELETE /order)", (client: SecureVenueClient) => client.cancelOrder("order-1")],
    ["cancelOrders (DELETE /orders)", (client: SecureVenueClient) => client.cancelOrders(["order-1"])],
    ["cancelMarketOrders (DELETE /cancel-market-orders)", (client: SecureVenueClient) => client.cancelMarketOrders({ assetId: V2_UP })],
    ["cancelAll (DELETE /cancel-all)", (client: SecureVenueClient) => client.cancelAll()],
  ] as const)("%s: 3 attempts (1 + 2 retries), then UNKNOWN / TRANSPORT_FAILURE", { timeout: 30_000 }, async (_label, run) => {
    const { count, requests } = await failingTransport();
    const { attempts, outcome } = await count(run);
    expect(attempts).toBe(3);
    expect(outcome).toMatchObject({ kind: "UNKNOWN", error: { kind: "TRANSPORT_FAILURE", effect: "UNKNOWN" } });
    expect(new Set(requests().filter((request) => request.path !== "/auth/api-keys").map((request) => request.method))).toEqual(new Set(["DELETE"]));
  });

  it("fetchOrder (GET /data/order/{id}): 3 attempts, then FAILED / TRANSPORT_FAILURE", { timeout: 30_000 }, async () => {
    const { count } = await failingTransport();
    const { attempts, outcome } = await count((client) => client.fetchOrder("order-1"));
    expect(attempts).toBe(3);
    expect(outcome).toMatchObject({ kind: "FAILED", error: { kind: "TRANSPORT_FAILURE" } });
  });

  it.each([
    ["postOrder (POST /order)", (client: SecureVenueClient) => client.postOrder(persistedEnvelope())],
    ["postOrders (POST /orders)", (client: SecureVenueClient) => client.postOrders([persistedEnvelope()])],
  ] as const)("%s: exactly 1 attempt, then UNKNOWN / TRANSPORT_FAILURE", async (_label, run) => {
    const { count } = await failingTransport();
    const { attempts, outcome } = await count(run);
    expect(attempts).toBe(1);
    const first = Array.isArray(outcome) ? (outcome as unknown[])[0] : outcome;
    expect(first).toMatchObject({ kind: "UNKNOWN", error: { kind: "TRANSPORT_FAILURE", effect: "UNKNOWN" } });
  });

  it.each([
    ["postOrder (POST)", (client: SecureVenueClient) => client.postOrder(persistedEnvelope())],
    ["cancelOrder (DELETE)", (client: SecureVenueClient) => client.cancelOrder("order-1")],
    ["fetchOrder (GET)", (client: SecureVenueClient) => client.fetchOrder("order-1")],
  ] as const)("%s: an attempt that never answers times out at exactly 10 000 ms and is not retried", async (_label, run) => {
    let attempts = 0;
    let started: () => void = () => undefined;
    const { client } = await realSdkClient(await capturedMarkets(), () => {
      attempts += 1;
      started();
      return new Promise<Response>(() => undefined);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settled: unknown;
    const pending = run(client).then((outcome) => {
      settled = outcome;
    });
    // ky arms its timer just before it calls fetch, so time is counted from here.
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toMatchObject({ error: { kind: "TRANSPORT_FAILURE", effect: "UNKNOWN" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("6. createLimitOrder's metadata cache: 10 minutes for the market, the client's life for the token's condition", () => {
  const T0 = Date.parse("2026-10-06T00:00:00.000Z");

  it("one read each; the market is read again at exactly +600 000 ms, the condition never", async () => {
    const { client, requests } = await realSdkClient(await capturedMarkets());
    vi.useFakeTimers({ toFake: ["Date"] });
    const order = { assetId: V2_UP, side: "BUY", price: "0.52", size: "10" } as const;
    const reads = (): { byToken: number; market: number } => ({
      byToken: requests().filter((request) => request.path.startsWith("/markets-by-token/")).length,
      market: requests().filter((request) => request.path.startsWith("/clob-markets/")).length,
    });
    vi.setSystemTime(T0);
    await client.createLimitOrder(order);
    await client.createLimitOrder(order);
    expect(reads()).toEqual({ byToken: 1, market: 1 });
    vi.setSystemTime(T0 + 599_999);
    await client.createLimitOrder(order);
    expect(reads()).toEqual({ byToken: 1, market: 1 });
    vi.setSystemTime(T0 + 600_000);
    await client.createLimitOrder(order);
    expect(reads()).toEqual({ byToken: 1, market: 2 });
    vi.setSystemTime(T0 + 24 * 3_600_000);
    await client.createLimitOrder(order);
    expect(reads()).toEqual({ byToken: 1, market: 3 });
  });

  it("a price off the cached tick grid forces one fresh market read, then refuses locally", async () => {
    const { client, requests, probe } = await realSdkClient(await capturedMarkets());
    await client.createLimitOrder({ assetId: V2_UP, side: "BUY", price: "0.52", size: "10" });
    const outcome = await client.createLimitOrder({ assetId: V2_UP, side: "BUY", price: "0.525", size: "10" });
    expect(outcome).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" } });
    expect(requests().filter((request) => request.path.startsWith("/clob-markets/"))).toHaveLength(2);
    expect(probe.signTypedDataCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("7. rounding: the real SDK's signed amounts, per tick size, and the venue client's exact cross-check (ADR-034 D2.4)", () => {
  /** The SDK's quote decimals per tick (`resolveRoundingConfig`, `actions/orders/context.ts` lines 14-31); size is 2 for every tick. */
  const AMOUNT_DECIMALS: Readonly<Record<string, number>> = { "0.1": 3, "0.01": 4, "0.005": 5, "0.0025": 6, "0.001": 5, "0.0001": 6 };
  const CASES = [
    { tick: 0.1, price: "0.5" },
    { tick: 0.01, price: "0.52" },
    { tick: 0.005, price: "0.515" },
    { tick: 0.0025, price: "0.5025" },
    { tick: 0.001, price: "0.523" },
    { tick: 0.0001, price: "0.5237" },
  ] as const;
  /** On the 0.01 grid: "10", "12.34", "7.5". Off it: "10.129", "0.999", "123.456789". */
  const SIZES = ["10", "10.129", "0.999", "123.456789", "7.5", "12.34"] as const;
  const ON_GRID = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u;

  /** `decimal` × 10^6, exactly (at most 6 fraction digits here). */
  function baseUnits(decimal: string): bigint {
    const [whole = "0", fraction = ""] = decimal.split(".");
    return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
  }

  function expected(price: string, size: string, tick: number, side: "BUY" | "SELL"): { makerAmount: string; takerAmount: string } {
    const shares = (baseUnits(size) / 10_000n) * 10_000n;
    const quantum = 10n ** BigInt(6 - (AMOUNT_DECIMALS[String(tick)] ?? Number.NaN));
    const quote = ((baseUnits(price) * shares) / (1_000_000n * quantum)) * quantum;
    const [maker, taker] = side === "BUY" ? [quote, shares] : [shares, quote];
    return { makerAmount: maker.toString(), takerAmount: taker.toString() };
  }

  /** A fake SDK whose createLimitOrder returns a fixture-signed order carrying exactly `amounts`. */
  function fakeSigning(amounts: { makerAmount: string; takerAmount: string }) {
    return createFakeSdkFactory({
      createLimitOrder: async (request, signer) => {
        const fields = request as unknown as { assetId: string; side: string };
        const message = {
          salt: "1",
          maker: MOCK_SIGNER_ADDRESS,
          signer: MOCK_SIGNER_ADDRESS,
          signatureType: 0,
          tokenId: fields.assetId,
          ...amounts,
          side: fields.side,
          timestamp: "1767225600000",
          metadata: BYTES32_ZERO,
          builder: BYTES32_ZERO,
        };
        const signature = await signer.signTypedData({
          domain: { name: MOCK_FIXTURE_DOMAIN_NAME, version: "0", chainId: 31337 },
          primaryType: "FixtureOrder",
          types: { FixtureOrder: [{ name: "salt", type: "uint256" }] },
          message,
        });
        return { ...message, expiration: 0, orderType: "GTC", signature };
      },
    }).factory;
  }

  /**
   * A venue client over the REAL SDK, plus the real SDK port beneath it: the port is asked directly for what the
   * client itself now refuses to ask (an off-grid size), so the SDK's own rounding (A F-101) stays pinned.
   */
  async function realSdkClientWithPort(markets: readonly ContractMarket[]): Promise<{
    client: SecureVenueClient;
    probe: MockSignerProbe;
    signDirectly: (request: { assetId: string; side: "BUY" | "SELL"; price: string; size: string }) => Promise<void>;
  }> {
    const real = createPinnedSdkFactoryForContract();
    let port: Awaited<ReturnType<typeof real>> | undefined;
    const { client, probe } = await realSdkClient(markets, undefined, async (args) => {
      port = await real(args);
      return port;
    });
    return {
      client,
      probe,
      signDirectly: async (request) => {
        if (port === undefined) throw new Error("the SDK port was never built");
        // The SDK's OrderSide is the string enum {BUY: "BUY", SELL: "SELL"}; the request is the SDK's own shape.
        await port.createLimitOrder(request as never).catch(() => undefined);
      },
    };
  }

  /** `amount` moved by `delta` base units. */
  function nudged(amount: string, delta: bigint): string {
    return (BigInt(amount) + delta).toString();
  }

  for (const { tick, price } of CASES) {
    it(`tick ${String(tick)}: the SDK floors shares to 2 decimals and the quote to ${String(AMOUNT_DECIMALS[String(tick)])}; the client asks only on-grid sizes and accepts exactly the SDK's amounts, never one base unit off`, async () => {
      const condition = `0x${"c".repeat(63)}${String(CASES.findIndex((entry) => entry.tick === tick))}`;
      const { client, probe, signDirectly } = await realSdkClientWithPort([market(condition, tick, false, [V2_UP, V2_DOWN])]);
      // Warm the port (the client builds it on its first call), with an on-grid order.
      await client.createLimitOrder({ assetId: V2_UP, side: "BUY", price, size: "10" });
      for (const side of ["BUY", "SELL"] as const) {
        for (const size of SIZES) {
          const want = expected(price, size, tick, side);
          // 1. The real SDK's own rounding, asked directly (A F-101): shares floored to 0.01, the quote to Amount decimals.
          const before = probe.signTypedDataRequests.length;
          await signDirectly({ assetId: V2_UP, side, price, size });
          const direct = probe.signTypedDataRequests[before]?.message;
          expect({ makerAmount: direct?.["makerAmount"], takerAmount: direct?.["takerAmount"] }, `SDK ${side} ${size} @ ${price}`).toEqual(want);
          // 2. The venue client.
          const viaClient = await client.createLimitOrder({ assetId: V2_UP, side, price, size });
          if (!ON_GRID.test(size)) {
            // ADR-034 D2.4: an off-grid size is refused before the SDK is called; nothing more is signed.
            expect(viaClient, `${side} ${size}`).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" } });
            expect(probe.signTypedDataRequests.length, `${side} ${size}`).toBe(before + 1);
            continue;
          }
          // On the grid, the SDK needs no rounding (A F-102): the amounts are shares and shares × price, exactly.
          const signed = probe.signTypedDataRequests[before + 1]?.message;
          expect({ makerAmount: signed?.["makerAmount"], takerAmount: signed?.["takerAmount"] }, `client ${side} ${size} @ ${price}`).toEqual(want);
          const exactShares = baseUnits(size).toString();
          expect(side === "BUY" ? want.takerAmount : want.makerAmount).toBe(exactShares);
          // The cross-check accepts exactly these amounts, and refuses each one moved by one base unit.
          for (const [label, amounts, kind] of [
            ["exact", want, "SIGNED"],
            ["makerAmount + 1", { ...want, makerAmount: nudged(want.makerAmount, 1n) }, "FAILED"],
            ["makerAmount − 1", { ...want, makerAmount: nudged(want.makerAmount, -1n) }, "FAILED"],
            ["takerAmount + 1", { ...want, takerAmount: nudged(want.takerAmount, 1n) }, "FAILED"],
            ["takerAmount − 1", { ...want, takerAmount: nudged(want.takerAmount, -1n) }, "FAILED"],
          ] as const) {
            const checking = await createSecureVenueClientForTesting(
              { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle },
              fakeSigning(amounts),
            );
            expect((await checking.createLimitOrder({ assetId: V2_UP, side, price, size })).kind, `${label}: ${side} ${size} @ ${price}`).toBe(kind);
          }
        }
      }
      await client.close();
    });
  }

  it("CO3-N1 at the adapter (ADR-034 D2.4): the SDK would sign 10.129 as 10.12 shares, so the client refuses 10.129 before the SDK runs", async () => {
    const { client, probe, signDirectly } = await realSdkClientWithPort(await capturedMarkets());
    await client.createLimitOrder({ assetId: V2_UP, side: "BUY", price: "0.52", size: "10" });
    const before = probe.signTypedDataRequests.length;
    await signDirectly({ assetId: V2_UP, side: "BUY", price: "0.52", size: "10.129" });
    expect(probe.signTypedDataRequests[before]?.message["takerAmount"]).toBe("10120000");
    expect(await client.createLimitOrder({ assetId: V2_UP, side: "BUY", price: "0.52", size: "10.129" })).toMatchObject({
      kind: "FAILED",
      error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" },
    });
    expect(probe.signTypedDataRequests.length).toBe(before + 1);
  });
});
