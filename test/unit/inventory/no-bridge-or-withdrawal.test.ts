/**
 * WP-300 acceptance 4: no autonomous bridge or withdrawal is implemented
 * (handoff §9.14 "No autonomous deposit, withdrawal, or bridge behavior in
 * v1"; §3.2; ADR-006 §8). Pinned three ways:
 *
 * 1. API surface: the operation vocabulary is exactly seven types, none of
 *    them TRANSFER, WITHDRAW, BRIDGE or DEPOSIT; such types are refused; no
 *    plan may carry a recipient/destination-like field; the executor port
 *    receives only the allowed keys; the package exports no such name.
 * 2. Source scan: the package's code (comments and string literals removed)
 *    names no bridge/withdraw/deposit/transfer/relayer identifier, no network
 *    or environment API, no key material, no URL, and imports only the two
 *    layer-0 workspace packages; every hex address literal is a documented
 *    venue contract.
 * 3. The scanner is proven to fire on planted violations (non-vacuity).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as inventory from "../../../packages/inventory/src/index.js";
import {
  ApprovalTracker,
  DOCUMENTED_VENUE_CONTRACTS,
  WALLET_OPERATION_TYPES,
  WALLET_PLAN_KEYS,
  WalletOperationManager,
  type WalletOperationSubmission,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, CTF_EXCHANGE, NO, PUSD, USDC_E, YES, requestTokens, seededBook } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../../packages/inventory/src");

const FORBIDDEN_WORDS = /bridge|withdraw|deposit|transfer|relayer|offramp_to|recipient|destination/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

/** Remove comments, then string/template literals; what remains is code. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

interface ScanFinding {
  readonly file: string;
  readonly rule: string;
  readonly match: string;
}

function scan(file: string, text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const code = codeOnly(text);
  const add = (rule: string, re: RegExp, target: string) => {
    for (const m of target.matchAll(re)) findings.push({ file, rule, match: m[0] });
  };
  add("forbidden-identifier", new RegExp(FORBIDDEN_WORDS.source, "gi"), code);
  add("network-or-environment", /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bprocess\b|\brequire\s*\(|globalThis|Date\.now|new Date|Math\.random/g, code);
  add("key-material", /private[_-]?key|mnemonic|seed[_-]?phrase|signTransaction|sendTransaction|eth_|rpcUrl|\bsigner\b/gi, code);
  add("url", /\b(?:https?|wss?):\/\//gi, text);
  for (const m of text.matchAll(/^\s*(?:import|export)[^"';]*from\s+["']([^"']+)["']/gm)) {
    const specifier = m[1] ?? "";
    if (!specifier.startsWith("./") && specifier !== "@polymarket-bot/decimal" && specifier !== "@polymarket-bot/domain") {
      findings.push({ file, rule: "import", match: specifier });
    }
  }
  const documented = new Set(DOCUMENTED_VENUE_CONTRACTS.map((c) => c.address.toLowerCase()));
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
    if (!documented.has(m[0].toLowerCase())) findings.push({ file, rule: "undocumented-address", match: m[0] });
  }
  return findings;
}

describe("API surface: no bridge, deposit, withdrawal or transfer", () => {
  it("the operation vocabulary is exactly the seven on-account operations", () => {
    expect(WALLET_OPERATION_TYPES).toEqual([
      "APPROVE_ERC20",
      "APPROVE_ERC1155",
      "SPLIT",
      "MERGE",
      "REDEEM",
      "WRAP_COLLATERAL",
      "UNWRAP_COLLATERAL",
    ]);
    for (const type of WALLET_OPERATION_TYPES) expect(type).not.toMatch(/TRANSFER|WITHDRAW|BRIDGE|DEPOSIT/);
  });

  it("the package exports no bridge/withdraw/deposit/transfer name", () => {
    for (const name of Object.keys(inventory)) expect(name).not.toMatch(/bridge|withdraw|deposit|transfer/i);
  });

  const manager = () =>
    new WalletOperationManager({
      requestToken: requestTokens(),
      book: seededBook({ [PUSD]: "100", [YES]: "10", [NO]: "10", [USDC_E]: "10" }),
      approvals: new ApprovalTracker(),
      executor: { submit: () => Promise.resolve({ status: "NOT_SENT" }) },
      reconciler: { request: () => undefined },
    });

  it("refuses TRANSFER, WITHDRAW, BRIDGE and DEPOSIT operation types", () => {
    const m = manager();
    for (const type of ["TRANSFER", "WITHDRAW", "WITHDRAWAL", "BRIDGE", "DEPOSIT", "transfer"]) {
      const result = m.plan({ type, operationId: `x-${type}`, accountRef: ACCOUNT, amount: "1", to: CTF_EXCHANGE });
      expect(result.ok, type).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe("WALLET_OP_UNSUPPORTED_TYPE");
    }
  });

  const validPlans: Readonly<Record<string, Record<string, unknown>>> = {
    APPROVE_ERC20: { type: "APPROVE_ERC20", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "1" },
    APPROVE_ERC1155: { type: "APPROVE_ERC1155", accountRef: ACCOUNT, spender: CTF_EXCHANGE },
    SPLIT: { type: "SPLIT", accountRef: ACCOUNT, conditionId: CONDITION, amount: "1" },
    MERGE: { type: "MERGE", accountRef: ACCOUNT, conditionId: CONDITION, amount: "1" },
    REDEEM: { type: "REDEEM", accountRef: ACCOUNT, conditionId: CONDITION, resolution: "NO_WIN", noAmount: "1" },
    WRAP_COLLATERAL: { type: "WRAP_COLLATERAL", accountRef: ACCOUNT, amount: "1" },
    UNWRAP_COLLATERAL: { type: "UNWRAP_COLLATERAL", accountRef: ACCOUNT, amount: "1" },
  };

  it("no plan of any type may carry a recipient, destination, chain or bridge field", () => {
    for (const type of WALLET_OPERATION_TYPES) {
      const base = validPlans[type];
      if (base === undefined) throw new Error(type);
      expect(manager().plan({ ...base, operationId: `ok-${type}` }).ok, `${type} valid`).toBe(true);
      for (const extra of ["to", "recipient", "destination", "receiver", "chainId", "bridge", "toAddress", "beneficiary"]) {
        const result = manager().plan({ ...base, operationId: `bad-${type}-${extra}`, [extra]: CTF_EXCHANGE });
        expect(result.ok, `${type} + ${extra}`).toBe(false);
        if (!result.ok) expect(result.refusal.code).toBe("INVENTORY_INVALID_INPUT");
      }
    }
  });

  it("the executor port receives only the allowed keys of each type", async () => {
    for (const type of WALLET_OPERATION_TYPES) {
      const received: WalletOperationSubmission[] = [];
      const m = new WalletOperationManager({
        requestToken: requestTokens(),
        book: seededBook({ [PUSD]: "100", [YES]: "10", [NO]: "10", [USDC_E]: "10" }),
        approvals: new ApprovalTracker(),
        executor: {
          submit: (submission) => {
            received.push(submission);
            return Promise.resolve({ status: "NOT_SENT" });
          },
        },
        reconciler: { request: () => undefined },
      });
      const base = validPlans[type];
      if (base === undefined) throw new Error(type);
      expect(m.plan({ ...base, operationId: `s-${type}` }).ok).toBe(true);
      await m.submit(`s-${type}`);
      expect(received).toHaveLength(1);
      const keys = Object.keys(received[0] ?? {});
      for (const key of keys) expect(WALLET_PLAN_KEYS[type]).toContain(key);
      expect(Object.isFrozen(received[0])).toBe(true);
    }
  });
});

describe("source scan: packages/inventory/src", () => {
  const files = sourceFiles(SRC);

  it("finds the package's source files", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("has no bridge/withdrawal path, network or environment access, key material, URL or foreign import", () => {
    const findings = files.flatMap((file) => scan(file.slice(SRC.length + 1), readFileSync(file, "utf8")));
    expect(findings).toEqual([]);
  });

  it("the scanner fires on planted violations (non-vacuity)", () => {
    const planted = [
      "export function bridgeFunds() {}",
      "const x = withdrawAll;",
      "await fetch(url);",
      "const k = process.env.KEY;",
      "import { SecureClient } from \"@polymarket/client\";",
      "const signer = privateKey;",
      "const endpoint = \"https://polygon-rpc.example\";",
      "const spender = \"0x1111111111111111111111111111111111111111\";",
      "planTransfer(to);",
    ];
    for (const line of planted) expect(scan("planted.ts", line).length, line).toBeGreaterThan(0);
    // ...and stays quiet on the same words inside comments and strings.
    expect(scan("quiet.ts", '// no bridge, no withdrawal\nconst s = "transfer";\n')).toEqual([]);
  });
});
