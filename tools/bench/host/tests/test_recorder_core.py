"""Offline checks of the recorder's parsing, rollover and counting logic.

Run: python3 -m unittest discover -s tools/bench/host/tests -v

Inputs:
- fixtures/market-ws-frames-h1-run-8.jsonl: 28 inbound market-WebSocket text
  frames, verbatim from H1 run 8's gateway WAL (`payloadUtf8`, public market
  data; the WAL record shape is the one `docs/handoffs/H1-RUNS-2-8.md`
  describes). They include the initial book dump as ONE array frame, single
  `book`, `price_change` and `last_trade_price` frames, and `PONG`.
- fixtures/gamma-events.json: a trimmed Gamma `/events` response; see its
  `_provenance` field.
- fixtures/gamma-events-v2.json: Polymarket Protocol V2 markets, the first of
  them the official V2 example; see its `_provenance` field.
- test/fixtures/venue/protocol-v2/ (repository root): VENUE-4's V2 captures,
  read in place (the documented V2 market and event, a V2 CLOB market record,
  and a 60 s market-channel session on a V2 position id).
No network is used.
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import recorder_core as core  # noqa: E402

FIXTURES = HERE / "fixtures"
RUN8_CONDITION = "0x2aaeb40ad2a1ad262d75d5c52bff1a9f801fb72e65774343729fe103ee9fa308"
RUN8_TOKENS = (
    "40113202025193181740822500498877260546965498642740503547096491847887927548587",
    "58726851105893121441976415044785550794620582864839872973127370351200548678811",
)
WANTED = ("btc-up-or-down-15m", "eth-up-or-down-5m", "xrp-up-or-down-5m", "sol-up-or-down-5m")


def load_events() -> list:
    return json.loads((FIXTURES / "gamma-events.json").read_text(encoding="utf-8"))["events"]


def load_frames() -> list[dict]:
    lines = (FIXTURES / "market-ws-frames-h1-run-8.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def at(text: str) -> float:
    value = core.parse_iso(text)
    assert value is not None
    return value


class GammaParsing(unittest.TestCase):
    def test_parses_the_wanted_series_and_reports_malformed_markets(self) -> None:
        windows, problems = core.parse_gamma_events(load_events(), WANTED)
        by_condition = {w.condition_id: w for w in windows}
        run8 = by_condition[RUN8_CONDITION]
        self.assertEqual(run8.series, "btc-up-or-down-15m")
        self.assertEqual(run8.asset, "btc")
        self.assertEqual(run8.market_id, "5121969")
        self.assertEqual(run8.token_ids, RUN8_TOKENS)
        self.assertEqual(run8.outcomes, ("Up", "Down"))
        self.assertEqual(run8.start, at("2026-09-30T11:30:00Z"))
        self.assertEqual(run8.end - run8.start, 900)
        # 4 btc-15m + 3 open eth-5m (one is closed); xrp and sol are malformed.
        self.assertEqual(sorted(w.series for w in windows), ["btc-up-or-down-15m"] * 4 + ["eth-up-or-down-5m"] * 3)
        self.assertEqual(len(problems), 2)
        self.assertTrue(any("clobTokenIds" in p for p in problems))
        self.assertTrue(any("not increasing" in p for p in problems))

    def test_series_slug_falls_back_to_the_series_array(self) -> None:
        windows, _ = core.parse_gamma_events(load_events(), ["eth-up-or-down-5m"])
        self.assertIn("eth-updown-5m-1790767800", [w.event_slug for w in windows])

    def test_other_series_are_ignored_and_listed(self) -> None:
        windows, _ = core.parse_gamma_events(load_events(), ["rain-daily-x"])
        self.assertEqual(windows, [])
        counts = core.count_series(load_events())
        self.assertEqual(counts["btc-up-or-down-15m"], 4)
        self.assertEqual(counts["rain-daily"], 1)
        self.assertEqual(counts["(no series)"], 1)

    def test_token_ids_accept_a_list_or_a_json_string(self) -> None:
        self.assertEqual(core._string_list('["1", "2"]'), ["1", "2"])
        self.assertEqual(core._string_list(["1", "2"]), ["1", "2"])
        self.assertIsNone(core._string_list("not json"))
        self.assertIsNone(core._string_list([1, 2]))

    def test_a_non_array_response_is_a_problem(self) -> None:
        self.assertEqual(core.parse_gamma_events({"error": "x"}), ([], ["the /events response is not a JSON array"]))

    def test_iso_round_trip(self) -> None:
        self.assertEqual(core.iso(at("2026-09-30T11:30:00.250Z")), "2026-09-30T11:30:00.250Z")
        self.assertIsNone(core.parse_iso("2026-09-30T11:30:00"))  # no zone
        self.assertIsNone(core.parse_iso(None))
        self.assertEqual(core.gamma_time(at("2026-09-30T11:30:00.9Z")), "2026-09-30T11:30:00Z")

    def test_asset_of_series(self) -> None:
        self.assertEqual(core.asset_of_series("btc-up-or-down-15m"), "btc")
        self.assertEqual(core.asset_of_series("xrp-up-or-down-5m"), "xrp")
        self.assertEqual(core.asset_of_series("rain-daily"), "rain")


class Rollover(unittest.TestCase):
    def setUp(self) -> None:
        self.windows, _ = core.parse_gamma_events(load_events(), WANTED)

    def chosen(self, now: str, **kwargs) -> list[str]:
        return [w.event_slug for w in core.select_windows(self.windows, at(now), **kwargs)]

    def test_current_and_next_window_per_series(self) -> None:
        self.assertEqual(
            self.chosen("2026-09-30T11:33:00Z"),
            [
                "btc-updown-15m-1790767800",
                "btc-updown-15m-1790768700",
                "eth-updown-5m-1790767800",
                "eth-updown-5m-1790768100",
            ],
        )

    def test_a_window_lingers_after_its_end_then_rolls(self) -> None:
        # 11:45:10 -- the run-8 window ended 10 s ago and still lingers (30 s).
        self.assertIn("btc-updown-15m-1790767800", self.chosen("2026-09-30T11:45:10Z"))
        # 11:45:31 -- gone; the 11:45 window is current and the 12:00 one is next.
        chosen = self.chosen("2026-09-30T11:45:31Z")
        self.assertNotIn("btc-updown-15m-1790767800", chosen)
        self.assertEqual(chosen[:2], ["btc-updown-15m-1790768700", "btc-updown-15m-1790769600"])

    def test_the_next_window_is_subscribed_before_it_opens(self) -> None:
        before_open = self.chosen("2026-09-30T11:44:59Z")
        self.assertIn("btc-updown-15m-1790768700", before_open)
        self.assertNotIn("btc-updown-15m-1790769600", before_open)

    def test_next_count_zero_and_two(self) -> None:
        self.assertEqual(self.chosen("2026-09-30T11:33:00Z", next_count=0), ["btc-updown-15m-1790767800", "eth-updown-5m-1790767800"])
        self.assertEqual(len([s for s in self.chosen("2026-09-30T11:33:00Z", next_count=2) if s.startswith("btc")]), 3)

    def test_subscription_diff_at_a_rollover(self) -> None:
        before = core.tokens_of(core.select_windows(self.windows, at("2026-09-30T11:44:59Z")))
        after = core.tokens_of(core.select_windows(self.windows, at("2026-09-30T11:45:31Z")))
        add, remove = core.plan_subscription_change(before, after)
        # Leaving: run 8's window (ended 11:45 + 30 s linger) and the eth 11:40 window.
        self.assertEqual(set(remove), set(RUN8_TOKENS) | {str(10**70 + n) for n in (11, 12)})
        # Arriving: the btc 12:00 window, now the next one.
        self.assertEqual(set(add), {str(10**70 + 3), str(10**70 + 4)})
        self.assertEqual(core.plan_subscription_change(after, after), ([], []))

    def test_frames_follow_the_documented_shapes(self) -> None:
        self.assertEqual(
            core.subscribe_frame(["2", "1"]),
            {"assets_ids": ["1", "2"], "type": "market", "custom_feature_enabled": False, "initial_dump": True},
        )
        self.assertEqual(core.update_frame("unsubscribe", ["9"]), {"assets_ids": ["9"], "operation": "unsubscribe"})
        self.assertEqual(
            core.update_frame("subscribe", ["9"]),
            {"assets_ids": ["9"], "operation": "subscribe", "custom_feature_enabled": False},
        )
        with self.assertRaises(ValueError):
            core.update_frame("resubscribe", ["9"])

    def test_backoff_is_bounded(self) -> None:
        self.assertEqual(core.backoff_delay(0, 0.0), core.RECONNECT_BASE_S)
        self.assertEqual(core.backoff_delay(0, 1.0), 0.25)
        self.assertEqual(core.backoff_delay(3, 1.0), 2.0)
        self.assertEqual(core.backoff_delay(30, 1.0), core.RECONNECT_MAX_S)
        self.assertLessEqual(core.backoff_delay(30, 0.5), core.RECONNECT_MAX_S)

    def test_backoff_is_defined_for_any_attempt_count(self) -> None:
        # 0.25 * 2**1024 overflows a float; a long outage must never reach it.
        for attempt in (1023, 1024, 5000, 10**6):
            self.assertEqual(core.backoff_delay(attempt, 1.0), core.RECONNECT_MAX_S)
            self.assertEqual(core.backoff_delay(attempt, 0.5), core.RECONNECT_MAX_S / 2)


class FrameDecoding(unittest.TestCase):
    def test_every_recorded_frame_decodes(self) -> None:
        kinds: dict[str, int] = {}
        for record in load_frames():
            decoded = core.decode_frame(record["payloadUtf8"])
            self.assertNotEqual(decoded.kind, "unparsable", record["payloadUtf8"][:80])
            if decoded.kind == "pong":
                kinds["pong"] = kinds.get("pong", 0) + 1
            for event in decoded.events:
                kind = core.event_type(event)
                kinds[kind] = kinds.get(kind, 0) + 1
                self.assertEqual(core.event_market(event), RUN8_CONDITION)
        self.assertEqual(kinds["pong"], 2)
        self.assertEqual(kinds["price_change"], 20)
        self.assertEqual(kinds["last_trade_price"], 2)
        self.assertEqual(kinds["book"], 5)  # 3 single-event frames + the array's 2 entries (one per token)

    def test_the_initial_dump_is_one_array_frame(self) -> None:
        arrays = [r for r in load_frames() if r["payloadUtf8"].lstrip().startswith("[")]
        self.assertEqual(len(arrays), 1)
        decoded = core.decode_frame(arrays[0]["payloadUtf8"])
        self.assertEqual(decoded.kind, "events")
        self.assertEqual(len(decoded.events), 2)  # one book per token of the run-8 market
        self.assertTrue(all(core.event_type(e) == "book" for e in decoded.events))
        self.assertEqual({e["asset_id"] for e in decoded.events}, set(RUN8_TOKENS))

    def test_odd_frames(self) -> None:
        self.assertEqual(core.decode_frame(" PONG\n").kind, "pong")
        self.assertEqual(core.decode_frame("").kind, "unparsable")
        self.assertEqual(core.decode_frame("PING?").kind, "unparsable")
        self.assertEqual(core.decode_frame("42").kind, "unparsable")
        mixed = core.decode_frame('[{"event_type":"book","market":"m"}, 7]')
        self.assertEqual((mixed.kind, len(mixed.events), mixed.non_object_items), ("events", 1, 1))

    def test_envelope_estimate(self) -> None:
        self.assertEqual(core.envelope_estimate({"event_type": "price_change", "price_changes": [{}, {}, {}]}), 3)
        self.assertEqual(core.envelope_estimate({"event_type": "price_change"}), 0)
        self.assertEqual(core.envelope_estimate({"event_type": "book"}), 1)
        self.assertEqual(core.envelope_estimate({"event_type": "last_trade_price"}), 1)

    def test_apportioned_bytes_sum_to_the_frame(self) -> None:
        events = [{"a": "x" * 10}, {"a": "x" * 30}, {"b": 1}]
        for size in (0, 1, 7, 1000, 12345):
            shares = core.apportion_bytes(size, events)
            self.assertEqual(sum(shares), size)
            self.assertEqual(len(shares), 3)
        self.assertEqual(core.apportion_bytes(10, []), [])
        self.assertEqual(core.apportion_bytes(10, [{}]), [10])


class Counting(unittest.TestCase):
    def setUp(self) -> None:
        windows, _ = core.parse_gamma_events(load_events(), WANTED)
        self.registry = {w.condition_id: w for w in windows}
        self.frames = load_frames()

    def replay(self, stats: core.Stats) -> None:
        for record in self.frames:
            stats.record_frame(at(record["receivedAt"]), "btc-up-or-down-15m", record["payloadUtf8"], self.registry)

    def test_totals_match_the_frames(self) -> None:
        stats = core.Stats()
        self.replay(stats)
        payload_bytes = sum(len(r["payloadUtf8"].encode("utf-8")) for r in self.frames)
        self.assertEqual(stats.total_bytes, payload_bytes)
        self.assertEqual(stats.total_frames, len(self.frames))
        market = stats.markets[RUN8_CONDITION]
        pong_bytes = stats.control["btc-up-or-down-15m"][1]
        self.assertEqual(market.counts[core.BYTES] + pong_bytes, payload_bytes)
        self.assertEqual(market.counts[core.FRAMES], len(self.frames) - 2)
        self.assertEqual(market.event_types["price_change"], 20)
        expected_envelopes = 0
        for record in self.frames:
            for event in core.decode_frame(record["payloadUtf8"]).events:
                expected_envelopes += core.envelope_estimate(event)
        self.assertEqual(market.counts[core.ENVELOPES], expected_envelopes)
        bucket_total = sum(v[core.BYTES] for v in stats.buckets["btc-up-or-down-15m"].values())
        self.assertEqual(bucket_total, market.counts[core.BYTES])

    def test_unknown_markets_use_the_connection_series(self) -> None:
        stats = core.Stats()
        stats.record_frame(100.0, "eth-up-or-down-5m", '{"event_type":"book","market":"0xunknown"}', self.registry)
        stats.record_frame(100.5, "eth-up-or-down-5m", '{"event_type":"book"}', self.registry)
        self.assertEqual(stats.markets["0xunknown"].series, "eth-up-or-down-5m")
        self.assertEqual(stats.markets[core.UNATTRIBUTED].counts[core.EVENTS], 1)

    def test_per_second_rows_drain_once_and_track_the_peak(self) -> None:
        stats = core.Stats()
        for i in range(5):
            stats.record_frame(1000.2, "s", '{"event_type":"price_change","market":"m","price_changes":[{},{}]}', {})
        stats.record_frame(1001.7, "s", '{"event_type":"book","market":"m"}', {})
        rows = stats.drain_seconds(1001)
        self.assertEqual([r[0] for r in rows], [1000])
        self.assertEqual(rows[0][1]["s"], [5, 5, 10, rows[0][1]["s"][core.BYTES]])
        self.assertEqual(stats.drain_seconds(1001), [])
        self.assertEqual(stats.peak_1s["s"], (10, 1000))
        self.assertEqual([r[0] for r in stats.drain_seconds(2000)], [1001])


class Summary(unittest.TestCase):
    def test_window_open_statistics_on_a_synthetic_burst(self) -> None:
        windows, _ = core.parse_gamma_events(load_events(), ["btc-up-or-down-15m"])
        registry = {w.condition_id: w for w in windows}
        open_t = at("2026-09-30T11:45:00Z")
        start, end = open_t - 600, open_t + 600
        stats = core.Stats()
        # 1 event/s everywhere on the run-8 market; 50 extra events/s for the 10 s after the open.
        body = '{"event_type":"price_change","market":"%s","price_changes":[{}]}' % RUN8_CONDITION
        for second in range(int(start), int(end)):
            stats.record_frame(second + 0.5, "btc-up-or-down-15m", body, registry)
            if open_t <= second < open_t + 10:
                for _ in range(50):
                    stats.record_frame(second + 0.6, "btc-up-or-down-15m", body, registry)
        summary = core.summarize(stats, registry, ["btc-up-or-down-15m"], start, end)
        series = summary["perSeries"]["btc-up-or-down-15m"]
        opens = series["atWindowOpens"]
        # Opens inside the recording with their whole [-30 s, +90 s) interval: 11:45 only
        # (11:30 is 15 min before the open - 600 s start; 12:00 is past the end).
        self.assertEqual(opens["opens"], 1)
        self.assertEqual(opens["peak10sEnvelopesPerSecond"], 51.0)
        self.assertEqual(opens["p95_10sEnvelopesPerSecond"], 51.0)  # 1 of 12 buckets is the burst
        self.assertEqual(series["whole"]["p50_10sEnvelopesPerSecond"], 1.0)
        self.assertEqual(series["peak1sEnvelopesPerSecond"], 51)
        self.assertEqual(series["events"], 1200 + 500)
        self.assertAlmostEqual(series["bytesPerDay"], series["bytes"] * 86400 / 1200)
        self.assertEqual(summary["all"]["atAlignedOpens"]["opens"], 1)
        self.assertEqual(summary["perAsset"]["btc"]["events"], 1700)
        self.assertEqual(summary["durationSeconds"], 1200)
        self.assertEqual(json.loads(json.dumps(summary))["perSeries"]["btc-up-or-down-15m"]["asset"], "btc")

    def test_partial_summaries_neither_drain_nor_split_seconds(self) -> None:
        stats = core.Stats()
        body = '{"event_type":"price_change","market":"m","price_changes":[{}]}'
        truth: dict[int, int] = {}

        def frame(t: float, times: int = 1) -> None:
            for _ in range(times):
                stats.record_frame(t, "s", body, {})
            truth[int(t)] = truth.get(int(t), 0) + times

        for second in range(1000, 1004):
            frame(second + 0.1)
        frame(1004.2, 5)
        first = core.summarize(stats, {}, ["s"], 1000.0, 1004.5)  # a partial summary mid-second
        self.assertEqual(first["perSeries"]["s"]["peak1sEnvelopesPerSecond"], 5)  # the buffered second counts
        frame(1004.8, 7)  # the same second continues after the partial summary
        second = core.summarize(stats, {}, ["s"], 1000.0, 1004.9)
        self.assertEqual(second["perSeries"]["s"]["peak1sEnvelopesPerSecond"], 12)
        self.assertEqual(second["perSeries"]["s"]["peak1sAt"], core.iso(1004))
        rows = stats.drain_seconds(10**9)  # what the recorder writes to per-second.jsonl.gz
        self.assertEqual({t: row["s"][core.EVENTS] for t, row in rows}, truth)
        self.assertEqual(stats.peak_1s["s"], (12, 1004))

    def test_covered_buckets_are_the_whole_buckets_only(self) -> None:
        self.assertEqual(core._covered_buckets(1003.0, 1047.0, 10), range(101, 104))
        self.assertEqual(core._covered_buckets(1000.0, 1040.0, 10), range(100, 104))
        self.assertEqual(core._covered_buckets(1003.0, 1009.0, 10), range(101, 101))

    def test_open_interval_runs_from_30_s_before_to_90_s_after(self) -> None:
        open_t = 100_000.0
        covered = range(9_000, 11_000)
        counts = {b: [0, 0, 10, 0] for b in covered}  # 1 envelope/s everywhere
        counts[int((open_t + 80) // 10)] = [0, 0, 500, 0]  # 50/s in the bucket starting at T+80 s
        counts[int((open_t + 90) // 10)] = [0, 0, 900, 0]  # 90/s at T+90 s: outside the interval
        counts[int((open_t - 40) // 10)] = [0, 0, 700, 0]  # 70/s at T-40 s: outside the interval
        stats = core.open_stats(counts, [open_t], covered, 10)
        self.assertEqual(stats["intervalSeconds"], [-30, 90])
        self.assertEqual(stats["opens"], 1)
        self.assertEqual(stats["peak10sEnvelopesPerSecond"], 50.0)
        # 12 buckets (T-30 .. T+80); nearest-rank p95 of 12 values is the 12th: the peak.
        self.assertEqual(stats["p95_10sEnvelopesPerSecond"], 50.0)

    def test_aligned_opens_are_the_quarter_hours_only(self) -> None:
        opens_at = ["2026-09-30T11:35:00Z", "2026-09-30T11:40:00Z", "2026-09-30T11:45:00Z", "2026-09-30T11:50:00Z"]
        windows = {}
        for index, text in enumerate(opens_at):
            start = at(text)
            windows[f"c{index}"] = core.Window("btc-up-or-down-5m", "btc", f"e{index}", str(index), f"c{index}", start, start + 300, ("t",), ())
        begin, end = at("2026-09-30T11:30:00Z"), at("2026-09-30T12:00:00Z")
        stats = core.Stats()
        for second in range(int(begin), int(end)):
            stats.record_frame(second + 0.5, "btc-up-or-down-5m", '{"event_type":"book","market":"c0"}', windows)
        summary = core.summarize(stats, windows, ["btc-up-or-down-5m"], begin, end)
        aligned = summary["all"]["atAlignedOpens"]
        self.assertEqual(aligned["opens"], 1)
        self.assertEqual([o["open"] for o in aligned["busiestOpens"]], ["2026-09-30T11:45:00.000Z"])
        self.assertEqual(summary["all"]["atAnyOpen"]["opens"], 4)

    def test_percentile_nearest_rank(self) -> None:
        self.assertIsNone(core.percentile([], 0.95))
        self.assertEqual(core.percentile([3.0], 0.95), 3.0)
        values = [float(v) for v in range(1, 101)]
        self.assertEqual(core.percentile(values, 0.95), 95.0)
        self.assertEqual(core.percentile(values, 0.5), 50.0)
        self.assertEqual(core.percentile(values, 1.0), 100.0)

    def test_empty_recording_summarizes(self) -> None:
        summary = core.summarize(core.Stats(), {}, ["btc-up-or-down-5m"], 1000.0, 1000.0)
        self.assertEqual(summary["all"]["events"], 0)
        self.assertIsNone(summary["all"]["bytesPerDay"])
        self.assertEqual(summary["perSeries"]["btc-up-or-down-5m"]["atWindowOpens"]["opens"], 0)


# ---------------------------------------------------------------------------
# Polymarket Protocol V2 (V2-2: plan rows A15 and D10). The official V2
# captures are VENUE-4's, under test/fixtures/venue/protocol-v2/ (README
# there); `fixtures/gamma-events-v2.json` derives its V2 market from them.
# ---------------------------------------------------------------------------

PROTOCOL_V2 = HERE.parents[3] / "test" / "fixtures" / "venue" / "protocol-v2"
V2_SERIES = "btc-up-or-down-5m"
DROP = object()


def load_v2_events() -> list:
    return json.loads((FIXTURES / "gamma-events-v2.json").read_text(encoding="utf-8"))["events"]


def protocol_v2(name: str) -> Any:
    """One VENUE-4 capture, read as the strict JSON its README says it is."""
    return json.loads((PROTOCOL_V2 / name).read_text(encoding="utf-8"))


def v2_session_records() -> list[dict]:
    """The VENUE-4 market-channel session (S-W01), one `{t, dir, data}` record per line."""
    lines = (PROTOCOL_V2 / "ws-market-v2-session.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def docs_example_market() -> dict:
    """A fresh copy of the documented V2 market as the V2 fixture carries it."""
    return copy.deepcopy(load_v2_events()[0]["markets"][0])


def one_market_event(market: dict) -> list:
    return [{"slug": "btc-updown-5m-case", "seriesSlug": V2_SERIES, "markets": [market]}]


class ProtocolV2Selection(unittest.TestCase):
    """`select_token_ids`: the documented rule (F-38 to F-40) and A1's refusals."""

    def test_the_documented_v2_market_is_admitted_by_its_position_ids(self) -> None:
        windows, problems = core.parse_gamma_events(load_v2_events(), [V2_SERIES])
        self.assertEqual(problems, [])
        docs = next(w for w in windows if w.event_slug == "btc-updown-5m-v2-docs-example")
        official = protocol_v2("gamma-market-v2-docs-example.jsonc")
        official_event = protocol_v2("gamma-event-v2-docs-example.jsonc")
        # The fixture's V2 market is the documentation's, field for field.
        self.assertEqual(official["version"], "v2")
        self.assertIsNone(official["clobTokenIds"])
        self.assertEqual(docs.token_ids, tuple(official["positionIds"]))
        self.assertEqual(docs.condition_id, official_event["markets"][0]["conditionId"])
        self.assertEqual(len(docs.condition_id), 2 + 62)  # Gamma's documented 31-byte form, kept as the identity
        self.assertEqual([len(token) for token in docs.token_ids], [75, 75])
        self.assertEqual(docs.outcomes, ("Yes", "No"))
        # They are what the recorder subscribes.
        self.assertEqual(core.subscribe_frame(core.tokens_of([docs]))["assets_ids"], sorted(official["positionIds"]))

    def test_v2_chooses_position_ids_even_when_clob_token_ids_is_populated(self) -> None:
        windows, _ = core.parse_gamma_events(load_v2_events(), [V2_SERIES])
        both = next(w for w in windows if w.event_slug == "btc-updown-5m-v2-both-fields")
        market = load_v2_events()[1]["markets"][0]
        self.assertEqual(both.token_ids, tuple(market["positionIds"]))
        self.assertTrue(set(both.token_ids).isdisjoint(json.loads(market["clobTokenIds"])))

    def test_v1_chooses_clob_token_ids_even_when_position_ids_is_populated(self) -> None:
        windows, _ = core.parse_gamma_events(load_v2_events(), [V2_SERIES])
        v1 = next(w for w in windows if w.event_slug == "btc-updown-5m-v1-both-fields")
        market = load_v2_events()[2]["markets"][0]
        self.assertEqual(v1.token_ids, tuple(json.loads(market["clobTokenIds"])))
        self.assertTrue(set(v1.token_ids).isdisjoint(market["positionIds"]))

    def test_the_v1_fixture_gives_the_windows_and_problems_it_gave_before(self) -> None:
        windows, problems = core.parse_gamma_events(load_events(), WANTED)
        self.assertEqual(len(windows), 7)
        self.assertEqual(
            sorted(problems),
            [
                "sol-up-or-down-5m sol-updown-5m-1790767800 market '9000009': eventStartTime/endDate missing or not increasing",
                # Word for word the problem fdc3430 reported for this market.
                "xrp-up-or-down-5m xrp-updown-5m-1790767800 market '9000008': clobTokenIds missing or malformed",
            ],
        )
        for window in windows:
            self.assertEqual(len(window.token_ids), 2)

    def test_a_market_without_version_is_refused_by_name(self) -> None:
        # The trimmed V1 fixture as it was before V2-2 added `version`: every market is refused, none admitted.
        events = load_events()
        for event in events:
            for market in event.get("markets", []):
                del market["version"]
        windows, problems = core.parse_gamma_events(events, ["btc-up-or-down-15m"])
        self.assertEqual(windows, [])
        self.assertEqual(len(problems), 4)
        self.assertTrue(all(p.endswith("no version, so the id field cannot be chosen (F-39)") for p in problems))

    def test_each_refusal_is_named_and_admits_nothing(self) -> None:
        ids = docs_example_market()["positionIds"]
        first, second = ids

        def v2(**changes: Any) -> dict:
            market = docs_example_market()
            for key, value in changes.items():
                if value is DROP:
                    del market[key]
                else:
                    market[key] = value
            return market

        def v1(**changes: Any) -> dict:
            return v2(**{"version": "v1", "clobTokenIds": json.dumps(ids), **changes})

        non_decimal = "version v2: positionIds holds the non-decimal id {!r} (F-39)"
        cases: list[tuple[str, dict, str]] = [
            ("version absent", v2(version=DROP), "no version, so the id field cannot be chosen (F-39)"),
            ("version null", v2(version=None), "version is null, so the id field cannot be chosen (F-39)"),
            ("version unknown", v2(version="v3"), "unsupported version 'v3' (F-39, F-40)"),
            ("version in another case", v2(version="V2"), "unsupported version 'V2' (F-39, F-40)"),
            ("version empty", v2(version=""), "unsupported version '' (F-39, F-40)"),
            ("version a number", v2(version=2), "unsupported version 2 (F-39, F-40)"),
            ("version a list", v2(version=["v2"]), "unsupported version ['v2'] (F-39, F-40)"),
            ("positionIds absent", v2(positionIds=DROP), "version v2: positionIds is absent or null, so the ids are not yet available (F-40)"),
            ("positionIds null", v2(positionIds=None), "version v2: positionIds is absent or null, so the ids are not yet available (F-40)"),
            ("positionIds JSON-encoded", v2(positionIds=json.dumps(ids)), "version v2: positionIds is malformed, not an array of strings (F-38)"),
            ("positionIds numbers", v2(positionIds=[int(first), int(second)]), "version v2: positionIds is malformed, not an array of strings (F-38)"),
            ("positionIds an object", v2(positionIds={"0": first, "1": second}), "version v2: positionIds is malformed, not an array of strings (F-38)"),
            ("no id", v2(positionIds=[]), "version v2: positionIds holds 0 ids, not exactly two"),
            ("one id", v2(positionIds=[first]), "version v2: positionIds holds 1 ids, not exactly two"),
            ("three ids", v2(positionIds=[first, second, "7"]), "version v2: positionIds holds 3 ids, not exactly two"),
            ("hex id", v2(positionIds=["0x1", second]), non_decimal.format("0x1")),
            ("leading zero", v2(positionIds=["0" + first, second]), non_decimal.format("0" + first)),
            ("signed id", v2(positionIds=["+" + first, second]), non_decimal.format("+" + first)),
            ("padded id", v2(positionIds=[first + " ", second]), non_decimal.format(first + " ")),
            ("trailing newline", v2(positionIds=[first, second + "\n"]), non_decimal.format(second + "\n")),
            ("fraction", v2(positionIds=[first + ".0", second]), non_decimal.format(first + ".0")),
            ("empty id", v2(positionIds=["", second]), non_decimal.format("")),
            ("non-ASCII digits", v2(positionIds=["١٢", second]), non_decimal.format("١٢")),
            ("equal ids", v2(positionIds=[first, first]), "version v2: positionIds holds the same id twice"),
            # A V1 field that is absent, null, malformed or empty keeps fdc3430's exact refusal text.
            ("v1 clobTokenIds absent", v1(clobTokenIds=DROP), "clobTokenIds missing or malformed"),
            ("v1 clobTokenIds null", v1(clobTokenIds=None), "clobTokenIds missing or malformed"),
            ("v1 clobTokenIds not JSON", v1(clobTokenIds="not json"), "clobTokenIds missing or malformed"),
            ("v1 clobTokenIds empty", v1(clobTokenIds="[]"), "clobTokenIds missing or malformed"),
            ("v1 one id", v1(clobTokenIds=json.dumps([first])), "version v1: clobTokenIds holds 1 ids, not exactly two"),
            ("v1 non-decimal id", v1(clobTokenIds=json.dumps(["abc", second])), "version v1: clobTokenIds holds the non-decimal id 'abc' (F-39)"),
            ("v1 equal ids", v1(clobTokenIds=json.dumps([second, second])), "version v1: clobTokenIds holds the same id twice"),
        ]
        for name, market, reason in cases:
            with self.subTest(name):
                windows, problems = core.parse_gamma_events(one_market_event(market), [V2_SERIES])
                self.assertEqual(windows, [])
                self.assertEqual(problems, [f"{V2_SERIES} btc-updown-5m-case market '1': {reason}"])
                self.assertEqual(core.select_token_ids(market), (None, reason))

    def test_the_admitted_shapes(self) -> None:
        ids = docs_example_market()["positionIds"]
        self.assertEqual(core.select_token_ids(docs_example_market()), (tuple(ids), None))
        # V1 keeps both spellings it has always accepted for clobTokenIds.
        for spelling in (json.dumps(ids), list(ids)):
            self.assertEqual(core.select_token_ids({"version": "v1", "clobTokenIds": spelling}), (tuple(ids), None))
        self.assertEqual(core.select_token_ids({"version": "v2", "positionIds": ["0", "1"]}), (("0", "1"), None))


