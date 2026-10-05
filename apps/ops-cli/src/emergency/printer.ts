/**
 * Explicit output (WP-330 design requirement 1): every command prints what
 * will happen (PLAN), what happened (RESULT) and what is not known (UNKNOWN),
 * then the OUTCOME with its exit code. Sections are printed in that order and
 * a section is never omitted: an empty one says "none".
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
