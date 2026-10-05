/**
 * A bound on how long the CLI waits for one answer from a port it does not
 * control: a venue call, a venue read, the emergency credential source, the
 * venue binding, and the release of the venue client or the lease store
 * ({@link releaseWithin}). An emergency command that waits forever helps
 * nobody: past the operator's `venueAnswerBoundMs` (configuration, no
 * default) the call is treated as UNANSWERED, which every caller reads as
 * UNKNOWN or as a missing read, never as success or as empty.
 *
 * The bound is wall time (a real timer, cleared as soon as the answer
 * arrives), not the injected clock: the clock measures the budget's waits,
 * this measures a call in flight. A late answer is dropped (its rejection is
 * observed, so it never surfaces as an unhandled one); the request it belongs
 * to may still have been applied, which is why UNANSWERED is UNKNOWN.
 */

export type Bounded<T> = { readonly kind: "ANSWERED"; readonly value: T } | { readonly kind: "UNANSWERED" };

const UNANSWERED: Bounded<never> = Object.freeze({ kind: "UNANSWERED" });

/** Resolve with the call's answer, or `UNANSWERED` after `boundMs`; reject with the call's own rejection. */
export async function withinBound<T>(boundMs: number, call: () => Promise<T>): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED), boundMs);
  });
  const answer = Promise.resolve()
    .then(call)
    .then((value): Bounded<T> => Object.freeze({ kind: "ANSWERED" as const, value }));
  answer.catch(() => undefined);
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** How a resource release ended. Cleanup only: it never changes a command's outcome. */
export type ReleaseResult = "RELEASED" | "UNANSWERED" | "FAILED";

/**
 * Release a resource (the venue client, the lease store), waiting at most
 * `boundMs` (WP-330 r1, CX330-R1-02). A release is cleanup, not an action: a
 * close that never settles must neither hold an emergency CLI open nor keep
 * its OUTCOME record from being written. TOTAL: it never throws.
 */
export async function releaseWithin(boundMs: number, release: () => Promise<unknown>): Promise<ReleaseResult> {
  try {
    return (await withinBound(boundMs, release)).kind === "ANSWERED" ? "RELEASED" : "UNANSWERED";
  } catch {
    return "FAILED";
  }
}
