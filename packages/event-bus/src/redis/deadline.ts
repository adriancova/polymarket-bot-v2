/**
 * A deadline on one Redis round trip (`OUTAGE-1`, `BOOT1-R7`).
 *
 * ## Why the transport needs its own
 *
 * `ioredis` bounds a command only in the cases it can SEE. It flushes its
 * queues with `MaxRetriesPerRequestError` after a number of reconnection
 * attempts, and that is enough when every reconnection is refused. It is not
 * enough in the outage `OUTAGE-1` measured by stopping the Redis container
 * under the real trader. Reconnections were ACCEPTED at the TCP level and then
 * died mid-handshake (EPIPE), and each accepted one reset the command queue.
 * The command that had been in flight when the connection dropped was left in
 * `ioredis`'s resend-on-reconnect queue, which no flush ever touches. A second
 * connection sat in a half-open handshake that never closed, so nothing queued
 * behind it was ever flushed either. The trader's pump awaited that command
 * and was still waiting 90 s later.
 *
 * So where a per-command timeout cannot be installed on the connection itself
 * — the dedicated connection that carries BLOCKING reads, whose legitimate
 * wait is the caller's `waitMs` — the round trip is raced against a timer
 * here. The deadline wraps the I/O only. A caller that awaits this and then
 * mutates state never mutates it for an operation it abandoned: when the timer
 * wins, the late reply (if one ever comes) is observed and dropped.
 */

/**
 * Resolves or rejects as `operation` does, unless `ms` elapse first — then
 * rejects with `expired()`.
 *
 * The abandoned `operation` may still settle later; its rejection is observed
 * here so it can never surface as an unhandled rejection.
 */
export async function withDeadline<T>(
  operation: Promise<T>,
  ms: number,
  expired: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(expired());
    }, ms);
  });
  void operation.catch(() => undefined);
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
