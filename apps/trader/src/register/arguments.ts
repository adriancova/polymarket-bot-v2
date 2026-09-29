/**
 * The registration command's flags (`REGISTER-1`).
 *
 * Every flag is REQUIRED and none is defaulted, for the trader's own reason
 * (`packages/trading-core/src/config.ts`): a value nobody chose is a value
 * nobody is accountable for. The venue facts among them — the question, the
 * `negRisk` flag, the order delay, the lifecycle state, the outcome labels —
 * are what the operator reads off the market; this command invents none.
 *
 * Parsing is `node:util`'s `parseArgs` in strict mode (an unknown flag, a
 * positional or a missing value is a usage error), plus one rule it does not
 * have: a flag given TWICE is refused rather than resolved to the last value.
 * Every problem is reported at once.
 *
 * One leading `--` is dropped: `pnpm run register -- --template …` hands the
 * script the `--` itself (measured with the repository's pnpm), and
 * `parseArgs` would otherwise read it as the end of the options and every
 * flag after it as a positional.
 */

import { parseArgs } from "node:util";

import { MARKET_LIFECYCLE_STATES, type MarketLifecycleStateValue } from "@polymarket-bot/storage-postgres";

/**
 * The lifecycle states a registration may state. `RESOLVED` is excluded: the
 * catalog requires a resolution time with it (`markets_resolved_has_timestamp`),
 * which `registerMarket` does not record, and nothing trades a resolved market.
 */
export const REGISTRABLE_LIFECYCLE_STATES: readonly MarketLifecycleStateValue[] = Object.freeze(
  MARKET_LIFECYCLE_STATES.filter((state) => state !== "RESOLVED"),
);

/** Exactly `--help` or `-h`, anywhere: the usage text, and nothing else runs. */
export function asksForHelp(argv: readonly string[]): boolean {
  return argv.some((token) => token === "--help" || token === "-h");
}

export interface RegisterArguments {
  readonly template: string;
  readonly out: string;
  readonly instanceName: string;
  readonly questionTitle: string;
  readonly negRisk: boolean;
  readonly tradingDelaySeconds: number;
  readonly lifecycleState: MarketLifecycleStateValue;
  readonly yesLabel: string;
  readonly noLabel: string;
  readonly codeCommit: string;
  readonly createdBy: string;
}

export type ParsedArguments =
  | { readonly ok: true; readonly arguments: RegisterArguments }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Every flag the command takes: all strings, all required. */
const OPTIONS = {
  template: { type: "string" },
  out: { type: "string" },
  "instance-name": { type: "string" },
  "question-title": { type: "string" },
  "neg-risk": { type: "string" },
  "trading-delay-seconds": { type: "string" },
  "lifecycle-state": { type: "string" },
  "yes-label": { type: "string" },
  "no-label": { type: "string" },
  "code-commit": { type: "string" },
  "created-by": { type: "string" },
} as const;

type StringFlag = keyof typeof OPTIONS;

const STRING_FLAGS: readonly StringFlag[] = [
  "template",
  "out",
  "instance-name",
  "question-title",
  "neg-risk",
  "trading-delay-seconds",
  "lifecycle-state",
  "yes-label",
  "no-label",
  "code-commit",
  "created-by",
];

/** The largest `integer` column value (`trading_delay_seconds`). */
const MAX_INTEGER_COLUMN = 2_147_483_647;

/** Parses the command line. TOTAL: never throws. */
export function parseRegisterArguments(argv: readonly string[]): ParsedArguments {
  let values: Partial<Record<StringFlag, string>>;
  const repeated: string[] = [];
  try {
    const parsed = parseArgs({
      args: argv[0] === "--" ? argv.slice(1) : [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) repeated.push(`--${token.name} is given more than once`);
      seen.add(token.name);
    }
    values = {};
    for (const flag of STRING_FLAGS) {
      const value = parsed.values[flag];
      if (typeof value === "string") values[flag] = value;
    }
  } catch (cause) {
    return { ok: false, problems: [cause instanceof Error ? cause.message : String(cause)] };
  }

  const problems: string[] = [...new Set(repeated)];
  const required = (flag: StringFlag): string => {
    const value = values[flag];
    if (value === undefined) {
      problems.push(`--${flag} is required`);
      return "";
    }
    if (value.trim() === "") problems.push(`--${flag} must not be empty`);
    return value;
  };

  const template = required("template");
  const out = required("out");
  const instanceName = required("instance-name");
  const questionTitle = required("question-title");
  const negRiskText = required("neg-risk");
  const delayText = required("trading-delay-seconds");
  const lifecycleText = required("lifecycle-state");
  const yesLabel = required("yes-label");
  const noLabel = required("no-label");
  const codeCommit = required("code-commit");
  const createdBy = required("created-by");

  let negRisk = false;
  if (negRiskText === "true") negRisk = true;
  else if (negRiskText !== "false" && values["neg-risk"] !== undefined) {
    problems.push(`--neg-risk must be exactly true or false, not ${JSON.stringify(negRiskText)}`);
  }

  let tradingDelaySeconds = 0;
  if (values["trading-delay-seconds"] !== undefined) {
    const delay = /^(?:0|[1-9][0-9]*)$/u.test(delayText) ? Number(delayText) : Number.NaN;
    if (!Number.isSafeInteger(delay) || delay > MAX_INTEGER_COLUMN) {
      problems.push(
        `--trading-delay-seconds must be a whole number of seconds from 0 to ` +
          `${String(MAX_INTEGER_COLUMN)}, not ${JSON.stringify(delayText)}`,
      );
    } else {
      tradingDelaySeconds = delay;
    }
  }

  const lifecycleState = REGISTRABLE_LIFECYCLE_STATES.find((state) => state === lifecycleText);
  if (lifecycleState === undefined && values["lifecycle-state"] !== undefined) {
    problems.push(
      `--lifecycle-state must be one of ${REGISTRABLE_LIFECYCLE_STATES.join(", ")}, not ` +
        JSON.stringify(lifecycleText),
    );
  }

  if (problems.length > 0 || lifecycleState === undefined) return { ok: false, problems };
  return {
    ok: true,
    arguments: {
      template,
      out,
      instanceName,
      questionTitle,
      negRisk,
      tradingDelaySeconds,
      lifecycleState,
      yesLabel,
      noLabel,
      codeCommit,
      createdBy,
    },
  };
}
