// Captured by executing the codec at cda7119 BEFORE implementation edits.
// Deterministic versions of the existing codec fixtures, plus all optional fields
// and mixed nested JSON/key order. These strings are the HEAD wire bytes.
import type { EventEnvelope } from "@polymarket-bot/domain";

export const HONEST_FIXTURES: readonly { input: EventEnvelope<unknown>; encoded: string }[] = [
  {"input": {"eventId": "12345678-1234-7123-8123-123456789abc", "eventType": "BookSnapshot", "schemaVersion": 1, "source": "polymarket", "sourceChannel": "market", "receivedAt": "2026-09-07T00:00:00Z", "receivedMonotonicNs": "1000000000", "gatewayEpoch": "12345678-1234-4123-8123-123456789abc", "ingestSeq": "1", "payload": {"note": "opaque to the transport"}}, "encoded": "{\"eventId\":\"12345678-1234-7123-8123-123456789abc\",\"eventType\":\"BookSnapshot\",\"schemaVersion\":1,\"source\":\"polymarket\",\"sourceChannel\":\"market\",\"receivedAt\":\"2026-09-07T00:00:00Z\",\"receivedMonotonicNs\":\"1000000000\",\"gatewayEpoch\":\"12345678-1234-4123-8123-123456789abc\",\"ingestSeq\":\"1\",\"payload\":{\"note\":\"opaque to the transport\"}}"},
  {"input": {"eventId": "12345678-1234-7123-8123-123456789abc", "eventType": "BookSnapshot", "schemaVersion": 1, "source": "polymarket", "sourceChannel": "market", "receivedAt": "2026-09-07T00:00:00Z", "receivedMonotonicNs": "1000000000", "gatewayEpoch": "12345678-1234-4123-8123-123456789abc", "ingestSeq": "1", "payload": {"note": "opaque to the transport"}, "venueTimestamp": "2026-09-07T00:00:00Z", "connectionId": "connection", "subscriptionGeneration": 1, "rawSegmentId": "segment", "rawRecordOffset": "0", "correlationId": "correlation", "causationId": "cause"}, "encoded": "{\"eventId\":\"12345678-1234-7123-8123-123456789abc\",\"eventType\":\"BookSnapshot\",\"schemaVersion\":1,\"source\":\"polymarket\",\"sourceChannel\":\"market\",\"receivedAt\":\"2026-09-07T00:00:00Z\",\"receivedMonotonicNs\":\"1000000000\",\"gatewayEpoch\":\"12345678-1234-4123-8123-123456789abc\",\"ingestSeq\":\"1\",\"payload\":{\"note\":\"opaque to the transport\"},\"venueTimestamp\":\"2026-09-07T00:00:00Z\",\"connectionId\":\"connection\",\"subscriptionGeneration\":1,\"rawSegmentId\":\"segment\",\"rawRecordOffset\":\"0\",\"correlationId\":\"correlation\",\"causationId\":\"cause\"}"},
  {"input": {"eventId": "12345678-1234-7123-8123-123456789abc", "eventType": "BookSnapshot", "schemaVersion": 1, "source": "polymarket", "sourceChannel": "market", "receivedAt": "2026-09-07T00:00:00Z", "receivedMonotonicNs": "1000000000", "gatewayEpoch": "12345678-1234-4123-8123-123456789abc", "ingestSeq": "1", "payload": {"price": "0.4500", "size": "not-a-number-at-all", "nested": {"deeply": [1, "2", null, {"three": true}]}}}, "encoded": "{\"eventId\":\"12345678-1234-7123-8123-123456789abc\",\"eventType\":\"BookSnapshot\",\"schemaVersion\":1,\"source\":\"polymarket\",\"sourceChannel\":\"market\",\"receivedAt\":\"2026-09-07T00:00:00Z\",\"receivedMonotonicNs\":\"1000000000\",\"gatewayEpoch\":\"12345678-1234-4123-8123-123456789abc\",\"ingestSeq\":\"1\",\"payload\":{\"price\":\"0.4500\",\"size\":\"not-a-number-at-all\",\"nested\":{\"deeply\":[1,\"2\",null,{\"three\":true}]}}}"},
  {"input": {"eventId": "12345678-1234-7123-8123-123456789abc", "eventType": "BookSnapshot", "schemaVersion": 1, "source": "polymarket", "sourceChannel": "market", "receivedAt": "2026-09-07T00:00:00Z", "receivedMonotonicNs": "1000000000", "gatewayEpoch": "12345678-1234-4123-8123-123456789abc", "ingestSeq": "1", "payload": {"text": "límite · 資産 · 📈", "emptyObject": {}, "emptyArray": [], "explicitNull": null}}, "encoded": "{\"eventId\":\"12345678-1234-7123-8123-123456789abc\",\"eventType\":\"BookSnapshot\",\"schemaVersion\":1,\"source\":\"polymarket\",\"sourceChannel\":\"market\",\"receivedAt\":\"2026-09-07T00:00:00Z\",\"receivedMonotonicNs\":\"1000000000\",\"gatewayEpoch\":\"12345678-1234-4123-8123-123456789abc\",\"ingestSeq\":\"1\",\"payload\":{\"text\":\"límite · 資産 · 📈\",\"emptyObject\":{},\"emptyArray\":[],\"explicitNull\":null}}"},
  {"input": {"eventId": "12345678-1234-7123-8123-123456789abc", "eventType": "BookSnapshot", "schemaVersion": 1, "source": "polymarket", "sourceChannel": "market", "receivedAt": "2026-09-07T00:00:00Z", "receivedMonotonicNs": "1758000000123456789", "gatewayEpoch": "12345678-1234-4123-8123-123456789abc", "ingestSeq": "9007199254740993", "payload": {"note": "opaque to the transport"}}, "encoded": "{\"eventId\":\"12345678-1234-7123-8123-123456789abc\",\"eventType\":\"BookSnapshot\",\"schemaVersion\":1,\"source\":\"polymarket\",\"sourceChannel\":\"market\",\"receivedAt\":\"2026-09-07T00:00:00Z\",\"receivedMonotonicNs\":\"1758000000123456789\",\"gatewayEpoch\":\"12345678-1234-4123-8123-123456789abc\",\"ingestSeq\":\"9007199254740993\",\"payload\":{\"note\":\"opaque to the transport\"}}"},
  {"input": {"eventId": "12345678-1234-7123-8123-123456789abc", "eventType": "BookSnapshot", "schemaVersion": 1, "source": "polymarket", "sourceChannel": "market", "receivedAt": "2026-09-07T00:00:00Z", "receivedMonotonicNs": "1000000000", "gatewayEpoch": "12345678-1234-4123-8123-123456789abc", "ingestSeq": "1", "payload": {"2": "two", "10": "ten", "z": [false, 0, -1, 1.25, {"z": 1, "a": 2}], "a": null}}, "encoded": "{\"eventId\":\"12345678-1234-7123-8123-123456789abc\",\"eventType\":\"BookSnapshot\",\"schemaVersion\":1,\"source\":\"polymarket\",\"sourceChannel\":\"market\",\"receivedAt\":\"2026-09-07T00:00:00Z\",\"receivedMonotonicNs\":\"1000000000\",\"gatewayEpoch\":\"12345678-1234-4123-8123-123456789abc\",\"ingestSeq\":\"1\",\"payload\":{\"2\":\"two\",\"10\":\"ten\",\"z\":[false,0,-1,1.25,{\"z\":1,\"a\":2}],\"a\":null}}"},
];

