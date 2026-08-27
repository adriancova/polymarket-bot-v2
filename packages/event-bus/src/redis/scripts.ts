/**
 * The server-side scripts the Redis Streams implementation relies on.
 *
 * They exist for atomicity, not for speed. Splitting any of them into separate
 * round trips would open a window in which the transport's own counters
 * disagree with the stream, and every conclusion this package draws about
 * missing events comes from those counters agreeing.
 *
 * ## Why a script can leave state behind, and what is done about it
 *
 * A script is isolated, not transactional: Redis does **not** roll back the
 * commands a script already executed when a later one fails. So "put the two
 * mutations in one script" is not by itself enough to keep the publication
 * counter and the stream consistent — an append that fails after the counter
 * moved would burn an ordinal with no entry behind it, and the next consumer to
 * read across the hole would treat it as events lost to retention: a hard resync
 * and a phantom `messagesDropped` for an event that was never published.
 *
 * Every script here therefore
 *
 * 1. **prevalidates** everything it can before it mutates anything — key types,
 *    the counter's format, and the safe-integer ceiling — and returns a verdict
 *    instead of failing mid-way, and
 * 2. **guards each mutation with `redis.pcall`** and compensates the one that
 *    already landed if the second cannot, so a failed publish leaves both the
 *    counter and the stream exactly as it found them — which also means that
 *    **no irreversible mutation may run before the reversible ones have
 *    succeeded**. Retention trimming is irreversible (a trimmed entry cannot be
 *    put back), so it is the last step rather than a side effect of the append.
 */

/** Field name carrying an entry's publication ordinal. */
export const FIELD_SEQUENCE = "seq";

/** Field name carrying the encoded event envelope. */
export const FIELD_ENVELOPE = "env";

/**
 * Largest publication ordinal this implementation will mint.
 *
 * `Number.MAX_SAFE_INTEGER`. The ceiling is enforced **server-side, before the
 * append**, because refusing it afterwards would report a refusal for an event
 * that is already in the stream.
 */
export const MAX_PUBLICATION_ORDINAL = "9007199254740991";

/**
 * Verdicts on a checkpoint position that name a position this stream really
 * holds, or really held.
 *
 * Interpolated into the scripts below so the server and this process cannot
 * drift apart about which positions are acceptable.
 */
export const ACCEPTED_POSITION_VERDICTS = [
  /** The entry exists and carries exactly this publication ordinal. */
  "exact",
  /**
   * The entry exists but is not one of ours; the ordinal is unconsumed by it.
   *
   * Accepted so that a caller who has been handed
   * {@link EventBusEntryError}'s checkpoint can step over exactly the entry
   * something else wrote (§8.3 — reported, never skipped silently). It is the
   * one accepted verdict where the entry id names an entry that is **not** this
   * transport's, so it is also the one whose precondition is an external write
   * into the stream key: without one, no position can reach it. The ordinal is
   * still judged — it must not exceed what the stream has published — so the
   * step-over moves past an id, never past an event.
   */
  "foreign-entry",
  /** The position before the oldest retained entry. */
  "stream-origin",
  /** The entry is no longer retained and the ordinal is consistent with that. */
  "trimmed",
] as const;

export type AcceptedPositionVerdict = (typeof ACCEPTED_POSITION_VERDICTS)[number];

/** Verdicts that refuse a position, each naming why. */
export const REFUSED_POSITION_VERDICTS = [
  /** The stream instance this token was minted against no longer exists. */
  "origin-missing",
  /** The token was minted against another server, key namespace, or incarnation. */
  "origin-mismatch",
  /** The stream instance marker is not a value this implementation wrote. */
  "origin-unreadable",
  /** The key that should hold the stream holds something else. */
  "stream-key-type",
  /** The publication counter holds something this implementation did not write. */
  "counter-unreadable",
  /** The position claims a publication ordinal the stream has never issued. */
  "ahead-of-published",
  /** The position names an entry the server's own clock says cannot exist yet. */
  "ahead-of-clock",
  /** The position names an entry beyond the newest one the stream holds. */
  "ahead-of-stream",
  /** The entry exists but carries a different publication ordinal. */
  "ordinal-mismatch",
  /** No such entry exists, inside a range where a real one would still be retained. */
  "unknown-entry",
  /** The position is not in this implementation's shape at all. */
  "malformed",
] as const;