class ProtocolV2Attribution(unittest.TestCase):
    """`window_for_market`: a frame's condition id finds its window under either width (F-43, F-62)."""

    def setUp(self) -> None:
        canary = protocol_v2("clob-markets-v2.jsonc")
        self.c64 = canary["c"]  # the 32-byte form the CLOB and the market channel served (S-L01, S-W01)
        self.assertTrue(self.c64.endswith("00"))
        self.c62 = self.c64[:-2]  # the 31-byte form: Gamma's documented width (F-40, F-43)
        self.ids = tuple(entry["t"] for entry in canary["t"])  # index 0 Up (YES), index 1 Down (NO)
        start = at("2026-10-05T23:15:00Z")
        # Gamma lists no canary (O.1): this window is SYNTHETIC apart from its ids.
        self.window = core.Window(V2_SERIES, "btc", "synthetic-v2-canary", "", self.c62, start, start + 300, self.ids, ("Up", "Down"))

    def test_the_v2_session_is_attributed_to_its_31_byte_window(self) -> None:
        records = [r for r in v2_session_records() if r["dir"] == "recv"]
        self.assertEqual(len(records), 7)
        stats = core.Stats()
        registry = {self.c62: self.window}
        for record in records:
            stats.record_frame(at(record["t"]), V2_SERIES, record["data"], registry)
        # The one V2 `book` frame lands on the window, under the window's own id.
        self.assertNotIn(self.c64, stats.markets)
        self.assertEqual(stats.markets[self.c62].counts[core.EVENTS], 1)
        self.assertEqual(stats.markets[self.c62].event_types, {"book": 1})
        self.assertEqual(stats.control[V2_SERIES][0], 5)  # the five PONGs
        start, end = at("2026-10-05T23:15:25Z"), at("2026-10-05T23:16:26Z")
        summary = core.summarize(stats, registry, [V2_SERIES], start, end)
        self.assertEqual(
            [(row["conditionId"], row["events"], row["eventTypes"]) for row in summary["windows"]],
            [(self.c62, 1, {"book": 1})],
        )
        # The unrelated `new_market` frame stays under its own condition id.
        others = [key for key in stats.markets if key != self.c62]
        self.assertEqual(len(others), 1)
        self.assertEqual(stats.markets[others[0]].event_types, {"new_market": 1})

    def test_the_exact_id_wins_and_the_other_width_is_only_a_fallback(self) -> None:
        exact = core.Window(V2_SERIES, "btc", "exact", "", self.c64, 0.0, 300.0, ("1", "2"), ())
        both = {self.c62: self.window, self.c64: exact}
        self.assertIs(core.window_for_market(both, self.c64), exact)
        self.assertIs(core.window_for_market(both, self.c62), self.window)
        self.assertIs(core.window_for_market({self.c62: self.window}, self.c64), self.window)
        # A 31-byte id on the wire finds a 32-byte window too.
        self.assertIs(core.window_for_market({self.c64: exact}, self.c62), exact)

    def test_a_nonzero_final_byte_and_other_strings_are_never_narrowed(self) -> None:
        registry = {self.c62: self.window}
        self.assertIsNone(core.window_for_market(registry, self.c62 + "01"))
        self.assertIsNone(core.window_for_market(registry, None))
        self.assertIsNone(core.window_for_market(registry, "0xunknown"))
        self.assertIsNone(core.window_for_market(registry, self.c62[:-2]))
        self.assertIsNone(core._other_condition_width("0x" + "ab" * 33))
        self.assertIsNone(core._other_condition_width(self.c62 + "0"))

    def test_v1_attribution_is_unchanged(self) -> None:
        # A V1 condition id is 32 bytes and Gamma serves that form (O.5): found exactly, as before.
        windows, _ = core.parse_gamma_events(load_events(), WANTED)
        registry = {w.condition_id: w for w in windows}
        self.assertIs(core.window_for_market(registry, RUN8_CONDITION), registry[RUN8_CONDITION])
        self.assertIsNone(core.window_for_market(registry, RUN8_CONDITION[:-2]))


