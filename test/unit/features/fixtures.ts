/**
 * Root-tree fixtures for the WP-160 acceptance tests.
 *
 * Deliberately a SEPARATE copy from the package-internal fixture
 * (`packages/features/src/testing/fixture.ts`): the root test tree imports
 * only the package's `exports` entry module (the WP-150 replay-golden
 * precedent), and a deep import of a test helper would bypass that boundary
 * (dependency-direction §3 F16's spirit). All summary lines and expected
 * values are hand-computed here, independently of the package.
 */

export const MARKET = "018f4d2e-0000-7000-8000-000000000001";
export const TOKEN = "123456";
export const EPOCH = "018f4d2e-0000-7000-8000-0000000000aa";

export function bookText(): string {
  return [
    "polymarket-bot/order-book/v1",
    `market ${MARKET}`,
    `token ${TOKEN}`,
    `epoch ${EPOCH}`,
    "generation 3",
    "lastIngestSeq 42",
    "venueBookHash abc123",
    "tickSize 0.01",
    "bestBid 0.48 100",
    "bestAsk 0.52 80",
    "spread 0.04",
    "depth bids 3 350 asks 2 200",
    "bids 3",
    "0.48 100",
    "0.47 50",
    "0.45 200",
    "asks 2",
    "0.52 80",
    "0.53 120",
  ].join("\n");
}

