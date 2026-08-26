import { describe, expect, it } from "vitest";
import type { HostSample } from "./host-sample.js";
import { admits, describe as describeReading, evaluate, type CapacityLimits } from "./policy.js";

const HEALTHY: HostSample = {
  takenAt: 1_700_000_000_000,
  memoryAvailableMb: 4000,
  memoryTotalMb: 8000,
  swapUsedMb: 0,
  swapTotalMb: 4000,
  loadPerCore: 0.3,
  cpuCount: 4,
  eventLoopLagMs: 5,
};

const LIMITS: CapacityLimits = {
  maxActiveAgents: 4,
  warnAtPercent: 50,
  minFreeMemoryMb: 800,
  maxLoadPerCore: 2,
  maxEventLoopLagMs: 500,
};

describe("evaluate", () => {
  it("reports ok on an idle healthy host", () => {
    const reading = evaluate(HEALTHY, { activeThreads: 0, backgroundAgents: 0 }, LIMITS);
    expect(reading.level).toBe("ok");
    expect(reading.slotsFree).toBe(4);
    expect(admits(reading)).toBe(true);
  });

  it("counts subagents against the same slot budget as threads", () => {
    const reading = evaluate(HEALTHY, { activeThreads: 1, backgroundAgents: 3 }, LIMITS);
    expect(reading.agentLoad).toBe(4);
    expect(reading.level).toBe("critical");
    expect(reading.slotsFree).toBe(0);
    expect(admits(reading)).toBe(false);
  });

  it("warns before the agent limit is reached", () => {
    const reading = evaluate(HEALTHY, { activeThreads: 2, backgroundAgents: 0 }, LIMITS);
    expect(reading.level).toBe("warn");
    // A warning still admits work; only critical holds it back.
    expect(admits(reading)).toBe(true);
    expect(reading.strained.join()).toContain("2 of 4 agent slots");
  });

  it("treats a memory floor breach as critical even with slots free", () => {
    const reading = evaluate(
      { ...HEALTHY, memoryAvailableMb: 500 },
      { activeThreads: 0, backgroundAgents: 0 },
      LIMITS,
    );
    expect(reading.level).toBe("critical");
    expect(reading.slotsFree).toBe(4);
    expect(admits(reading)).toBe(false);
    expect(reading.breached.join()).toContain("500MB memory available");
  });

  it("warns while memory is above the floor but heading toward it", () => {
    // warnAtPercent 50 puts the memory warning at 800 / 0.5 = 1600MB.
    const reading = evaluate(
      { ...HEALTHY, memoryAvailableMb: 1500 },
      { activeThreads: 0, backgroundAgents: 0 },
      LIMITS,
    );
    expect(reading.level).toBe("warn");
    expect(reading.strained.join()).toContain("1500MB memory available");
  });

  it("treats a stalled event loop as critical", () => {
    const reading = evaluate(
      { ...HEALTHY, eventLoopLagMs: 900 },
      { activeThreads: 0, backgroundAgents: 0 },
      LIMITS,
    );
    expect(reading.level).toBe("critical");
    expect(reading.breached.join()).toContain("event loop 900ms behind");
  });

  it("treats processor load above the ceiling as critical", () => {
    const reading = evaluate(
      { ...HEALTHY, loadPerCore: 3 },
      { activeThreads: 0, backgroundAgents: 0 },
      LIMITS,
    );
    expect(reading.level).toBe("critical");
    expect(reading.breached.join()).toContain("load 3 per processor");
  });

  it("collects every breached limit rather than stopping at the first", () => {
    const reading = evaluate(
      { ...HEALTHY, memoryAvailableMb: 100, loadPerCore: 9, eventLoopLagMs: 5000 },
      { activeThreads: 8, backgroundAgents: 0 },
      LIMITS,
    );
    expect(reading.breached).toHaveLength(4);
  });

  it("never reports negative free slots", () => {
    const reading = evaluate(HEALTHY, { activeThreads: 99, backgroundAgents: 0 }, LIMITS);
    expect(reading.slotsFree).toBe(0);
  });
});

describe("describe", () => {
  it("names the level, the load, and every reason", () => {
    const text = describeReading(
      evaluate({ ...HEALTHY, memoryAvailableMb: 100 }, { activeThreads: 0, backgroundAgents: 0 }, LIMITS),
    );
    expect(text).toContain("critical");
    expect(text).toContain("0/4 agents");
    expect(text).toContain("100MB memory available");
  });
});
