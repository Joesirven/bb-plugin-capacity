import { describe, expect, it } from "vitest";
import { flagNumber, flagPresent, flagText, parseArgv } from "./argv.js";

describe("parseArgv", () => {
  it("separates positionals from flags", () => {
    const parsed = parseArgv(["cancel", "cap_123"]);
    expect(parsed.positionals).toEqual(["cancel", "cap_123"]);
  });

  it("reads both --flag value and --flag=value", () => {
    const parsed = parseArgv(["spawn", "--prompt", "do the thing", "--priority=5"]);
    expect(flagText(parsed, "prompt")).toBe("do the thing");
    expect(flagNumber(parsed, "priority", 0)).toBe(5);
  });

  it("treats a flag with no value as a switch", () => {
    const parsed = parseArgv(["queue", "--all", "--json"]);
    expect(flagPresent(parsed, "all")).toBe(true);
    expect(flagText(parsed, "all")).toBeUndefined();
  });

  it("does not swallow the next flag as a value", () => {
    const parsed = parseArgv(["spawn", "--hidden", "--prompt", "x"]);
    expect(flagPresent(parsed, "hidden")).toBe(true);
    expect(flagText(parsed, "prompt")).toBe("x");
  });

  it("falls back when a numeric flag is missing or unparseable", () => {
    expect(flagNumber(parseArgv([]), "limit", 20)).toBe(20);
    expect(flagNumber(parseArgv(["--limit", "lots"]), "limit", 20)).toBe(20);
  });
});
