/**
 * The two server-side scripts the Redis Streams implementation relies on.
 *
 * Both exist for atomicity, not for speed. Splitting either into separate
 * round trips would open a window in which the transport's own counters
 * disagree with the stream, and every conclusion this package draws about
 * missing events comes from those counters agreeing.
 */

/** Field name carrying an entry's publication ordinal. */
export const FIELD_SEQUENCE = "seq";

/** Field name carrying the encoded event envelope. */
export const FIELD_ENVELOPE = "env";

/**
 * Appends one envelope and stamps it with the next publication ordinal.
 *
 * `INCR` and `XADD` must be one atomic step. Two round trips would let a crash
 * between them burn an ordinal with no entry behind it, and a consumer would
 * then read a hole in the ordinals as events lost to retention — a hard resync
 * for an event that was never published.
 *
 * Trimming is exact (`MAXLEN` with no `~`) so the configured retention is a
 * bound rather than an approximation. ADR-003 calls retention "a safety
 * parameter, not a tuning knob", and a bound that is only approximately
 * enforced cannot be reasoned about when sizing it against the worst tolerated
 * trader restart.
 *
 * KEYS: `[1]` stream, `[2]` publication counter.
 * ARGV: `[1]` retention bound, `[2]` encoded envelope.
 */
export const PUBLISH_SCRIPT = `
local sequence = redis.call('INCR', KEYS[2])
local entryId = redis.call(
  'XADD', KEYS[1], 'MAXLEN', ARGV[1], '*',
  '${FIELD_SEQUENCE}', tostring(sequence),
  '${FIELD_ENVELOPE}', ARGV[2]
)
return { entryId, tostring(sequence) }
`;

/**
 * Reads everything needed to judge continuity and report §8.3 metrics.
 *
 * One atomic snapshot: a consumer that read the depth, the counter, and the
 * oldest entry in three separate calls could see a state that never existed —
 * for example a counter from before a trim and a first entry from after one —
 * and conclude that events were lost when they were not.
 *
 * The server's own clock is returned with it so that "oldest message age" is
 * not distorted by clock skew between the application host and the server.
 *
 * KEYS: `[1]` stream, `[2]` publication counter.
 * Returns: `[publishedTotal, depth, firstEntryId, firstSequence, lastEntryId,
 * serverSeconds, serverMicroseconds]`, with empty strings where the stream
 * holds no entries.
 */
export const STREAM_STATE_SCRIPT = `
local published = redis.call('GET', KEYS[2])
if not published then published = '0' end
local depth = redis.call('XLEN', KEYS[1])
local first = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1)
local last = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
local now = redis.call('TIME')
local firstEntryId = ''
local firstSequence = ''
if first[1] then
  firstEntryId = first[1][1]
  local fields = first[1][2]
  for i = 1, #fields, 2 do
    if fields[i] == '${FIELD_SEQUENCE}' then firstSequence = fields[i + 1] end
  end
end
local lastEntryId = ''
if last[1] then lastEntryId = last[1][1] end
return { published, tostring(depth), firstEntryId, firstSequence, lastEntryId, now[1], now[2] }
`;
