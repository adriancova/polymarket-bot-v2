/**
 * WP-280 acceptance 3: "No claim of replaying missed events is made."
 *
 * The venue does not deliver what a disconnected client missed
 * (`venue-facts.ts` RECONNECT_GUIDANCE), so the adapter must not offer, emit
 * or describe any way to obtain it. Pinned three ways:
 *
 * 1. API SURFACE. The exported names, the manager's public methods, the port's
 *    members (and the subscription call's single parameter) are pinned
 *    exactly, and none is named for a replay, a resume point, a cursor, an
 *    offset or a backfill.
 * 2. SOURCE SCAN. Every non-test source file under `user-stream/` is parsed
 *    with TypeScript: no identifier, property name or identifier-like string
 *    may be named that way, and every comment or string sentence that speaks
 *    of replaying, back-filling, re-delivering, catching up, resuming from a
 *    point, or missed events must be a negation.
 * 3. BEHAVIOUR. A reconnect sends the subscription frame with the markets and
 *    nothing else, and emits no event until one arrives on the new connection.
 *
 * NON-VACUOUS: the scan flags planted violations of every kind and passes
 * planted negations.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import * as userStream from "./index.js";
import { createUserStreamManager, RECONCILIATION_CAUSES, STREAM_LOSS_CAUSES, USER_STREAM_STATES, type UserStreamOutput } from "./manager.js";
import { PROJECTION_SHORTFALLS } from "./oms-projection.js";
import type { AuthenticatedUserSocketPort, UserSocketConnection, UserSocketHandlers } from "./socket-port.js";
import { ManualTimers } from "./testing/fake-socket-port.js";
import { FIXTURE_MARKET, LIVE_SHAPED_CONTEXT, openUserStream } from "./testing/harness.js";
import { DEFAULT_INITIAL_BACKOFF_MS } from "./venue-facts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

/** A NAME that would offer missed events. */
const FORBIDDEN_NAME = /replay|resum|backfill|back_fill|redeliver|re_deliver|catch_?up|cursor|since|offset|last_?(?:event|seen|seq)|from_?seq|missed/iu;
/** A SENTENCE that speaks of obtaining missed events; it must be a negation. */
const CLAIM = /replay|back-?fill|re-?deliver|catch(?:es|ing)?[ -]up|resum(?:e|es|ed|ing)\s+from|missed\s+(?:events?|messages?|updates?|changes?|trades?|orders?)/iu;
const NEGATION = /\b(?:no|not|never|nothing|none|cannot|without|neither|nor)\b|n't\b/iu;
const IDENTIFIER_LIKE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function sentences(text: string): string[] {
  const cleaned = text
    .replace(/^\s*\/\*\*?|\*\/\s*$/gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\*|\/\/)\s?/u, ""))
    .join("\n");
  return cleaned.split(/(?<=[.!?])\s+|\n\s*\n|\n\s*[-*]\s+/u).map((sentence) => sentence.replace(/\s+/gu, " ").trim());
}

