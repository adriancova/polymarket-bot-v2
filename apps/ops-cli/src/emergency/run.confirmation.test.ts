/**
 * Work-plan WP-330 acceptance 3: "Destructive actions require confirmation or
 * explicit noninteractive flag" (design requirement 2): a typed confirmation
 * that names the scope, or `--confirm <scope>` naming it exactly. A bare
 * `--yes` is not enough; `--dry-run` shows the plan without acting.
 *
 * Every refusal is pinned by what did NOT happen: no cancel reached the venue,
 * no lease was revoked, and no ACTING record was written.
 */

import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scopeText } from "./confirmation.js";
import { EXIT_CODES } from "./exit-codes.js";
import { parseArguments, type DestructiveCommand } from "./grammar.js";
import { ACCOUNT, args, CONDITION, DESTRUCTIVE_REASON, fakeLeases, harness, LEASE_ID, order, phases, TOKEN_YES, typedPrompt, type FakeLeases, type Harness } from "./harness.test-support.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

interface Case {
  readonly command: DestructiveCommand;
  readonly operands: readonly string[];
  readonly scope: string;
  /** A scope that names something else of the same kind. */
  readonly otherScope: string;
}

const CASES: readonly Case[] = [
  { command: "cancel-order", operands: ["o-1"], scope: `cancel-order:o-1@${ACCOUNT}`, otherScope: `cancel-order:o-2@${ACCOUNT}` },
  { command: "cancel-market", operands: [CONDITION], scope: `cancel-market:${CONDITION}@${ACCOUNT}`, otherScope: `cancel-market:0x${"d".repeat(64)}@${ACCOUNT}` },
  { command: "cancel-all", operands: [], scope: `cancel-all:${ACCOUNT}`, otherScope: "cancel-all:acct-other" },
  { command: "stop-heartbeat", operands: [], scope: `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`, otherScope: `stop-heartbeat:${ACCOUNT}:01a10bef-6200-7000-8000-00000000ffff` },
];

function setUp(): { readonly h: Harness; readonly leases: FakeLeases } {
  const h = harness();
  h.venue.add(order("o-1"), order("o-2"));
  return { h, leases: fakeLeases() };
}

/** Did anything destructive happen? */
function acted(h: Harness, leases: FakeLeases): boolean {
  const cancels = ["cancelOrder", "cancelOrders", "cancelMarketOrders", "cancelAll"].some((method) => h.venue.callsOf(method).length > 0);
  return cancels || leases.revoked.length > 0 || h.audit.records.some((record) => record.phase === "ACTING");
}