export type RefusedPositionVerdict = (typeof REFUSED_POSITION_VERDICTS)[number];

export type PositionVerdict = AcceptedPositionVerdict | RefusedPositionVerdict;

const LUA_FAILED = `
local function failed(reply)
  return type(reply) == 'table' and reply['err'] ~= nil
end
`;

/**
 * Entry-id arithmetic.
 *
 * Ids are `<serverMilliseconds>-<counter>`, so "is this position in the future"
 * and "is this position beyond the newest entry" are both answerable without
 * trusting anything the caller said.
 */
const LUA_ENTRY_IDS = `
local function idParts(id)
  local ms, counter = string.match(id, '^(%d+)%-(%d+)$')
  if ms == nil then return nil, nil end
  return tonumber(ms), tonumber(counter)
end

local function idGreater(left, right)
  local leftMs, leftCounter = idParts(left)
  local rightMs, rightCounter = idParts(right)
  if leftMs == nil or rightMs == nil then return false end
  if leftMs ~= rightMs then return leftMs > rightMs end
  return leftCounter > rightCounter
end
`;

/**
 * Decides whether `(entryId, sequence)` names a position this stream instance
 * really holds, or really held before retention removed it.
 *
 * Syntax is not identity: a token whose shape is right can still name an entry
 * that never existed, an entry from another server or key namespace, or an id
 * in the future — and every one of those would resume delivery somewhere the
 * consumer never reached, silently skipping whatever lies between. The check is
 * therefore against the server's own state, not against the token's format.
 */
const LUA_VALIDATE_POSITION = `
local function validatePosition(streamKey, counterKey, originKey, tokenOrigin, entryId, sequence)
  local originType = redis.call('TYPE', originKey)['ok']
  if originType ~= 'string' and originType ~= 'none' then
    return { 'origin-unreadable', originType }
  end
  local origin = redis.call('GET', originKey)
  if origin == false then
    return { 'origin-missing', '' }
  end
  if origin ~= tokenOrigin then
    return { 'origin-mismatch', origin }
  end
  local streamType = redis.call('TYPE', streamKey)['ok']
  if streamType ~= 'stream' and streamType ~= 'none' then
    return { 'stream-key-type', streamType }
  end
  local publishedRaw = redis.call('GET', counterKey)
  if publishedRaw == false then publishedRaw = '0' end
  if not string.match(publishedRaw, '^%d+$') then
    return { 'counter-unreadable', publishedRaw }
  end
  if not string.match(sequence, '^%d+$') then
    return { 'malformed', sequence }
  end
  if tonumber(sequence) > tonumber(publishedRaw) then
    return { 'ahead-of-published', publishedRaw }
  end
  local entryMs = idParts(entryId)
  if entryMs == nil then
    return { 'malformed', entryId }
  end
  if entryId == '0-0' then
    return { 'stream-origin', publishedRaw }
  end
  -- The entry itself is asked about before the server's clock is consulted. An
  -- entry that is present, retained, and carrying exactly this ordinal is the
  -- strongest evidence a position can have, and it stays true whatever the
  -- clock says: a clock that has stepped backwards below a real entry's id
  -- would otherwise refuse a genuine checkpoint and take resumption away for as
  -- long as the regression lasts (round-2 review, L3). The clock guard below
  -- keeps its real job — an id that names no entry, on a stream with no newest
  -- entry to compare it against.
  local found = redis.call('XRANGE', streamKey, entryId, entryId, 'COUNT', 1)
  if found[1] then
    local fields = found[1][2]
    local stored = nil
    for i = 1, #fields, 2 do
      if fields[i] == '${FIELD_SEQUENCE}' then stored = fields[i + 1] end
    end
    if stored == nil then return { 'foreign-entry', '' } end
    if stored == sequence then return { 'exact', '' } end
    return { 'ordinal-mismatch', stored }
  end
  local now = redis.call('TIME')
  local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  if entryMs > nowMs then
    return { 'ahead-of-clock', string.format('%d', nowMs) }
  end
  local last = redis.call('XREVRANGE', streamKey, '+', '-', 'COUNT', 1)
  if last[1] and idGreater(entryId, last[1][1]) then
    return { 'ahead-of-stream', last[1][1] }
  end
  local first = redis.call('XRANGE', streamKey, '-', '+', 'COUNT', 1)
  if first[1] and not idGreater(first[1][1], entryId) then
    return { 'unknown-entry', first[1][1] }
  end
  return { 'trimmed', '' }
end
`;

