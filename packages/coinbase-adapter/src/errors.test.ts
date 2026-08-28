import { describe, expect, it } from "vitest";

import {
  CoinbaseAdapterError,
  CoinbaseConfigurationError,
  CoinbaseStateError,
  CoinbaseTransportError,
} from "./errors.js";

describe("typed errors", () => {
  it("pair each class with its stable code", () => {
    expect(new CoinbaseConfigurationError("x").code).toBe("COINBASE_CONFIGURATION");
    expect(new CoinbaseStateError("x").code).toBe("COINBASE_STATE");
    expect(new CoinbaseTransportError("x").code).toBe("COINBASE_TRANSPORT");
  });

  it("are all CoinbaseAdapterError, so one catch handles the package", () => {
    for (const error of [
      new CoinbaseConfigurationError("x"),
      new CoinbaseStateError("x"),
      new CoinbaseTransportError("x"),
    ]) {
      expect(error).toBeInstanceOf(CoinbaseAdapterError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("report their own class name, not the base class name", () => {
    expect(new CoinbaseConfigurationError("x").name).toBe("CoinbaseConfigurationError");
    expect(new CoinbaseTransportError("x").name).toBe("CoinbaseTransportError");
  });

  it("carry a structured details bag, defaulting to empty", () => {
    expect(new CoinbaseStateError("x").details).toEqual({});
    expect(new CoinbaseConfigurationError("x", { field: "feedId" }).details).toEqual({
      field: "feedId",
    });
  });

  it("attach a cause only when one was given", () => {
    const cause = new Error("underlying");
    expect(new CoinbaseTransportError("x", {}, cause).cause).toBe(cause);
    expect("cause" in new CoinbaseTransportError("x")).toBe(false);
  });
});