// HEAD outcomes: non-object, no payload, bad formats, unknown key, provenance,
// then each declared field deleted in schema order (including optional accepts).
export const HEAD_OUTCOMES = [
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "an event envelope must be an object (§7.1)",
    "details": {
      "received": "object"
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "an event envelope must be an object (§7.1)",
    "details": {
      "received": "number"
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "an event envelope must carry a payload (§7.1)",
    "details": {}
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "eventId",
          "message": "must be a lowercase canonical UUIDv7"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "receivedAt",
          "message": "Invalid ISO datetime"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "",
          "message": "Unrecognized key: \"unexpected\""
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "payload.venue",
          "message": "payload venue \"binance\" contradicts envelope source \"polymarket\"; the envelope source is authoritative (§7.1)"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "eventId",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "source",
          "message": "Invalid option: expected one of \"polymarket\"|\"binance\"|\"coinbase\"|\"rtds\"|\"internal\""
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "sourceChannel",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "connectionId": "connection",
      "subscriptionGeneration": 1,
      "rawSegmentId": "segment",
      "rawRecordOffset": "0",
      "correlationId": "correlation",
      "causationId": "cause",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "receivedAt",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "receivedMonotonicNs",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "gatewayEpoch",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "ingestSeq",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "venueTimestamp": "2026-09-07T00:00:00Z",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "subscriptionGeneration": 1,
      "rawSegmentId": "segment",
      "rawRecordOffset": "0",
      "correlationId": "correlation",
      "causationId": "cause",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "venueTimestamp": "2026-09-07T00:00:00Z",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "connectionId": "connection",
      "rawSegmentId": "segment",
      "rawRecordOffset": "0",
      "correlationId": "correlation",
      "causationId": "cause",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "venueTimestamp": "2026-09-07T00:00:00Z",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "connectionId": "connection",
      "subscriptionGeneration": 1,
      "rawRecordOffset": "0",
      "correlationId": "correlation",
      "causationId": "cause",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "venueTimestamp": "2026-09-07T00:00:00Z",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "connectionId": "connection",
      "subscriptionGeneration": 1,
      "rawSegmentId": "segment",
      "correlationId": "correlation",
      "causationId": "cause",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "venueTimestamp": "2026-09-07T00:00:00Z",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "connectionId": "connection",
      "subscriptionGeneration": 1,
      "rawSegmentId": "segment",
      "rawRecordOffset": "0",
      "causationId": "cause",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": true,
    "values": {
      "eventId": "12345678-1234-7123-8123-123456789abc",
      "source": "polymarket",
      "sourceChannel": "market",
      "venueTimestamp": "2026-09-07T00:00:00Z",
      "receivedAt": "2026-09-07T00:00:00Z",
      "receivedMonotonicNs": "1000000000",
      "gatewayEpoch": "12345678-1234-4123-8123-123456789abc",
      "ingestSeq": "1",
      "connectionId": "connection",
      "subscriptionGeneration": 1,
      "rawSegmentId": "segment",
      "rawRecordOffset": "0",
      "correlationId": "correlation",
      "eventType": "BookSnapshot",
      "schemaVersion": 1,
      "payload": {
        "note": "opaque to the transport"
      }
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "eventType",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "value is not a valid §7.1 event envelope",
    "details": {
      "issues": [
        {
          "path": "schemaVersion",
          "message": "Invalid input: expected number, received undefined"
        }
      ]
    }
  },
  {
    "ok": false,
    "name": "EventBusEnvelopeError",
    "message": "an event envelope must carry a payload (§7.1)",
    "details": {}
  }
];