const LUA_ACCEPTED_VERDICTS = `
local ACCEPTED = { ${ACCEPTED_POSITION_VERDICTS.map((verdict) => `['${verdict}'] = true`).join(", ")} }
`;

/**
 * Appends one envelope and stamps it with the next publication ordinal.
 *
 * The ordinal and the entry must move together. The counter is written **after**
 * a successful append and the append is undone if the counter cannot be
 * written, so neither of the two inconsistent states this package would
 * misread — an ordinal with no entry, or an entry with no ordinal — survives a
 * failure. The ceiling and both key types are checked before anything is
 * mutated, so a stream key holding the wrong type, or a counter at the
 * safe-integer bound, refuses the publish without consuming an ordinal.
 *
 * ## Why the trim is its own step, after the counter
 *
 * Appending *and* trimming in one command is atomic but not reversible. At full
 * retention it removes the oldest entry as a side effect of the append, and the
 * compensation this script can perform — deleting the entry it just added —
 * cannot put that removed entry back. A publish whose counter write then failed
 * would leave the stream one real, unread event lighter than it found it, which
 * is a silent loss of a retained event: exactly what §8.3 forbids and what
 * "leaves both keys as it found them" must actually mean. (Round-2 review, M1;
 * reproduced with a command-specific denial of the counter write, which removed
 * the stream's oldest entry irrecoverably.)
 *
 * So the append does not trim, the counter is written, and only once the entry
 * and the ordinal agree does the bound get applied. Everything the failure path
 * has to undo is then something this script itself created.
 *
 * Trimming stays exact (`MAXLEN` with no `~`) so the configured retention is a
 * bound rather than an approximation. ADR-003 calls retention "a safety
 * parameter, not a tuning knob", and a bound that is only approximately
 * enforced cannot be reasoned about when sizing it against the worst tolerated
 * trader restart. A trim that fails after the publish is already consistent is
 * reported in the reply rather than turned into a failure: the event *is*
 * published, and telling the caller otherwise would invite a duplicate.
 *
 * KEYS: `[1]` stream, `[2]` publication counter.
 * ARGV: `[1]` retention bound, `[2]` encoded envelope.
 * Returns: `{ 'ok', entryId, sequence, trimError }` or `{ 'err', code, detail }`,
 * where `trimError` is empty unless the retention bound could not be applied.
 */
export const PUBLISH_SCRIPT = `
${LUA_FAILED}
local streamType = redis.call('TYPE', KEYS[1])['ok']
if streamType ~= 'stream' and streamType ~= 'none' then
  return { 'err', 'stream-key-type', streamType }
end
local counterType = redis.call('TYPE', KEYS[2])['ok']
if counterType ~= 'string' and counterType ~= 'none' then
  return { 'err', 'counter-key-type', counterType }
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw == false then currentRaw = '0' end
if not string.match(currentRaw, '^%d+$') then
  return { 'err', 'counter-unreadable', currentRaw }
end
if tonumber(currentRaw) >= ${MAX_PUBLICATION_ORDINAL} then
  return { 'err', 'counter-ceiling', currentRaw }
end
local sequence = string.format('%d', tonumber(currentRaw) + 1)
local appended = redis.pcall(
  'XADD', KEYS[1], '*',
  '${FIELD_SEQUENCE}', sequence,
  '${FIELD_ENVELOPE}', ARGV[2]
)
if failed(appended) then
  return { 'err', 'append-failed', tostring(appended['err']) }
end
local stored = redis.pcall('SET', KEYS[2], sequence)
if failed(stored) then
  local removed = redis.pcall('XDEL', KEYS[1], appended)
  if failed(removed) then
    return { 'err', 'counter-desynchronized', tostring(stored['err']) }
  end
  return { 'err', 'counter-write-failed', tostring(stored['err']) }
end
local trimmed = redis.pcall('XTRIM', KEYS[1], 'MAXLEN', ARGV[1])
local trimError = ''
if failed(trimmed) then trimError = tostring(trimmed['err']) end
return { 'ok', appended, sequence, trimError }
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
 * not distorted by clock skew between the application host and the server, and
 * so is this stream instance's marker, so a stored position minted against a
 * different instance can be recognised rather than believed.
 *
 * KEYS: `[1]` stream, `[2]` publication counter, `[3]` instance marker.
 * Returns: `[publishedTotal, depth, firstEntryId, firstSequence, lastEntryId,
 * serverSeconds, serverMicroseconds, origin]`, with empty strings where the
 * stream holds no entries and where no instance marker exists yet.
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
local origin = ''
if redis.call('TYPE', KEYS[3])['ok'] == 'string' then
  origin = redis.call('GET', KEYS[3])
end
return {
  published, string.format('%d', depth), firstEntryId, firstSequence, lastEntryId,
  now[1], now[2], origin
}
`;

