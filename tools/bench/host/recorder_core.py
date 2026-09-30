"""HOST-BENCH multi-market recorder: the pure, offline-testable part.

Standard library only. No network, no clock of its own: every function takes
the time it needs as an argument, so `tests/test_recorder_core.py` drives it
with recorded frames and a fake clock.

Venue facts this module relies on, and where each is documented. Nothing else
about the venue is assumed.

- Gamma base URL `https://gamma-api.polymarket.com`:
  https://docs.polymarket.com/api-reference/rate-limits.md ("Gamma API",
  "Base URL"), fetched 2026-09-30.
- `GET /events` with the query parameters `closed`, `end_date_min`,
  `end_date_max`, `limit`, `offset`; the Event fields `seriesSlug`,
  `series[].slug` and `markets[]`; the Market fields `id`, `conditionId`,
  `slug`, `eventStartTime`, `endDate`, `clobTokenIds` (type `string`),
  `outcomes` (type `string`) and `closed`:
  https://docs.polymarket.com/api-reference/events/list-events.md (the
  OpenAPI `listEvents`), fetched 2026-09-30, sha256 `a4a9bf4f...`.
  `clobTokenIds` and `outcomes` are typed `string`; the value observed on
  2026-09-29 and 2026-09-30 is a JSON-encoded array
  (`docs/handoffs/H1-RUN-1.md`), so both spellings are accepted here.
- The series slugs themselves (`btc-up-or-down-15m`, ...) are OBSERVED values
  of `seriesSlug`, not documented constants. `record_markets.py --list-series`
  prints what the venue lists today; pass `--series` to override the default.
- `/events` is limited to 500 requests per 10 s per IP (rate-limits page;
  `docs/venue/verified-2026-09-30.md` §8, unchanged). The recorder polls once
  a minute.
- Market WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market`; the
  subscribe frame `{"assets_ids": [...], "type": "market"}` with the optional
  `custom_feature_enabled` and `initial_dump`; the dynamic
  `{"assets_ids": [...], "operation": "subscribe" | "unsubscribe"}` frames;
  the heartbeat "Send the text frame `PING` every 10 seconds; the server
  replies with `PONG`"; the event shapes `book`, `price_change`
  (`price_changes[]`), `last_trade_price`, `tick_size_change`, each naming its
  `market` (the condition id):
  https://docs.polymarket.com/market-data/realtime-data.md ("Market Stream")
  and https://docs.polymarket.com/api-reference/wss/market.md (sha256
  `92a02634...`, byte-identical since 2026-08-28), recorded in
  `docs/venue/verified-2026-09-16.md` §3 and `verified-2026-09-30.md` §3.
- A frame may carry ONE event object or an ARRAY of them: the repository's
  own decoder (`packages/polymarket-public/src/venue/frames.ts`
  `decodeInboundFrame`) follows the official SDK here, and H1 run 8's WAL
  holds such an array (the initial book dump).
- Undocumented, and NOT assumed (`verified-2026-09-30.md` §12): U-2, what the
  server does when a `PING` is missed; U-3, the maximum `assets_ids` per
  subscription. The 30 s staleness bound below is the official SDK's
  client-side choice (`CLOB_HEARTBEAT_STALE_MS`), the same one
  `packages/polymarket-public/src/config.ts` uses.
"""

from __future__ import annotations

import datetime
import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

GAMMA_BASE_URL = "https://gamma-api.polymarket.com"
MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

# Documented heartbeat cadence (realtime-data.md, "Market Stream").
PING_INTERVAL_S = 10.0
# The official SDK's client-side staleness bound; NOT a documented server rule (U-2).
PONG_TIMEOUT_S = 30.0
# The official SDK's reconnect backoff bounds, as packages/polymarket-public uses them.
RECONNECT_BASE_S = 0.25
RECONNECT_MAX_S = 30.0

# Observed on 2026-09-30 (seriesSlug values); see the module docstring.
DEFAULT_SERIES: tuple[str, ...] = (
    "btc-up-or-down-5m",
    "btc-up-or-down-15m",
    "eth-up-or-down-5m",
    "eth-up-or-down-15m",
    "sol-up-or-down-5m",
    "sol-up-or-down-15m",
    "xrp-up-or-down-5m",
    "xrp-up-or-down-15m",
)