/** The full valid input, fresh objects on every call. */
export function validInput(): Record<string, unknown> {
  return {
    subject: { internalMarketId: MARKET, tokenId: TOKEN },
    asOf: "2026-09-03T12:00:00Z",
    trigger: { gatewayEpoch: EPOCH, ingestSeq: "42" },
    config: {
      depthLevels: [1, 2, 5],
      executableShares: ["50", "150", "1000"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    book: {
      serializedBook: bookText(),
      lastEventAt: "2026-09-03T11:59:59.500Z",
    },
    trades: {
      lastEventAt: "2026-09-03T11:59:58Z",
      window: [
        { price: "0.49", size: "99", takerSide: "BID", observedAt: "2026-09-03T11:58:30Z" },
        { price: "0.5", size: "10", takerSide: "BID", observedAt: "2026-09-03T11:59:10Z" },
        { price: "0.51", size: "5", takerSide: "ASK", observedAt: "2026-09-03T11:59:30Z" },
        { price: "0.52", size: "2", observedAt: "2026-09-03T11:59:40Z" },
      ],
    },
    reference: {
      binance: {
        symbol: "BTCUSDT",
        lastEventAt: "2026-09-03T11:59:59.900Z",
        trades: [
          { price: "100000", observedAt: "2026-09-03T11:59:20Z" },
          { price: "100500", observedAt: "2026-09-03T11:59:29.700Z" },
          { price: "100250", observedAt: "2026-09-03T11:59:54.900Z" },
          { price: "100750", observedAt: "2026-09-03T11:59:59.800Z" },
        ],
        topOfBook: { bidPrice: "100700", bidSize: "2", askPrice: "100800", askSize: "1.5" },
      },
      coinbase: {
        symbol: "BTC-USD",
        lastEventAt: "2026-09-03T11:59:59Z",
        trades: [
          { price: "100100", observedAt: "2026-09-03T11:59:25Z" },
          { price: "100600", observedAt: "2026-09-03T11:59:58Z" },
        ],
        topOfBook: { bidPrice: "100600", bidSize: "3", askPrice: "100800", askSize: "0.7" },
      },
      chainlink: {
        lastEventAt: "2026-09-03T11:59:30Z",
        twaps: [
          { feedId: "btc.usd", value: "100400", windowSeconds: 30, windowEndAt: "2026-09-03T11:59:30Z" },
          { feedId: "btc.usd", value: "100100", windowSeconds: 30, windowEndAt: "2026-09-03T11:59:00Z" },
          { feedId: "btc.usd", value: "100300", windowSeconds: 60, windowEndAt: "2026-09-03T11:59:00Z" },
        ],
      },
    },
    lifecycle: {
      openedAt: "2026-09-03T11:45:00Z",
      closesAt: "2026-09-03T12:15:00Z",
      referenceOpenPrice: "100200",
    },
    quality: {
      activeIncidents: [
        { incidentId: "inc-2", reasonCode: "FEED_GAP", severity: "PAGE", feedId: "reference.binance" },
        { incidentId: "inc-1", reasonCode: "STALE_FEED", severity: "NOTIFY" },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Independent BigInt rational oracle (a DIFFERENT primitive than decimal.js)
// ---------------------------------------------------------------------------

/** A canonical decimal string as an exact rational (BigInt numerator/denominator). */
export function toRational(decimal: string): { readonly n: bigint; readonly d: bigint } {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const dot = unsigned.indexOf(".");
  const digits = dot === -1 ? unsigned : unsigned.slice(0, dot) + unsigned.slice(dot + 1);
  const scale = dot === -1 ? 0 : unsigned.length - dot - 1;
  const n = BigInt(digits) * (negative ? -1n : 1n);
  return { n, d: 10n ** BigInt(scale) };
}

interface QuotientAt {
  readonly q: bigint;
  readonly doubledRemainder: bigint;
  readonly divisor: bigint;
}

function quotientAt(n: bigint, d: bigint, shift: number): QuotientAt {
  const scaledN = shift >= 0 ? n * 10n ** BigInt(shift) : n;
  const scaledD = shift >= 0 ? d : d * 10n ** BigInt(-shift);
  return { q: scaledN / scaledD, doubledRemainder: (scaledN % scaledD) * 2n, divisor: scaledD };
}

/**
 * `n / d` rendered at `sig` significant digits, ROUND_HALF_EVEN, canonical
 * decimal spelling (trailing fractional zeros stripped). Pure BigInt long
 * division — shares no code with `decimal.js`.
 */
export function divSigHalfEven(numerator: bigint, denominator: bigint, sig: number): string {
  let n = numerator;
  let d = denominator;
  let negative = false;
  if (n < 0n) {
    negative = true;
    n = -n;
  }
  if (d < 0n) {
    negative = !negative;
    d = -d;
  }
  if (d === 0n) throw new Error("division by zero");
  if (n === 0n) return "0";

  // Choose the shift so the integer quotient has exactly `sig` digits.
  let shift = sig - (n.toString().length - d.toString().length) - 1;
  let at = quotientAt(n, d, shift);
  while (at.q.toString().length < sig) {
    shift += 1;
    at = quotientAt(n, d, shift);
  }
  while (at.q.toString().length > sig) {
    shift -= 1;
    at = quotientAt(n, d, shift);
  }

  // ROUND_HALF_EVEN on the remainder.
  let q = at.q;
  if (at.doubledRemainder > at.divisor || (at.doubledRemainder === at.divisor && q % 2n === 1n)) {
    q += 1n;
    if (q.toString().length > sig) {
      // 999… rolled over to 1000…: renormalize.
      q /= 10n;
      shift -= 1;
    }
  }

  // Render q × 10^-shift canonically.
  const digits = q.toString();
  let text: string;
  if (shift <= 0) {
    text = digits + "0".repeat(-shift);
  } else if (digits.length > shift) {
    const integerPart = digits.slice(0, digits.length - shift);
    const fractionPart = digits.slice(digits.length - shift).replace(/0+$/u, "");
    text = fractionPart.length === 0 ? integerPart : `${integerPart}.${fractionPart}`;
  } else {
    const fractionPart = ("0".repeat(shift - digits.length) + digits).replace(/0+$/u, "");
    text = fractionPart.length === 0 ? "0" : `0.${fractionPart}`;
  }
  return negative && text !== "0" ? `-${text}` : text;
}

/** `a / b` for canonical decimal strings, at 34 significant digits HALF_EVEN. */
export function oracleDivide34(a: string, b: string): string {
  const ra = toRational(a);
  const rb = toRational(b);
  return divSigHalfEven(ra.n * rb.d, ra.d * rb.n, 34);
}

// ---------------------------------------------------------------------------
// Independent pure-JS SHA-256 (a DIFFERENT primitive than node:crypto)
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 (lowercase hex) of a string's UTF-8 bytes, implemented from FIPS 180-4. */
export function sha256HexOracle(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setBigUint64(paddedLength - 8, BigInt(bitLength));

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64).fill(0);
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(offset + t * 4);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, dd, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (dd + temp1) >>> 0;
      dd = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + dd) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }
  return h.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}
