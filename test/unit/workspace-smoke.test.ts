import { describe, expect, it } from "vitest";
import { workspacePackageName } from "@polymarket-bot/testkit";

describe("WP-010 workspace smoke", () => {
  it("resolves workspace packages through pnpm workspace linking", () => {
    expect(workspacePackageName).toBe("@polymarket-bot/testkit");
  });

  it("runs under a Node.js major version of 24 or newer", () => {
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(24);
  });
});
