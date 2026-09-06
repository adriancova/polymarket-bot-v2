/**
 * The health source seam, exercised over a REAL loopback `node:http` server.
 *
 * ## What is and is not proven here
 *
 * PROVEN: the HTTP source really performs a request, really enforces its size
 * bound and its timeout, really refuses a non-200 and a non-JSON body, and
 * really drives the returned document through the ADR-020 door.
 *
 * NOT PROVEN, and not claimed: that a trader is on the other end. `apps/trader`
 * exposes no HTTP health endpoint today (see `health-source.ts`). The server in
 * this suite is a test fixture serving a document shaped like the trader's —
 * and the shape's fidelity is measured separately, in
 * `test/integration/control-api/trader-health-shape.test.ts`, against the REAL
 * `HealthState` class.
 *
 * No network leaves the machine: every server binds `127.0.0.1` on an ephemeral
 * port and is closed in `afterEach`.
 */

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  AbsentTraderHealthSource,
  HttpTraderHealthSource,
  InMemoryTraderHealthSource,
  TraderHealthCache,
} from "./health-source.js";
import { healthDocument } from "./testing/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function serve(
  handler: (respond: (status: number, body: string) => void) => void,
): Promise<string> {
  const server = createServer((_request, response) => {
    handler((status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${String(port)}/health`;
}

const options = (url: string, overrides: Partial<{ timeoutMs: number; maxBodyBytes: number }> = {}) => ({
  url,
  timeoutMs: 2000,
  maxBodyBytes: 1_048_576,
  ...overrides,
});

describe("AbsentTraderHealthSource", () => {
  it("says UNAVAILABLE and says WHY, so a blank dashboard has an explanation", async () => {
    const result = await new AbsentTraderHealthSource().read();
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") return;
    expect(result.detail).toContain("no trader health source is configured");
  });
});

describe("InMemoryTraderHealthSource", () => {
  it("parses the held document through the DOOR — it is not trusted", async () => {
    const source = new InMemoryTraderHealthSource(healthDocument());
    expect((await source.read()).outcome).toBe("OK");

    source.set({ runMode: "PAPER" });
    const refused = await source.read();
    expect(refused.outcome).toBe("REFUSED");
    if (refused.outcome !== "REFUSED") return;
    expect(refused.issues.length).toBeGreaterThan(0);
  });

  it("answers UNAVAILABLE when it holds nothing", async () => {
    const source = new InMemoryTraderHealthSource();
    expect((await source.read()).outcome).toBe("UNAVAILABLE");
    source.set(healthDocument());
    expect((await source.read()).outcome).toBe("OK");
    source.clear();
    expect((await source.read()).outcome).toBe("UNAVAILABLE");
  });
});

describe("HttpTraderHealthSource, over a real loopback server", () => {
  it("reads a valid document and returns it", async () => {
    const url = await serve((respond) => {
      respond(200, JSON.stringify(healthDocument()));
    });
    const result = await new HttpTraderHealthSource(options(url)).read();
    expect(result.outcome).toBe("OK");
    if (result.outcome !== "OK") return;
    expect(result.report.seams.reservations.reservedCollateral).toBe("12.50");
  });

  it("REFUSES a document the door rejects — a reachable source is not a trusted one", async () => {
    const url = await serve((respond) => {
      respond(200, JSON.stringify({ runMode: "PAPER" }));
    });
    const result = await new HttpTraderHealthSource(options(url)).read();
    expect(result.outcome).toBe("REFUSED");
  });

  it("REFUSES a non-JSON body", async () => {
    const url = await serve((respond) => {
      respond(200, "not json at all");
    });
    const result = await new HttpTraderHealthSource(options(url)).read();
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.detail).toContain("not JSON");
  });

  it.each([404, 500, 503])("treats HTTP %s as UNAVAILABLE, not as a report", async (status) => {
    const url = await serve((respond) => {
      respond(status, JSON.stringify(healthDocument()));
    });
    const result = await new HttpTraderHealthSource(options(url)).read();
    expect(result.outcome).toBe("UNAVAILABLE");
  });

  it("BOUNDS the response body and refuses an oversized one", async () => {
    const url = await serve((respond) => {
      respond(200, JSON.stringify(healthDocument()));
    });
    const result = await new HttpTraderHealthSource(options(url, { maxBodyBytes: 16 })).read();
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") return;
    expect(result.detail).toContain("bytes");
  });

  it("TIMES OUT rather than waiting forever", async () => {
    const url = await serve(() => {
      // Never respond. The request must give up on its own.
    });
    const result = await new HttpTraderHealthSource(options(url, { timeoutMs: 60 })).read();
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") return;
    expect(result.detail).toContain("did not answer within");
  });

  it("reports an unreachable source as data, never as a throw", async () => {
    // Port 1 on loopback: reserved, and nothing in this suite binds it.
    const result = await new HttpTraderHealthSource(
      options("http://127.0.0.1:1/health", { timeoutMs: 500 }),
    ).read();
    expect(result.outcome).toBe("UNAVAILABLE");
  });
});

describe("TraderHealthCache", () => {
  it("counts reads by outcome and retains the LAST GOOD report across a failure", async () => {
    const source = new InMemoryTraderHealthSource(healthDocument({ asOf: "2026-09-05T00:04:11.000Z" }));
    const cache = new TraderHealthCache(source);

    expect((await cache.refresh()).outcome).toBe("OK");
    expect(cache.available).toBe(true);
    expect(cache.last()?.asOf).toBe("2026-09-05T00:04:11.000Z");

    source.clear();
    expect((await cache.refresh()).outcome).toBe("UNAVAILABLE");
    // Still holding the last good one — an operator sees "the report I have is
    // from 00:04:11 and the last read failed", not an empty dashboard.
    expect(cache.available).toBe(true);
    expect(cache.last()?.asOf).toBe("2026-09-05T00:04:11.000Z");

    source.set({ nonsense: true });
    expect((await cache.refresh()).outcome).toBe("REFUSED");

    expect(cache.readCounts()).toEqual({ OK: 1, REFUSED: 1, UNAVAILABLE: 1 });
  });

  it("reports unavailable until the first successful read", async () => {
    const cache = new TraderHealthCache(new AbsentTraderHealthSource());
    expect(cache.available).toBe(false);
    expect(cache.last()).toBeUndefined();
    await cache.refresh();
    expect(cache.available).toBe(false);
    expect(cache.readCounts()).toEqual({ UNAVAILABLE: 1 });
  });
});
