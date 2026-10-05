/**
 * The gateway process's RUN MODE, as the series-admission feed reads it
 * (`ROLLOVER-1`; ADR-030 Decision 2.1: "Admission runs only when the run mode
 * is PAPER or BACKTEST. In any other mode it refuses to start.").
 *
 * The gateway itself trades nothing and has no mode of its own; it records the
 * public data a trader of SOME mode consumes. The mode admission is judged
 * against is therefore the process environment's, read the way the trader
 * reads it (`packages/trading-core/src/safety.ts`):
 *
 * - `RUN_MODE`, when set and non-empty, is the mode;
 * - otherwise `MAX_RUN_MODE`, when set and non-empty — a process allowed a
 *   live mode and not told which one is judged at its ceiling, so a live
 *   ceiling refuses admission;
 * - otherwise `PAPER`: the repository's own default (`MAX_RUN_MODE=PAPER`,
 *   AGENTS.md), which this file does not weaken.
 *
 * The value is returned VERBATIM; whether admission may run in it is
 * `@polymarket-bot/universe`'s `admissionRunModeProblem`, which refuses
 * everything but exactly `PAPER` and `BACKTEST` (an unknown spelling included).
 */

/** The repository's default maximum run mode (AGENTS.md: `MAX_RUN_MODE=PAPER`). */
export const REPOSITORY_DEFAULT_RUN_MODE = "PAPER";

export function gatewayRunMode(env: Readonly<Record<string, string | undefined>>): string {
  const runMode = Object.hasOwn(env, "RUN_MODE") ? env["RUN_MODE"] : undefined;
  if (runMode !== undefined && runMode !== "") return runMode;
  const ceiling = Object.hasOwn(env, "MAX_RUN_MODE") ? env["MAX_RUN_MODE"] : undefined;
  if (ceiling !== undefined && ceiling !== "") return ceiling;
  return REPOSITORY_DEFAULT_RUN_MODE;
}
