/**
 * The Redis Streams implementation of the transport interface (ADR-003 §1).
 *
 * The export list is deliberately narrow: a caller needs a way to *construct*
 * the implementation and nothing else, because everything it obtains from it
 * afterwards is typed by `../transport.ts`.
 *
 * In particular the client type is **not** exported. It is an `ioredis` type,
 * and a consumer that could name it would hold a Redis client type in its own
 * signature — which is what `docs/contracts/dependency-direction.md` §3 (F8)
 * and ADR-003 §1 reserve to this package. The checkpoint token codec, the key
 * layout, the server-side scripts, and the stream-state reader are withheld for
 * the same reason: they are this implementation's private vocabulary, and
 * ADR-003's Consequences make leaking them a substantive violation rather than
 * a style problem.
 */

export type { RedisConnectionOptions } from "./client.js";
export {
  MAX_RETENTION_EVENTS,
  REDIS_STREAMS_TRANSPORT_ID,
  RedisStreamsEventTransport,
} from "./transport.js";
export type { RedisStreamsTransportOptions } from "./transport.js";
