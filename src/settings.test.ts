import { describe, expect, it } from "vitest";
import { parseSettings, SETTING_DESCRIPTORS } from "./settings.js";

describe("parseSettings", () => {
  it("falls back to the descriptor defaults when nothing is stored", () => {
    const parsed = parseSettings({});
    expect(parsed.maxActiveAgents).toBe(Number(SETTING_DESCRIPTORS.maxActiveAgents.default));
    expect(parsed.minFreeMemoryMb).toBe(Number(SETTING_DESCRIPTORS.minFreeMemoryMb.default));
    expect(parsed.enforcement).toBe("off");
  });

  it("reads stored strings as numbers", () => {
    const parsed = parseSettings({ maxActiveAgents: "6", maxLoadPerCore: "1.25" });
    expect(parsed.maxActiveAgents).toBe(6);
    expect(parsed.maxLoadPerCore).toBe(1.25);
  });

  it("clamps values outside the documented range instead of trusting them", () => {
    expect(parseSettings({ maxActiveAgents: "0" }).maxActiveAgents).toBe(1);
    expect(parseSettings({ maxActiveAgents: "9999" }).maxActiveAgents).toBe(64);
    expect(parseSettings({ warnAtPercent: "500" }).warnAtPercent).toBe(99);
    expect(parseSettings({ pollSeconds: "1" }).pollSeconds).toBe(5);
  });

  it("ignores unparseable values rather than producing NaN thresholds", () => {
    const parsed = parseSettings({ maxActiveAgents: "many", minFreeMemoryMb: "" });
    expect(parsed.maxActiveAgents).toBe(3);
    expect(parsed.minFreeMemoryMb).toBe(800);
  });

  it("only accepts the three documented enforcement modes", () => {
    expect(parseSettings({ enforcement: "all" }).enforcement).toBe("all");
    expect(parseSettings({ enforcement: "background-only" }).enforcement).toBe("background-only");
    // Anything else fails safe to warning-only.
    expect(parseSettings({ enforcement: "aggressive" }).enforcement).toBe("off");
  });
});