describe("acceptance 3: a destructive command acts only on a scoped confirmation", () => {
  for (const testCase of CASES) {
    const argv = (...extra: string[]): string[] => args(testCase.command, ...testCase.operands, ...DESTRUCTIVE_REASON, ...extra);

    describe(testCase.command, () => {
      it("no --confirm and no terminal: CONFIRMATION_REFUSED, nothing done, and the operator is told the exact flag", async () => {
        const { h, leases } = setUp();
        const outcome = await runOpsCli(h.deps(argv(), { leases: leases.factory }));
        expect(outcome.exitName).toBe("CONFIRMATION_REFUSED");
        expect(outcome.exitCode).toBe(EXIT_CODES.CONFIRMATION_REFUSED);
        expect(acted(h, leases)).toBe(false);
        expect(h.text()).toContain(`pass --confirm ${testCase.scope}`);
        expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
      });

      it("--confirm naming ANOTHER scope of the same kind: refused, nothing done", async () => {
        const { h, leases } = setUp();
        const outcome = await runOpsCli(h.deps(argv("--confirm", testCase.otherScope), { leases: leases.factory }));
        expect(outcome.exitName).toBe("CONFIRMATION_REFUSED");
        expect(acted(h, leases)).toBe(false);
        expect(h.text()).toContain(`it must be exactly ${testCase.scope}`);
      });

      it("WP-330 r1 (WP330-V1-06): the scope names the account, so the --confirm a script uses for one account is refused under another", async () => {
        const forAccount = parseArguments(argv("--confirm", "x"));
        if (forAccount.kind !== "COMMAND") throw new Error("expected a command");
        const accepted = scopeText(forAccount.command, testCase.command === "stop-heartbeat" ? LEASE_ID : null);
        expect(accepted).toBe(testCase.scope);
        const { h, leases } = setUp();
        const otherAccount = [testCase.command, ...testCase.operands, ...DESTRUCTIVE_REASON, "--account", "acct-other", "--operator", "operator-ana", "--confirm", accepted];
        const outcome = await runOpsCli(h.deps(otherAccount, { leases: leases.factory }));
        expect(outcome.exitName).toBe("CONFIRMATION_REFUSED");
        expect(acted(h, leases)).toBe(false);
      });

      it("--confirm naming the scope exactly: it acts, with the ACTING record written first", async () => {
        const { h, leases } = setUp();
        const outcome = await runOpsCli(h.deps(argv("--confirm", testCase.scope), { leases: leases.factory }));
        expect(outcome.exitName).toBe("COMPLETED");
        expect(acted(h, leases)).toBe(true);
        expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
        expect(h.audit.records[1]?.detail["scope"]).toBe(testCase.scope);
        expect(h.audit.records[1]?.detail["confirmedVia"]).toBe("FLAG");
      });

      it("a bare --yes (or -y, --force, --non-interactive) is a usage error: nothing is evaluated or done", async () => {
        for (const flag of ["--yes", "-y", "--force", "--non-interactive", "--yes=true"]) {
          const { h, leases } = setUp();
          const outcome = await runOpsCli(h.deps(argv(flag), { leases: leases.factory }));
          expect(outcome.exitName, flag).toBe("USAGE");
          expect(outcome.exitCode).toBe(EXIT_CODES.USAGE);
          expect(acted(h, leases)).toBe(false);
          expect(h.touched).toEqual([]);
          expect(leases.opened).toBe(0);
          expect(h.text()).toContain("a bare yes names no scope");
        }
      });

      it("typed interactively, exactly: it acts; the question names the scope", async () => {
        const { h, leases } = setUp();
        const prompt = typedPrompt(`  ${testCase.scope}  `);
        const outcome = await runOpsCli(h.deps(argv(), { leases: leases.factory, prompt }));
        expect(outcome.exitName).toBe("COMPLETED");
        expect(prompt.questions).toHaveLength(1);
        expect(prompt.questions[0]).toContain(testCase.scope);
        expect(h.audit.records[1]?.detail["confirmedVia"]).toBe("TYPED");
      });

      it("typed interactively: 'yes', another scope, or nothing at all: refused, nothing done", async () => {
        for (const answer of ["yes", "y", testCase.otherScope, "", null]) {
          const { h, leases } = setUp();
          const outcome = await runOpsCli(h.deps(argv(), { leases: leases.factory, prompt: typedPrompt(answer) }));
          expect(outcome.exitName, String(answer)).toBe("CONFIRMATION_REFUSED");
          expect(acted(h, leases)).toBe(false);
        }
      });

      it("--confirm with a terminal: the flag decides alone, and the operator is never asked", async () => {
        const { h, leases } = setUp();
        const prompt = typedPrompt(testCase.scope);
        const outcome = await runOpsCli(h.deps(argv("--confirm", testCase.otherScope), { leases: leases.factory, prompt }));
        expect(outcome.exitName).toBe("CONFIRMATION_REFUSED");
        expect(prompt.questions).toEqual([]);
      });

      it("--dry-run shows the plan and the exact --confirm value, and does nothing, even with a matching --confirm", async () => {
        const { h, leases } = setUp();
        const outcome = await runOpsCli(h.deps(argv("--dry-run", "--confirm", testCase.scope), { leases: leases.factory }));
        expect(outcome.exitName).toBe("DRY_RUN");
        expect(outcome.exitCode).toBe(EXIT_CODES.DRY_RUN);
        expect(acted(h, leases)).toBe(false);
        expect(h.text()).toContain(`scope to confirm: ${testCase.scope}`);
        expect(h.text()).toContain("the --confirm given names this scope: it would be accepted");
        expect(h.text()).toContain("PLAN (what will happen):");
      });
    });
  }

  it("cancel-market's scope includes the asset when one is given: the market-wide scope does not confirm it", async () => {
    const { h, leases } = setUp();
    const outcome = await runOpsCli(h.deps(args("cancel-market", CONDITION, "--asset", TOKEN_YES, ...DESTRUCTIVE_REASON, "--confirm", `cancel-market:${CONDITION}@${ACCOUNT}`), { leases: leases.factory }));
    expect(outcome.exitName).toBe("CONFIRMATION_REFUSED");
    expect(h.text()).toContain(`cancel-market:${CONDITION}:${TOKEN_YES}@${ACCOUNT}`);
  });

  it("stop-heartbeat's scope is the lease read now: a confirmation for a lease since replaced never matches", async () => {
    const h = harness();
    const leases = fakeLeases();
    const stale = `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`;
    leases.lease = { ...(leases.lease as NonNullable<FakeLeases["lease"]>), fencingLeaseId: "01a10bef-6200-7000-8000-00000000beef", fencingToken: "43" };
    const outcome = await runOpsCli(h.deps(args("stop-heartbeat", ...DESTRUCTIVE_REASON, "--confirm", stale), { leases: leases.factory }));
    expect(outcome.exitName).toBe("CONFIRMATION_REFUSED");
    expect(leases.revoked).toEqual([]);
  });
});