UNATTRIBUTED = "(unattributed)"

_FRACTION = re.compile(r"\.(\d+)(?=[+-]\d\d:\d\d$|$)")


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def parse_iso(value: Any) -> float | None:
    """An ISO-8601 instant as epoch seconds, or None when it is not one."""
    if not isinstance(value, str) or value == "":
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Python 3.10's fromisoformat takes only 3 or 6 fractional digits; pad or cut to 6.
    match = _FRACTION.search(text)
    if match is not None:
        text = text[: match.start()] + "." + (match.group(1) + "000000")[:6] + text[match.end(1) :]
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def iso(epoch_s: float) -> str:
    """Epoch seconds as an ISO-8601 UTC instant with millisecond precision."""
    moment = datetime.datetime.fromtimestamp(epoch_s, tz=datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def gamma_time(epoch_s: float) -> str:
    """An instant in the form the Gamma date filters accept (whole seconds, UTC)."""
    moment = datetime.datetime.fromtimestamp(int(epoch_s), tz=datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Gamma discovery
# ---------------------------------------------------------------------------


def asset_of_series(series: str) -> str:
    """`btc-up-or-down-15m` -> `btc`. Any other slug: its first dash-separated word."""
    marker = "-up-or-down-"
    if marker in series:
        return series.split(marker, 1)[0]
    return series.split("-", 1)[0]


@dataclass(frozen=True)
class Window:
    """One market window of a series, as Gamma lists it."""

    series: str
    asset: str
    event_slug: str
    market_id: str
    condition_id: str
    start: float
    end: float
    token_ids: tuple[str, ...]
    outcomes: tuple[str, ...]

    def describe(self) -> str:
        return f"{self.event_slug or self.market_id} [{iso(self.start)} .. {iso(self.end)})"

    def as_json(self) -> dict[str, Any]:
        return {
            "series": self.series,
            "asset": self.asset,
            "eventSlug": self.event_slug,
            "marketId": self.market_id,
            "conditionId": self.condition_id,
            "start": iso(self.start),
            "end": iso(self.end),
            "tokenIds": list(self.token_ids),
            "outcomes": list(self.outcomes),
        }


def _string_list(value: Any) -> list[str] | None:
    """A list of strings from a list, or from a JSON-encoded list (Gamma types it `string`)."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return None
    return list(value)


def event_series_slug(event: dict[str, Any]) -> str | None:
    """The event's `seriesSlug`, else the slug of its first `series` entry."""
    slug = event.get("seriesSlug")
    if isinstance(slug, str) and slug:
        return slug
    series = event.get("series")
    if isinstance(series, list):
        for entry in series:
            if isinstance(entry, dict) and isinstance(entry.get("slug"), str) and entry["slug"]:
                return entry["slug"]
    return None


def parse_gamma_events(
    events: Any, series_filter: Iterable[str] | None = None
) -> tuple[list[Window], list[str]]:
    """The windows of the wanted series in one `/events` response, and why any market was skipped.

    A market is skipped (and the reason returned) when a field this recorder
    needs is missing or malformed. A market Gamma marks `closed: true` is
    skipped silently.
    """
    wanted = None if series_filter is None else set(series_filter)
    windows: dict[str, Window] = {}
    problems: list[str] = []
    if not isinstance(events, list):
        return [], ["the /events response is not a JSON array"]
    for event in events:
        if not isinstance(event, dict):
            problems.append("an /events entry is not an object")
            continue
        series = event_series_slug(event)
        if series is None or (wanted is not None and series not in wanted):
            continue
        event_slug = event.get("slug") if isinstance(event.get("slug"), str) else ""
        markets = event.get("markets")
        if not isinstance(markets, list):
            problems.append(f"{series} {event_slug}: no markets array")
            continue
        for market in markets:
            if not isinstance(market, dict):
                problems.append(f"{series} {event_slug}: a market is not an object")
                continue
            if market.get("closed") is True:
                continue
            label = f"{series} {event_slug} market {market.get('id')!r}"
            condition = market.get("conditionId")
            start = parse_iso(market.get("eventStartTime"))
            end = parse_iso(market.get("endDate"))
            tokens = _string_list(market.get("clobTokenIds"))
            outcomes = _string_list(market.get("outcomes")) or []
            if not isinstance(condition, str) or condition == "":
                problems.append(f"{label}: no conditionId")
                continue
            if start is None or end is None or end <= start:
                problems.append(f"{label}: eventStartTime/endDate missing or not increasing")
                continue
            if not tokens:
                problems.append(f"{label}: clobTokenIds missing or malformed")
                continue
            windows[condition] = Window(
                series=series,
                asset=asset_of_series(series),
                event_slug=event_slug,
                market_id=str(market.get("id", "")),
                condition_id=condition,
                start=start,
                end=end,
                token_ids=tuple(tokens),
                outcomes=tuple(outcomes),
            )
    return sorted(windows.values(), key=lambda w: (w.series, w.start)), problems


def count_series(events: Any) -> dict[str, int]:
    """How many listed events each series has (for `--list-series`)."""
    counts: dict[str, int] = {}
    if isinstance(events, list):
        for event in events:
            if isinstance(event, dict):
                slug = event_series_slug(event) or "(no series)"
                counts[slug] = counts.get(slug, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def select_windows(
    windows: Iterable[Window], now: float, next_count: int = 1, linger_s: float = 30.0
) -> list[Window]:
    """The windows to be subscribed at `now`: per series, every window that has
    started and not yet ended (plus `linger_s`), and the next `next_count`
    windows that have not started."""
    by_series: dict[str, list[Window]] = {}
    for window in windows:
        if window.end + linger_s > now:
            by_series.setdefault(window.series, []).append(window)
    chosen: list[Window] = []
    for series in sorted(by_series):
        candidates = sorted(by_series[series], key=lambda w: w.start)
        chosen.extend(w for w in candidates if w.start <= now)
        chosen.extend([w for w in candidates if w.start > now][: max(0, next_count)])
    return chosen


def tokens_of(windows: Iterable[Window]) -> set[str]:
    return {token for window in windows for token in window.token_ids}


def plan_subscription_change(current: set[str], desired: set[str]) -> tuple[list[str], list[str]]:
    """(tokens to subscribe, tokens to unsubscribe), each sorted."""
    return sorted(desired - current), sorted(current - desired)


def subscribe_frame(token_ids: Iterable[str]) -> dict[str, Any]:
    """The initial market subscription, with the optional fields sent explicitly,
    as the gateway sends them (`buildMarketSubscribeFrame`): no custom features,
    the documented default initial dump."""
    return {
        "assets_ids": sorted(token_ids),
        "type": "market",
        "custom_feature_enabled": False,
        "initial_dump": True,
    }


def update_frame(operation: str, token_ids: Iterable[str]) -> dict[str, Any]:
    """A dynamic subscribe or unsubscribe frame on the open connection."""
    if operation not in ("subscribe", "unsubscribe"):
        raise ValueError(f"unknown operation {operation!r}")
    frame: dict[str, Any] = {"assets_ids": sorted(token_ids), "operation": operation}
    if operation == "subscribe":
        frame["custom_feature_enabled"] = False
    return frame


def backoff_delay(attempt: int, unit_random: float) -> float:
    """Full-jitter exponential backoff: a uniform draw in [0, min(max, base * 2**attempt)]."""
    ceiling = min(RECONNECT_MAX_S, RECONNECT_BASE_S * (2 ** max(0, attempt)))
    return max(RECONNECT_BASE_S, ceiling * min(1.0, max(0.0, unit_random)))


# ---------------------------------------------------------------------------
# Frame decoding and attribution
# ---------------------------------------------------------------------------


@dataclass
class DecodedFrame:
    kind: str  # "pong" | "events" | "unparsable"
    events: list[dict[str, Any]] = field(default_factory=list)
    non_object_items: int = 0
    reason: str = ""


def decode_frame(text: str) -> DecodedFrame:
    """One inbound text frame: `PONG`, one event object, or an array of them."""
    trimmed = text.strip()
    if trimmed == "PONG":
        return DecodedFrame(kind="pong")
    if trimmed == "":
        return DecodedFrame(kind="unparsable", reason="empty frame")
    try:
        parsed = json.loads(trimmed)
    except ValueError as error:
        return DecodedFrame(kind="unparsable", reason=f"not JSON: {error}")
    if isinstance(parsed, dict):
        return DecodedFrame(kind="events", events=[parsed])
    if isinstance(parsed, list):
        objects = [item for item in parsed if isinstance(item, dict)]
        return DecodedFrame(kind="events", events=objects, non_object_items=len(parsed) - len(objects))
    return DecodedFrame(kind="unparsable", reason=f"JSON {type(parsed).__name__} is not an event")


def event_type(event: dict[str, Any]) -> str:
    value = event.get("event_type")
    return value if isinstance(value, str) and value else "(none)"


def event_market(event: dict[str, Any]) -> str | None:
    value = event.get("market")
    return value if isinstance(value, str) and value else None


def envelope_estimate(event: dict[str, Any]) -> int:
    """How many normalized envelopes the gateway would publish for this event:
    one `BookLevelChanged` per `price_changes` entry, one per other event
    (`book` -> `BookSnapshot`, `last_trade_price` -> `PublicTradeObserved`).
    An estimate of the trader's input rate, not a count the gateway reported."""
    if event_type(event) == "price_change":
        changes = event.get("price_changes")
        return len(changes) if isinstance(changes, list) else 0
    return 1


def apportion_bytes(frame_bytes: int, events: list[dict[str, Any]]) -> list[int]:
    """Split a frame's bytes over its events in proportion to each event's
    compact JSON length. The parts always sum to `frame_bytes`."""
    if not events:
        return []
    if len(events) == 1:
        return [frame_bytes]
    weights = [len(json.dumps(event, separators=(",", ":"))) for event in events]
    total = sum(weights) or len(weights)
    shares = [frame_bytes * weight // total for weight in weights]
    shares[-1] += frame_bytes - sum(shares)
    return shares


# ---------------------------------------------------------------------------
# Counting
# ---------------------------------------------------------------------------

# Counter slots: frames, events, envelopes (estimate), bytes.
FRAMES, EVENTS, ENVELOPES, BYTES = range(4)


def _zero() -> list[int]:
    return [0, 0, 0, 0]


def _add(target: list[int], frames: int, events: int, envelopes: int, nbytes: int) -> None:
    target[FRAMES] += frames
    target[EVENTS] += events
    target[ENVELOPES] += envelopes
    target[BYTES] += nbytes


@dataclass
class MarketTotals:
    series: str
    counts: list[int] = field(default_factory=_zero)
    event_types: dict[str, int] = field(default_factory=dict)
    first_seen: float | None = None
    last_seen: float | None = None


class Stats:
    """Per-market totals, per-series 10-second buckets and per-second rows."""

    def __init__(self, bucket_s: int = 10) -> None:
        if bucket_s <= 0:
            raise ValueError("bucket_s must be positive")
        self.bucket_s = bucket_s
        self.markets: dict[str, MarketTotals] = {}
        self.buckets: dict[str, dict[int, list[int]]] = {}
        self.seconds: dict[int, dict[str, list[int]]] = {}
        self.peak_1s: dict[str, tuple[int, int]] = {}  # series -> (envelopes, second)
        self.control: dict[str, list[int]] = {}  # series -> [pong frames, pong bytes]
        self.unparsable: dict[str, list[int]] = {}  # series -> [frames, bytes]
        self.non_object_items = 0
        self.total_bytes = 0
        self.total_frames = 0

    def record_frame(self, t: float, series_hint: str, text: str, registry: dict[str, Window]) -> DecodedFrame:
        """Count one inbound text frame received at `t` on `series_hint`'s connection."""
        nbytes = len(text.encode("utf-8"))
        self.total_bytes += nbytes
        self.total_frames += 1
        decoded = decode_frame(text)
        if decoded.kind == "pong":
            slot = self.control.setdefault(series_hint, [0, 0])
            slot[0] += 1
            slot[1] += nbytes
            return decoded
        if decoded.kind == "unparsable" or not decoded.events:
            slot = self.unparsable.setdefault(series_hint, [0, 0])
            slot[0] += 1
            slot[1] += nbytes
            return decoded
        self.non_object_items += decoded.non_object_items
        second = int(t)
        bucket = second // self.bucket_s
        touched_markets: set[str] = set()
        touched_series: set[str] = set()
        for event, share in zip(decoded.events, apportion_bytes(nbytes, decoded.events)):
            condition = event_market(event)
            window = registry.get(condition) if condition is not None else None
            series = window.series if window is not None else series_hint
            market_key = condition if condition is not None else UNATTRIBUTED
            envelopes = envelope_estimate(event)
            totals = self.markets.get(market_key)
            if totals is None:
                totals = MarketTotals(series=series)
                self.markets[market_key] = totals
            _add(totals.counts, 0, 1, envelopes, share)
            kind = event_type(event)
            totals.event_types[kind] = totals.event_types.get(kind, 0) + 1
            if totals.first_seen is None:
                totals.first_seen = t
            totals.last_seen = t
            _add(self.buckets.setdefault(series, {}).setdefault(bucket, _zero()), 0, 1, envelopes, share)
            _add(self.seconds.setdefault(second, {}).setdefault(series, _zero()), 0, 1, envelopes, share)
            touched_markets.add(market_key)
            touched_series.add(series)
        for market_key in touched_markets:
            self.markets[market_key].counts[FRAMES] += 1
        for series in touched_series:
            self.buckets[series][bucket][FRAMES] += 1
            self.seconds[second][series][FRAMES] += 1
        return decoded

    def drain_seconds(self, before_second: int) -> list[tuple[int, dict[str, list[int]]]]:
        """Remove and return every per-second row older than `before_second`, oldest first."""
        rows = []
        for second in sorted(s for s in self.seconds if s < before_second):
            row = self.seconds.pop(second)
            for series, counts in row.items():
                best = self.peak_1s.get(series)
                if best is None or counts[ENVELOPES] > best[0]:
                    self.peak_1s[series] = (counts[ENVELOPES], second)
            rows.append((second, row))
        return rows


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile of `values` (`fraction` in (0, 1]); None when empty."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def _rates(counts: dict[int, list[int]], buckets: Iterable[int], bucket_s: int, slot: int) -> list[float]:
    return [counts.get(b, _zero())[slot] / bucket_s for b in buckets]


def _covered_buckets(start: float, end: float, bucket_s: int) -> range:
    """The whole buckets inside [start, end)."""
    first = math.ceil(start / bucket_s)
    last = math.floor(end / bucket_s)
    return range(first, max(first, last))


def _sum_buckets(per_series: Iterable[dict[int, list[int]]]) -> dict[int, list[int]]:
    total: dict[int, list[int]] = {}
    for counts in per_series:
        for bucket, values in counts.items():
            slot = total.setdefault(bucket, _zero())
            for index in range(4):
                slot[index] += values[index]
    return total


def open_stats(
    counts: dict[int, list[int]],
    opens: Iterable[float],
    covered: range,
    bucket_s: int,
    before_s: int = 30,
    after_s: int = 90,
) -> dict[str, Any]:
    """10-second rates around window opens.

    For each open instant T whose whole interval lies inside the recording,
    the buckets whose start lies in [T - before_s, T + after_s). An open whose
    interval the recording only partly covers is left out, so the first
    minutes (with the initial book dump) never pass for an open. Reports the peak and
    the nearest-rank p95 over all those buckets together, in envelopes/s,
    events/s, frames/s and bytes/s, plus each open's own peak envelopes/s.
    """
    covered_set = set(covered)
    per_open = []
    pooled: dict[int, list[float]] = {ENVELOPES: [], EVENTS: [], FRAMES: [], BYTES: []}
    for t in sorted(set(opens)):
        first = math.floor((t - before_s) / bucket_s)
        last = math.floor((t + after_s) / bucket_s)
        buckets = list(range(first, last))
        if not buckets or any(b not in covered_set for b in buckets):
            continue  # only opens whose whole interval lies inside the recording
        for slot in pooled:
            pooled[slot].extend(_rates(counts, buckets, bucket_s, slot))
        env = _rates(counts, buckets, bucket_s, ENVELOPES)
        per_open.append({"open": iso(t), "peak10sEnvelopesPerSecond": max(env)})
    return {
        "opens": len(per_open),
        "intervalSeconds": [-before_s, after_s],
        "peak10sEnvelopesPerSecond": max(pooled[ENVELOPES]) if pooled[ENVELOPES] else None,
        "p95_10sEnvelopesPerSecond": percentile(pooled[ENVELOPES], 0.95),
        "peak10sEventsPerSecond": max(pooled[EVENTS]) if pooled[EVENTS] else None,
        "p95_10sEventsPerSecond": percentile(pooled[EVENTS], 0.95),
        "peak10sFramesPerSecond": max(pooled[FRAMES]) if pooled[FRAMES] else None,
        "p95_10sFramesPerSecond": percentile(pooled[FRAMES], 0.95),
        "peak10sBytesPerSecond": max(pooled[BYTES]) if pooled[BYTES] else None,
        "p95_10sBytesPerSecond": percentile(pooled[BYTES], 0.95),
        "busiestOpens": sorted(per_open, key=lambda o: -o["peak10sEnvelopesPerSecond"])[:10],
    }


def whole_recording_stats(counts: dict[int, list[int]], covered: range, bucket_s: int) -> dict[str, Any]:
    env = _rates(counts, covered, bucket_s, ENVELOPES)
    byt = _rates(counts, covered, bucket_s, BYTES)
    return {
        "buckets": len(env),
        "p50_10sEnvelopesPerSecond": percentile(env, 0.50),
        "p95_10sEnvelopesPerSecond": percentile(env, 0.95),
        "peak10sEnvelopesPerSecond": max(env) if env else None,
        "p95_10sBytesPerSecond": percentile(byt, 0.95),
        "peak10sBytesPerSecond": max(byt) if byt else None,
    }


def _totals_block(counts: list[int], duration_s: float) -> dict[str, Any]:
    per_s = (lambda n: n / duration_s) if duration_s > 0 else (lambda n: None)
    return {
        "frames": counts[FRAMES],
        "events": counts[EVENTS],
        "envelopesEstimate": counts[ENVELOPES],
        "bytes": counts[BYTES],
        "bytesPerDay": (counts[BYTES] * 86400 / duration_s) if duration_s > 0 else None,
        "framesPerSecond": per_s(counts[FRAMES]),
        "eventsPerSecond": per_s(counts[EVENTS]),
        "envelopesPerSecond": per_s(counts[ENVELOPES]),
    }


def summarize(
    stats: Stats,
    windows_seen: dict[str, Window],
    series_list: Iterable[str],
    started_at: float,
    ended_at: float,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The recording's summary document (see README.md "summary.json")."""
    stats.drain_seconds(int(ended_at) + 1)
    duration = max(0.0, ended_at - started_at)
    bucket_s = stats.bucket_s
    covered = _covered_buckets(started_at, ended_at, bucket_s)
    series_names = sorted(set(series_list) | set(stats.buckets))

    series_counts: dict[str, list[int]] = {name: _zero() for name in series_names}
    for totals in stats.markets.values():
        _add(series_counts.setdefault(totals.series, _zero()), *totals.counts)
    # Frames per series come from the buckets: a frame is counted once per series it touched.
    for name in series_names:
        series_counts[name][FRAMES] = sum(v[FRAMES] for v in stats.buckets.get(name, {}).values())

    per_series: dict[str, Any] = {}
    for name in series_names:
        counts = stats.buckets.get(name, {})
        opens = [w.start for w in windows_seen.values() if w.series == name]
        peak = stats.peak_1s.get(name)
        per_series[name] = {
            "asset": asset_of_series(name),
            **_totals_block(series_counts[name], duration),
            "peak1sEnvelopesPerSecond": None if peak is None else peak[0],
            "peak1sAt": None if peak is None else iso(peak[1]),
            "whole": whole_recording_stats(counts, covered, bucket_s),
            "atWindowOpens": open_stats(counts, opens, covered, bucket_s),
            "windowsSeen": sum(1 for w in windows_seen.values() if w.series == name),
        }

    per_asset: dict[str, Any] = {}
    for asset in sorted({asset_of_series(name) for name in series_names}):
        members = [name for name in series_names if asset_of_series(name) == asset]
        counts = _zero()
        for name in members:
            _add(counts, *series_counts[name])
        merged = _sum_buckets(stats.buckets.get(name, {}) for name in members)
        opens = [w.start for w in windows_seen.values() if w.series in members]
        per_asset[asset] = {
            "series": members,
            **_totals_block(counts, duration),
            "whole": whole_recording_stats(merged, covered, bucket_s),
            "atWindowOpens": open_stats(merged, opens, covered, bucket_s),
        }

    all_counts = _zero()
    for name in series_names:
        _add(all_counts, *series_counts[name])
    merged_all = _sum_buckets(stats.buckets.values())
    all_opens = [w.start for w in windows_seen.values()]
    aligned = [t for t in all_opens if int(t) % 900 == 0]

    windows = []
    for condition, window in sorted(windows_seen.items(), key=lambda item: (item[1].series, item[1].start)):
        totals = stats.markets.get(condition)
        counts = totals.counts if totals is not None else _zero()
        windows.append(
            {
                "series": window.series,
                "eventSlug": window.event_slug,
                "marketId": window.market_id,
                "conditionId": condition,
                "start": iso(window.start),
                "end": iso(window.end),
                "frames": counts[FRAMES],
                "events": counts[EVENTS],
                "envelopesEstimate": counts[ENVELOPES],
                "bytes": counts[BYTES],
                "eventTypes": dict(sorted(totals.event_types.items())) if totals is not None else {},
            }
        )
    unattributed = stats.markets.get(UNATTRIBUTED)

    return {
        "tool": "tools/bench/host/record_markets.py",
        "summaryVersion": 1,
        "startedAt": iso(started_at),
        "endedAt": iso(ended_at),
        "durationSeconds": duration,
        "bucketSeconds": bucket_s,
        "definitions": {
            "bytes": "UTF-8 length of each inbound WebSocket text message (framing and TLS excluded)",
            "frames": "inbound WebSocket text messages that carried at least one event",
            "events": "event objects (a frame may carry an array of them)",
            "envelopesEstimate": "one per price_changes entry, one per other event: the gateway's normalized envelope count, estimated",
            "atWindowOpens": "10-second buckets from 30 s before to 90 s after each window open (eventStartTime) whose whole interval the recording covers; peak and nearest-rank p95 over all of them",
            "alignedOpens": "opens at a multiple of 15 minutes, when every 5-minute and 15-minute series opens at once",
        },
        "all": {
            **_totals_block(all_counts, duration),
            "whole": whole_recording_stats(merged_all, covered, bucket_s),
            "atAlignedOpens": open_stats(merged_all, aligned, covered, bucket_s),
            "atAnyOpen": open_stats(merged_all, all_opens, covered, bucket_s),
        },
        "perSeries": per_series,
        "perAsset": per_asset,
        "control": {
            "pongFrames": sum(v[0] for v in stats.control.values()),
            "pongBytes": sum(v[1] for v in stats.control.values()),
            "unparsableFrames": sum(v[0] for v in stats.unparsable.values()),
            "unparsableBytes": sum(v[1] for v in stats.unparsable.values()),
            "nonObjectArrayItems": stats.non_object_items,
            "unattributedEvents": 0 if unattributed is None else unattributed.counts[EVENTS],
            "inboundTextBytesTotal": stats.total_bytes,
            "inboundTextFramesTotal": stats.total_frames,
        },
        "windows": windows,
        **(extra or {}),
    }
