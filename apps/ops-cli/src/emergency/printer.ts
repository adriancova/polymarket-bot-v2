/**
 * Explicit output (WP-330 design requirement 1). A command the gate permitted
 * prints what will happen (PLAN), what happened (RESULT) and what is not
 * known (UNKNOWN), in that order, then the OUTCOME with its exit code; a
 * section it prints is never left empty silently: an empty one says "none".
 *
 * Not every invocation reaches a command (WP-330 r1, WP330-V1-03):
 *
 * - stopped BEFORE any command runs (a usage error, no audit log, an INVOKED
 *   record that cannot be written, the signer gate's refusal), it prints no
 *   PLAN, RESULT or UNKNOWN: only what stopped it (the usage, AUDIT, RUN
 *   MODE, and stop-heartbeat's GUIDANCE), that nothing was read or sent, and
 *   the OUTCOME;
 * - stopped PART-WAY (its ACTING record cannot be written; an unexpected
 *   failure), it prints the sections it reached, what stopped it, and the
 *   OUTCOME.
 */

import type { OutputPort } from "./ports.js";

export const SECTIONS = Object.freeze({
  RUN_MODE: "RUN MODE",
  PLAN: "PLAN (what will happen)",
  CONFIRMATION: "CONFIRMATION",
  RESULT: "RESULT (what happened)",
  UNKNOWN: "UNKNOWN (what is not known)",
  GUIDANCE: "GUIDANCE",
  AUDIT: "AUDIT",
  OUTCOME: "OUTCOME",
} as const);

export type SectionName = (typeof SECTIONS)[keyof typeof SECTIONS];

export class Printer {
  readonly #out: OutputPort;
  readonly #printed: string[] = [];

  constructor(out: OutputPort) {
    this.#out = out;
  }

  /** Every line printed so far (for the tests). */
  lines(): readonly string[] {
    return Object.freeze([...this.#printed]);
  }

  raw(text: string): void {
    for (const line of text.split("\n")) {
      this.#printed.push(line);
      this.#out.line(line);
    }
  }

  section(name: SectionName, items: readonly string[]): void {
    this.raw(`${name}:`);
    if (items.length === 0) this.raw("  - none");
    for (const item of items) this.raw(`  - ${item}`);
  }
}
