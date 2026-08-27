import { describe, expect, it } from "vitest";

import type { BinanceSocketEvent } from "./connection.js";
import { BinanceConfigurationError } from "./errors.js";
import {
  createWebSocketFactory,
  decodeMessageData,
  type WebSocketConstructor,
  type WebSocketLike,
} from "./websocket.js";

/** A fake WHATWG socket: no network is opened anywhere in this suite. */
class FakeWebSocket implements WebSocketLike {
  public static last: FakeWebSocket | undefined;
  public binaryType = "blob";
  public readonly closeCalls: { code?: number; reason?: string }[] = [];
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  public constructor(public readonly url: string) {
    FakeWebSocket.last = this;
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.#listeners.get(type) ?? [];
    existing.push(listener);
    this.#listeners.set(type, existing);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  public fire(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const FakeConstructor = FakeWebSocket as unknown as WebSocketConstructor;

function drive(): {
  readonly events: BinanceSocketEvent[];
  readonly socket: FakeWebSocket;
  readonly handle: { close(code?: number, reason?: string): void };
} {
  const events: BinanceSocketEvent[] = [];
  const factory = createWebSocketFactory(FakeConstructor);
  const handle = factory({
    url: "wss://data-stream.binance.vision/stream?streams=btcusdt@trade",
    connectionId: "conn-1",
    onEvent: (event) => events.push(event),
  });
  const socket = FakeWebSocket.last;
  if (socket === undefined) {
    throw new Error("the factory did not construct a socket");
  }
  return { events, socket, handle };
}

describe("createWebSocketFactory", () => {
  it("asks for arraybuffer frames so a binary payload can be decoded (BNC-U1)", () => {
    const { socket } = drive();
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("passes the caller's connectionId through on OPEN", () => {
    const { events, socket } = drive();
    socket.fire("open", {});
    expect(events).toEqual([{ type: "OPEN", connectionId: "conn-1" }]);
  });

  it("delivers a text payload unchanged", () => {
    const { events, socket } = drive();
    socket.fire("message", { data: '{"e":"trade"}' });
    expect(events).toEqual([{ type: "MESSAGE", data: '{"e":"trade"}' }]);
  });

  it("decodes a binary payload as UTF-8", () => {
    const { events, socket } = drive();
    const bytes = new TextEncoder().encode('{"u":1}');
    socket.fire("message", { data: bytes.buffer });
    expect(events).toEqual([{ type: "MESSAGE", data: '{"u":1}' }]);
  });

  it("reports an undecodable binary payload rather than delivering a mangled frame", () => {
    const { events, socket } = drive();
    socket.fire("message", { data: new Uint8Array([0xff, 0xfe, 0xfd]).buffer });
    expect(events[0]?.type).toBe("ERROR");
    const event = events[0];
    if (event?.type !== "ERROR") {
      throw new Error("unreachable");
    }
    expect(event.reasonCode).toBe("BINANCE_FRAME_UNDECODABLE");
    expect(event.detail).toContain("payloadUtf8");
  });

  it("maps close events, carrying the code and reason when present", () => {
    const { events, socket } = drive();
    socket.fire("close", { code: 1006, reason: "abnormal closure" });
    expect(events).toEqual([{ type: "CLOSE", code: 1006, reason: "abnormal closure" }]);
  });

  it("omits an empty close reason rather than sending an empty string", () => {
    const { events, socket } = drive();
    socket.fire("close", { code: 1000, reason: "" });
    expect(events).toEqual([{ type: "CLOSE", code: 1000 }]);
  });

  it("forwards a socket error", () => {
    const { events, socket } = drive();
    socket.fire("error", { message: "connect ECONNREFUSED" });
    expect(events).toEqual([{ type: "ERROR", detail: "connect ECONNREFUSED" }]);
  });

  it("forwards a close() call to the underlying socket", () => {
    const { socket, handle } = drive();
    handle.close(1000, "shutting down");
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "shutting down" }]);
  });

  it("constructs the socket with a URL and nothing else — no credential surface", () => {
    const { socket } = drive();
    expect(socket.url).toBe("wss://data-stream.binance.vision/stream?streams=btcusdt@trade");
  });
});

describe("decodeMessageData", () => {
  it("accepts a string, an ArrayBuffer, and a typed-array view", () => {
    const bytes = new TextEncoder().encode("ok");
    expect(decodeMessageData("ok")).toEqual({ ok: true, text: "ok" });
    expect(decodeMessageData(bytes.buffer)).toEqual({ ok: true, text: "ok" });
    expect(decodeMessageData(bytes)).toEqual({ ok: true, text: "ok" });
  });

  it("refuses anything else with a stated reason", () => {
    const result = decodeMessageData(42);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.detail).toContain("BNC-U1");
  });
});

describe("resolveGlobalWebSocket", () => {
  it("names the problem when a runtime exposes no WebSocket", async () => {
    const { resolveGlobalWebSocket } = await import("./websocket.js");
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
      expect(() => resolveGlobalWebSocket()).toThrow(BinanceConfigurationError);
    } finally {
      if (original !== undefined) {
        (globalThis as { WebSocket?: unknown }).WebSocket = original;
      }
    }
  });
});