function findings(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checkSentences = (where: string, body: string): void => {
    for (const sentence of sentences(body)) {
      if (CLAIM.test(sentence) && !NEGATION.test(sentence)) out.push(`${where}: "${sentence}"`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (FORBIDDEN_NAME.test(node.text)) out.push(`name ${node.text}`);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (IDENTIFIER_LIKE.test(node.text)) {
        if (FORBIDDEN_NAME.test(node.text)) out.push(`string ${node.text}`);
      } else {
        checkSentences("string", node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      checkSentences("comment", scanner.getTokenText());
    }
  }
  return out;
}

async function productionSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await productionSources(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("1. the API surface offers no way to obtain missed events", () => {
  it("the user-stream entry exports exactly these names", () => {
    expect(Object.keys(userStream).sort()).toEqual(
      [
        "C3_MATCHED_NOT_BROADCASTED",
        "DEFAULT_CONNECT_TIMEOUT_MS",
        "DEFAULT_INITIAL_BACKOFF_MS",
        "DEFAULT_MAX_BACKOFF_MS",
        "DEFAULT_STALE_AFTER_MS",
        "MAX_FRAME_CHARACTERS",
        "MAX_LIST_ENTRIES",
        "MAX_MESSAGES_PER_FRAME",
        "MAX_PENDING_RECONCILIATION_REQUESTS",
        "MAX_SUBSCRIBED_MARKETS",
        "ORDER_LIFECYCLE_TYPES",
        "ORDER_TYPES",
        "PING_INTERVAL_MS",
        "PROJECTION_SHORTFALLS",
        "RECONCILIATION_CAUSES",
        "RECONNECT_GUIDANCE",
        "STREAM_LOSS_CAUSES",
        "TRADER_SIDES",
        "UNRECOGNIZED_ORDER_STATUS",
        "USER_CHANNEL_URL",
        "USER_ORDER_STATUSES",
        "USER_SOCKET_CLOSE_CAUSES",
        "USER_STREAM_STATES",
        "USER_STREAM_TRANSITIONS",
        "USER_TRADE_STATUSES",
        "UserStreamConfigurationError",
        "createUserStreamManager",
        "isUserStreamSensitiveKey",
        "normalizeUserChannelFrame",
        "normalizeUserChannelMessage",
        "projectOrderEventForOms",
        "projectTradeEventForOms",
        "redactUserStreamPayload",
      ].sort(),
    );
    for (const name of Object.keys(userStream)) expect(name).not.toMatch(FORBIDDEN_NAME);
  });

  it("the manager's public methods are exactly these", () => {
    const manager = createUserStreamManager({
      runModeContext: LIVE_SHAPED_CONTEXT,
      transport: { connect: () => ({}) as never },
      timers: new ManualTimers(),
      markets: [FIXTURE_MARKET],
      onOutput: () => undefined,
    });
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager)).sort()).toEqual(
      [
        "acknowledgeReconciliationRequest",
        "addMarkets",
        "constructor",
        "diagnostics",
        "markets",
        "pendingReconciliationRequests",
        "removeMarkets",
        "start",
        "state",
        "stop",
        "subscriptionGeneration",
      ].sort(),
    );
    expect(Object.keys(manager)).toEqual([]);
  });

  it("every vocabulary the adapter emits is free of such names", () => {
    const vocabularies = [USER_STREAM_STATES, STREAM_LOSS_CAUSES, RECONCILIATION_CAUSES, PROJECTION_SHORTFALLS];
    for (const vocabulary of vocabularies) for (const value of vocabulary) expect(value).not.toMatch(FORBIDDEN_NAME);
  });

  it("the port's members are exactly these, and the subscription call takes the markets and nothing else", async () => {
    const text = await readFile(path.join(HERE, "socket-port.ts"), "utf8");
    const source = ts.createSourceFile("socket-port.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const members: Record<string, string[]> = {};
    let subscribeParameters: string[] = [];
    source.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      members[node.name.text] = node.members.map((member) => (member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : "?"));
      for (const member of node.members) {
        if (node.name.text === "UserSocketConnection" && ts.isMethodSignature(member) && member.name.getText(source) === "subscribe") {
          subscribeParameters = member.parameters.map((parameter) => parameter.name.getText(source));
        }
      }
    });
    expect(members).toEqual({
      UserSocketHandlers: ["opened", "frame", "closed"],
      UserSocketConnection: ["subscribe", "updateSubscription", "ping", "close"],
      AuthenticatedUserSocketPort: ["connect", "isAccountOwner"],
    });
    expect(subscribeParameters).toEqual(["markets"]);
  });
});

