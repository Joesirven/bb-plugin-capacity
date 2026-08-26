import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostSample } from "./host-sample.js";
import { evaluate, type CapacityLimits } from "./policy.js";
import { CapacityStore, MIGRATIONS } from "./store.js";

const SAMPLE: HostSample = {
  takenAt: 1_700_000_000_000,
  memoryAvailableMb: 200,
  memoryTotalMb: 8000,
  swapUsedMb: 10,
  swapTotalMb: 4000,
  loadPerCore: 5,
  cpuCount: 4,
  eventLoopLagMs: 900,
};

const LIMITS: CapacityLimits = {
  maxActiveAgents: 2,
  warnAtPercent: 70,
  minFreeMemoryMb: 800,
  maxLoadPerCore: 2,
  maxEventLoopLagMs: 500,
};

function newStore(): CapacityStore {
  const db = new BetterSqlite3(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new CapacityStore(db);
}

let store: CapacityStore;
beforeEach(() => {
  store = newStore();
});

function enqueue(id: string, priority = 0, createdAt = 1000): void {
  store.enqueue({ id, projectId: "proj_1", prompt: `work ${id}`, priority }, createdAt);
}

describe("the queue", () => {
  it("returns a queued row and counts it", () => {
    const row = store.enqueue({ id: "a", projectId: "proj_1", prompt: "hi" }, 1000);
    expect(row.state).toBe("queued");
    expect(store.queuedCount()).toBe(1);
  });

  it("releases higher priority first, then oldest first", () => {
    enqueue("old", 0, 1000);
    enqueue("new", 0, 2000);
    enqueue("urgent", 5, 3000);
    expect(store.nextQueued(3).map((row) => row.id)).toEqual(["urgent", "old", "new"]);
  });

  it("reports a one-based queue position", () => {
    enqueue("first", 0, 1000);
    enqueue("second", 0, 2000);
    expect(store.position("first")).toBe(1);
    expect(store.position("second")).toBe(2);
  });

  it("stops offering a row once it is settled", () => {
    enqueue("a");
    store.settle("a", "spawned", 2000, { threadId: "thr_1" });
    expect(store.queuedCount()).toBe(0);
    expect(store.nextQueued(5)).toHaveLength(0);
    expect(store.get("a")?.threadId).toBe("thr_1");
  });

  it("records the reason a row failed", () => {
    enqueue("a");
    store.settle("a", "failed", 2000, { error: "no such project" });
    const row = store.get("a");
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("no such project");
    expect(row?.attempts).toBe(1);
  });

  it("cancels only rows that have not started yet", () => {
    enqueue("a");
    expect(store.cancel("a", 2000)).toBe(true);
    expect(store.cancel("a", 2000)).toBe(false);
  });

  it("refuses to cancel a row that already started", () => {
    enqueue("a");
    store.settle("a", "spawned", 2000, { threadId: "thr_1" });
    expect(store.cancel("a", 3000)).toBe(false);
    expect(store.get("a")?.state).toBe("spawned");
  });

  it("lists only the requested states", () => {
    enqueue("a");
    enqueue("b");
    store.settle("b", "cancelled", 2000);
    expect(store.list(["queued"], 10).map((row) => row.id)).toEqual(["a"]);
    expect(store.list(["queued", "cancelled"], 10)).toHaveLength(2);
  });
});

describe("samples and warnings", () => {
  it("records a sample with its reasons", () => {
    store.recordSample(evaluate(SAMPLE, { activeThreads: 3, backgroundAgents: 0 }, LIMITS));
    const [row] = store.recentSamples(1);
    expect(row?.level).toBe("critical");
    expect(row?.agent_load).toBe(3);
    expect(String(row?.detail)).toContain("memory available");
  });

  it("raises a warning and then clears it", () => {
    const reading = evaluate(SAMPLE, { activeThreads: 3, backgroundAgents: 0 }, LIMITS);
    const raised = store.raiseWarning(reading, 5000);
    expect(raised.clearedAt).toBeNull();
    expect(store.clearOpenWarnings(6000)).toBe(1);
    expect(store.recentWarnings(1)[0]?.clearedAt).toBe(6000);
  });

  it("clears nothing when no warning is open", () => {
    expect(store.clearOpenWarnings(6000)).toBe(0);
  });

  it("records threads enforcement stopped", () => {
    store.recordShed("thr_1", "out of memory", 5000);
    expect(store.recentShed(5)).toEqual([
      { threadId: "thr_1", shedAt: 5000, reason: "out of memory" },
    ]);
  });
});

describe("prune", () => {
  it("drops old samples and settled rows but keeps waiting work", () => {
    store.recordSample(evaluate(SAMPLE, { activeThreads: 1, backgroundAgents: 0 }, LIMITS));
    enqueue("waiting", 0, 1000);
    enqueue("done", 0, 1000);
    store.settle("done", "spawned", 1000, { threadId: "thr_1" });
    store.raiseWarning(evaluate(SAMPLE, { activeThreads: 1, backgroundAgents: 0 }, LIMITS), 1000);
    store.clearOpenWarnings(1000);

    store.prune(SAMPLE.takenAt + 1);

    expect(store.recentSamples(5)).toHaveLength(0);
    expect(store.recentWarnings(5)).toHaveLength(0);
    expect(store.get("done")).toBeNull();
    // Work that has not run yet must survive retention.
    expect(store.get("waiting")?.state).toBe("queued");
  });
});