/**
 * Returns this stream instance's marker, minting it on first use.
 *
 * The marker is what makes a checkpoint mean something *here*: it is created
 * once, alongside the stream's own keys, and it changes only if the stream's
 * key space is destroyed and recreated. A token carrying a different marker was
 * minted against another server, another key namespace, or a stream that no
 * longer exists — none of which can be resumed, and all of which would
 * otherwise decode into a plausible-looking position.
 *
 * The candidate is generated by the caller rather than by Lua, so the value is
 * an argument to a deterministic script rather than a random number the server
 * invented.
 *
 * KEYS: `[1]` instance marker. ARGV: `[1]` candidate marker.
 * Returns: `{ 'ok', marker }` or `{ 'err', code, detail }`.
 */
export const ENSURE_ORIGIN_SCRIPT = `
local markerType = redis.call('TYPE', KEYS[1])['ok']
if markerType ~= 'string' and markerType ~= 'none' then
  return { 'err', 'origin-unreadable', markerType }
end
local existing = redis.call('GET', KEYS[1])
if existing then
  if not string.match(existing, '^[0-9a-f][0-9a-f]*$') then
    return { 'err', 'origin-unreadable', existing }
  end
  return { 'ok', existing }
end
redis.call('SET', KEYS[1], ARGV[1])
return { 'ok', ARGV[1] }
`;

/**
 * Judges a checkpoint position without changing anything.
 *
 * KEYS: `[1]` stream, `[2]` publication counter, `[3]` instance marker.
 * ARGV: `[1]` token marker, `[2]` entry id, `[3]` publication ordinal.
 * Returns: `{ verdict, detail }`.
 */
export const RESOLVE_POSITION_SCRIPT = `
${LUA_ENTRY_IDS}
${LUA_VALIDATE_POSITION}
return validatePosition(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2], ARGV[3])
`;

/**
 * Records a consumer's position, and only a position this stream really holds.
 *
 * Validation and the write are one step on purpose: a checkpoint that was
 * checked and then written would leave a window in which the position stopped
 * being valid — and a stored position that names nothing is exactly the value
 * that makes a later restart resume somewhere the consumer never reached.
 *
 * KEYS: `[1]` stream, `[2]` publication counter, `[3]` instance marker,
 * `[4]` consumer positions.
 * ARGV: `[1]` token marker, `[2]` entry id, `[3]` publication ordinal,
 * `[4]` consumer id, `[5]` token.
 * Returns: `{ verdict, detail }`; the write happens only for an accepted verdict.
 */
export const STORE_CHECKPOINT_SCRIPT = `
${LUA_ENTRY_IDS}
${LUA_VALIDATE_POSITION}
${LUA_ACCEPTED_VERDICTS}
local verdict = validatePosition(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2], ARGV[3])
if not ACCEPTED[verdict[1]] then
  return verdict
end
redis.call('HSET', KEYS[4], ARGV[4], ARGV[5])
return verdict
`;