class HistoricalUnversionedInput(unittest.TestCase):
    """The 2026-09-30 trim of `fixtures/gamma-events.json`, as it was before V2-2
    added `"version": "v1"` to every market (its `_provenance`), is refused
    market by market (V2-2 review finding V2-2-R1-02).

    Acceptance 4 refuses a missing `version` (F-39), and the refusal is not
    relaxed for old input. This version-less shape is therefore the one V1 input
    whose output V2-2 changes; the change is visible (each market is named) and
    admits nothing. With `version: "v1"` present, the output is fdc3430's
    (`ProtocolV2Selection.test_the_v1_fixture_gives_the_windows_and_problems_it_gave_before`).
    """

    NO_VERSION = "no version, so the id field cannot be chosen (F-39)"

    def historical_events(self) -> list:
        """The fixture without the key V2-2 added; every market carried it as "v1"."""
        events = load_events()
        for event in events:
            for market in event.get("markets", []):
                self.assertEqual(market.pop("version"), "v1")
        return events

    def test_the_whole_historical_input_is_refused_market_by_market(self) -> None:
        windows, problems = core.parse_gamma_events(self.historical_events(), WANTED)
        self.assertEqual(windows, [])
        self.assertEqual(
            sorted(problems),
            [
                f"btc-up-or-down-15m btc-updown-15m-1790766900 market '9000003': {self.NO_VERSION}",
                f"btc-up-or-down-15m btc-updown-15m-1790767800 market '5121969': {self.NO_VERSION}",
                f"btc-up-or-down-15m btc-updown-15m-1790768700 market '9000001': {self.NO_VERSION}",
                f"btc-up-or-down-15m btc-updown-15m-1790769600 market '9000002': {self.NO_VERSION}",
                f"eth-up-or-down-5m eth-updown-5m-1790767800 market '9000004': {self.NO_VERSION}",
                f"eth-up-or-down-5m eth-updown-5m-1790768100 market '9000005': {self.NO_VERSION}",
                f"eth-up-or-down-5m eth-updown-5m-1790768400 market '9000006': {self.NO_VERSION}",
                # Checked before the ids, so its fdc3430 text stands.
                "sol-up-or-down-5m sol-updown-5m-1790767800 market '9000009': eventStartTime/endDate missing or not increasing",
                # Without a version there is no id field to read, malformed or not.
                f"xrp-up-or-down-5m xrp-updown-5m-1790767800 market '9000008': {self.NO_VERSION}",
            ],
        )

    def test_no_series_admits_a_window_from_it(self) -> None:
        windows, problems = core.parse_gamma_events(self.historical_events(), None)
        self.assertEqual(windows, [])
        self.assertEqual(sum(p.endswith(self.NO_VERSION) for p in problems), len(problems) - 1)


if __name__ == "__main__":
    unittest.main()
