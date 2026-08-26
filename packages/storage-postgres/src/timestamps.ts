/**
 * Timestamps cross this boundary as ISO-8601 strings, never as `Date`.
 *
 * The domain contracts type every instant as an ISO-8601 string (§7.1
 * `receivedAt`, `venueTimestamp`; `IsoTimestampSchema`). Handing a `Date` back
 * to a caller would introduce a second representation of one fact, drop
 * PostgreSQL's microsecond precision on the way out (`Date` is
 * millisecond-resolution), and make a recorded value depend on the process
 * timezone.
 *
 * Connections therefore run with `TimeZone=UTC` and `DateStyle=ISO`, where
 * PostgreSQL renders a `timestamptz` as `YYYY-MM-DD HH:MM:SS[.ffffff]+00`. That
 * is one space and one suffix away from ISO-8601, and the conversion below is
 * exact and total: anything else throws rather than being coerced.
 */

import { InvalidTimestampError } from "./errors.js";

/** An ISO-8601 UTC instant, e.g. `2026-08-26T10:15:30.123456Z`. */
export type IsoTimestamp = string;

/** PostgreSQL `timestamptz` under `DateStyle=ISO` with `TimeZone=UTC`. */
const PG_TIMESTAMPTZ =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?(?:([+-])(\d{2})(?::(\d{2}))?)?$/u;

/** ISO-8601 with an explicit offset or `Z`. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Converts a PostgreSQL timestamp rendering into an ISO-8601 UTC instant.
 *
 * @throws {InvalidTimestampError} when the value is not UTC-rendered ISO — which
 *   means the session settings were not applied, and silently guessing a
 *   timezone would corrupt every recorded instant.
 */
export function pgTimestampToIso(value: string): IsoTimestamp {
  const match = PG_TIMESTAMPTZ.exec(value);
  if (match === null) {
    throw new InvalidTimestampError(value);
  }

  const [, date, time, fraction, sign, offsetHours, offsetMinutes] = match;
  if (date === undefined || time === undefined) {
    throw new InvalidTimestampError(value);
  }

  // `timestamp without time zone` has no offset; `timestamptz` under UTC always
  // renders `+00`. A non-zero offset means the session is not UTC.
  if (sign !== undefined) {
    const hours = Number.parseInt(offsetHours ?? "0", 10);
    const minutes = Number.parseInt(offsetMinutes ?? "0", 10);
    if (hours !== 0 || minutes !== 0) {
      throw new InvalidTimestampError(value);
    }
  }

  return `${date}T${time}${fraction ?? ""}Z`;
}

/** Whether `value` is a syntactically valid ISO-8601 instant with an offset. */
export function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Validates an ISO-8601 instant on the way into the database.
 *
 * PostgreSQL parses ISO-8601 natively, so the value is passed through as text;
 * this only rejects a malformed one at the boundary instead of letting the
 * server produce a confusing parse error deep inside a batch.
 */
export function assertIsoTimestamp(value: string): IsoTimestamp {
  if (!isIsoTimestamp(value)) {
    throw new InvalidTimestampError(value);
  }
  return value;
}
