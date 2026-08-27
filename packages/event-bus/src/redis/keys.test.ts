import { describe, expect, it } from "vitest";

import { EventBusConfigurationError } from "../errors.js";
import { assertConsumerId, assertStreamName, DEFAULT_KEY_PREFIX, streamKeys } from "./keys.js";

describe("streamKeys", () => {
  it("puts all four keys of one logical stream in one hash slot", () => {
    const keys = streamKeys(DEFAULT_KEY_PREFIX, "market");

    expect(keys).toStrictEqual({
      events: "pmb:events:{market}:events",
      published: "pmb:events:{market}:published",
      checkpoints: "pmb:events:{market}:checkpoints",
      origin: "pmb:events:{market}:origin",
    });
    const tag = /\{([^}]+)\}/u;
    const tags = [keys.events, keys.published, keys.checkpoints, keys.origin].map(
      (key) => tag.exec(key)?.[1],
    );
    expect(new Set(tags).size).toBe(1);
  });

  it("keeps two namespaces' instance markers apart, so a token cannot cross them", () => {
    expect(streamKeys("alt.ns", "market").origin).not.toBe(
      streamKeys(DEFAULT_KEY_PREFIX, "market").origin,
    );
  });

  it("keeps two logical streams apart", () => {
    expect(streamKeys(DEFAULT_KEY_PREFIX, "market").events).not.toBe(
      streamKeys(DEFAULT_KEY_PREFIX, "reference").events,
    );
  });

  it("honours a custom namespace", () => {
    expect(streamKeys("alt.ns", "market").events).toBe("alt.ns:{market}:events");
  });
});

describe("name validation", () => {
  it("accepts the bounded code vocabulary", () => {
    for (const name of ["market", "reference-feed", "a.b:c_d", "t-run-0a1b2c"]) {
      expect(() => assertStreamName(name)).not.toThrow();
      expect(() => assertConsumerId(name)).not.toThrow();
    }
  });

  it("rejects a name that could address a different key than it reads", () => {
    for (const name of ["", "{market}", "market name", "market\n", "1market", "market/other", "*"]) {
      expect(() => assertStreamName(name)).toThrow(EventBusConfigurationError);
      expect(() => assertConsumerId(name)).toThrow(EventBusConfigurationError);
    }
  });

  it("rejects an unbounded name", () => {
    expect(() => assertStreamName(`a${"b".repeat(200)}`)).toThrow(EventBusConfigurationError);
  });

  it("rejects a namespace with the same problems", () => {
    expect(() => streamKeys("bad prefix", "market")).toThrow(EventBusConfigurationError);
  });
});
