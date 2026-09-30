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
No network is used.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