describe("2. no source names or describes a replay of missed events", () => {
  it("every non-test source file under user-stream/ is clean", async () => {
    const files = await productionSources(HERE);
    expect(files.map((file) => path.relative(HERE, file)).sort()).toEqual(
      expect.arrayContaining(["index.ts", "manager.ts", "normalize.ts", "oms-projection.ts", "socket-port.ts", "venue-facts.ts", "wire.ts"]),
    );
    const report: Record<string, string[]> = {};
    for (const file of files) {
      const found = findings(await readFile(file, "utf8"), file);
      if (found.length > 0) report[path.relative(HERE, file)] = found;
    }
    expect(report).toEqual({});
  });

  it.each([
    ["a doc claim", "/** Replays missed events after a reconnect. */ export const x = 1;"],
    ["a line-comment claim", "// backfills the gap from the venue\nexport const x = 1;"],
    ["a resume point in prose", "/** The stream resumes from the last event it saw. */ export const x = 1;"],
    ["a catch-up claim", "/** On reconnect the client catches up on what it missed. */ export const x = 1;"],
    ["a function name", "export function resumeFrom(): void {}"],
    ["a parameter name", "export function subscribe(markets: string[], cursor: string): void {}"],
    ["a property name", "export const request = { since: 1 };"],
    ["a last-event id", "export const lastEventId = 'x';"],
    ["an identifier-like string", 'export const kind = "REPLAYED";'],
    ["a string claim", 'export const note = "missed events are replayed on reconnect";'],
    ["a private method", "class A { #redeliver(): void {} }"],
  ])("NON-VACUOUS: flags %s", (_label, snippet) => {
    expect(findings(snippet, "planted.ts").length).toBeGreaterThan(0);
  });

  it.each([
    ["a negated doc", "/** This adapter never replays missed events. */ export const x = 1;"],
    ["a negated string", 'export const note = "The stream does not replay what was missed.";'],
    ["the venue's own guidance", "export const g = \"Updates do not replay every change missed during a disconnection. Then resume applying new stream events from that refreshed state.\";"],
    ["an unrelated word", "/** The subscription frame is sent on open. */ export const resubscribed = 1;"],
  ])("NON-VACUOUS: passes %s", (_label, snippet) => {
    expect(findings(snippet, "planted.ts")).toEqual([]);
  });
});

describe("3. a reconnect asks for nothing and synthesises nothing", () => {
  it("the new connection is sent the subscription frame with the markets, one argument, and nothing else", () => {
    const calls: { readonly method: string; readonly argumentCount: number; readonly args: unknown[] }[] = [];
    const connections: UserSocketHandlers[] = [];
    const transport: AuthenticatedUserSocketPort = {
      connect(handlers) {
        connections.push(handlers);
        const record =
          (method: string) =>
          (...args: unknown[]): void => {
            calls.push({ method, argumentCount: args.length, args });
          };
        return { subscribe: record("subscribe"), updateSubscription: record("updateSubscription"), ping: record("ping"), close: record("close") } as UserSocketConnection;
      },
    };
    const timers = new ManualTimers();
    const outputs: UserStreamOutput[] = [];
    const manager = createUserStreamManager({ runModeContext: LIVE_SHAPED_CONTEXT, transport, timers, markets: [FIXTURE_MARKET], onOutput: (output) => outputs.push(output) });
    manager.start();
    connections[0]?.opened();
    connections[0]?.closed("CLOSED_BY_PEER");
    timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    calls.length = 0;
    outputs.length = 0;
    connections[1]?.opened();
    expect(calls).toEqual([{ method: "subscribe", argumentCount: 1, args: [[FIXTURE_MARKET]] }]);
    expect(outputs.map((output) => output.kind)).toEqual(["STATE", "RECONCILIATION_REQUESTED"]);
  });

  it("no ORDER or TRADE output appears between a loss and the first frame on the new connection", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.drop("SERVER_ERROR");
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    h.timers.advance(5 * 60_000);
    expect(h.outputs.some((output) => output.kind === "ORDER" || output.kind === "TRADE")).toBe(false);
  });
});
