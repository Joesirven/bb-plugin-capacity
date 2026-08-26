import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import plugin from "./server.js";

/** A thread row shaped like `threads.list` returns them. */
function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thr_busy",
    status: "active",
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    ...overrides,
  };
}

/**
 * Settings that make every host-resource threshold unreachable, so a test's
 * verdict is decided only by the agent count it sets up. The real machine
 * running the suite has real memory and load; pinning them out of the way is
 * what keeps these tests deterministic.
 */
const RESOURCE_LIMITS_DISABLED = {
  minFreeMemoryMb: "64",
  maxLoadPerCore: "64",
  maxEventLoopLagMs: "60000",
};

async function loadPlugin(options: {
  settings?: Record<string, string>;
  threads?: unknown[];
  spawn?: (args: unknown) => unknown;
}): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "capacity",
    settings: { ...RESOURCE_LIMITS_DISABLED, ...options.settings },
    sdk: {
      threads: {
        list: async () => (options.threads ?? []) as never,
        spawn:
          options.spawn ??
          (async () => makeThreadResponse({ id: "thr_spawned" }) as never),
        stop: async () => ({ ok: true }) as never,
      },
    },
  });
  await plugin(host.bb);
  return host;
}

describe("registrations", () => {
  let host: FakePluginHost;
  beforeEach(async () => {
    host = await loadPlugin({});
  });

  it("registers the capacity command with its subcommands documented", () => {
    const cli = host.harness.registrations.cli;
    expect(cli?.name).toBe("capacity");
    expect(cli?.commands.map((command) => command.name)).toEqual([
      "status",
      "queue",
      "spawn",
      "cancel",
      "drain",
      "warnings",
      "history",
      "shed",
    ]);
  });

  it("registers both agent tools and the monitor service", () => {
    expect(host.harness.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "capacity_check",
      "capacity_queue_agent",
    ]);
    expect(host.harness.registrations.services.map((service) => service.name)).toEqual([
      "capacity-monitor",
    ]);
  });

  it("observes thread.active so enforcement can react to it", () => {
    expect(host.harness.registrations.threadEventHandlers["thread.active"]).toBe(1);
  });
});

describe("status", () => {
  it("counts active threads and their subagents against the limit", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "8" },
      threads: [
        listRow({ id: "thr_a" }),
        listRow({
          id: "thr_b",
          activity: {
            activeBackgroundAgentCount: 3,
            activeBackgroundCommandCount: 0,
            activeGoalCount: 0,
            activePlanModeCount: 0,
            activeWorkflowCount: 0,
          },
        }),
      ],
    });
    const result = await host.harness.runCli(["status", "--json"]);
    const status = JSON.parse(result.stdout);
    expect(status.count).toEqual({ activeThreads: 2, backgroundAgents: 3 });
    expect(status.agentLoad).toBe(5);
    expect(status.slotsFree).toBe(3);
  });

  it("does not count idle threads", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "8" },
      threads: [listRow({ id: "thr_idle", status: "idle" })],
    });
    const status = JSON.parse((await host.harness.runCli(["status", "--json"])).stdout);
    expect(status.agentLoad).toBe(0);
  });

  it("counts a starting thread, because its processes are already coming up", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "8" },
      threads: [listRow({ id: "thr_starting", status: "starting" })],
    });
    const status = JSON.parse((await host.harness.runCli(["status", "--json"])).stdout);
    expect(status.agentLoad).toBe(1);
  });
});

describe("the queue", () => {
  it("starts work immediately when the host has room", async () => {
    const host = await loadPlugin({ settings: { maxActiveAgents: "4" } });
    const result = await host.harness.runCli([
      "spawn",
      "--project",
      "proj_1",
      "--prompt",
      "do the thing",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Started now as thread thr_spawned");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("holds work back when the host is already at its agent limit", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    const result = await host.harness.runCli([
      "spawn",
      "--project",
      "proj_1",
      "--prompt",
      "do the thing",
    ]);
    expect(result.stdout).toContain("Queued as cap_");
    expect(result.stdout).toContain("position 1 of 1");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("holds work back when memory is below the floor even with slots free", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "8", minFreeMemoryMb: "1048576" },
    });
    const result = await host.harness.runCli([
      "spawn",
      "--project",
      "proj_1",
      "--prompt",
      "do the thing",
    ]);
    expect(result.stdout).toContain("Queued as cap_");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("releases held work once the host has room again", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    await host.harness.runCli(["spawn", "--project", "proj_1", "--prompt", "later"]);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);

    // The busy thread finishes: nothing is active any more.
    host.harness.sdk.stub("threads.list", async () => [] as never);
    const drained = await host.harness.runCli(["drain"]);

    expect(drained.stdout).toContain("Released 1");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("releases at most the configured number per pass so load can settle", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1", drainPerTick: "1" },
      threads: [listRow()],
    });
    await host.harness.runCli(["spawn", "--project", "proj_1", "--prompt", "one"]);
    await host.harness.runCli(["spawn", "--project", "proj_1", "--prompt", "two"]);
    host.harness.sdk.stub("threads.list", async () => [] as never);

    await host.harness.runCli(["drain"]);

    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    const queued = JSON.parse((await host.harness.runCli(["queue", "--json"])).stdout);
    expect(queued).toHaveLength(1);
  });

  it("releases the highest priority first", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    await host.harness.runCli(["spawn", "--project", "proj_1", "--prompt", "ordinary"]);
    await host.harness.runCli([
      "spawn", "--project", "proj_1", "--prompt", "urgent", "--priority", "9",
    ]);
    host.harness.sdk.stub("threads.list", async () => [] as never);

    await host.harness.runCli(["drain"]);

    const [spawnArgs] = host.harness.sdk.callsTo("threads.spawn")[0] as [
      { prompt: string },
    ];
    expect(spawnArgs.prompt).toBe("urgent");
  });

  it("records the failure instead of losing the row when a spawn fails", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "4" },
      spawn: () => {
        throw new Error("no such project");
      },
    });
    const result = await host.harness.runCli([
      "spawn", "--project", "proj_gone", "--prompt", "doomed",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such project");
    const rows = JSON.parse((await host.harness.runCli(["queue", "--all", "--json"])).stdout);
    expect(rows[0].state).toBe("failed");
  });

  it("cancels queued work and refuses to cancel it twice", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    const spawned = await host.harness.runCli([
      "spawn", "--project", "proj_1", "--prompt", "later",
    ]);
    const id = /Queued as (cap_\w+)/.exec(spawned.stdout)![1]!;

    expect((await host.harness.runCli(["cancel", id])).exitCode).toBe(0);
    const second = await host.harness.runCli(["cancel", id]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already cancelled");
  });

  it("requires a project when the command is not run from a project thread", async () => {
    const host = await loadPlugin({});
    const result = await host.harness.runCli(["spawn", "--prompt", "orphan"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--project is required");
  });

  it("requires a prompt", async () => {
    const host = await loadPlugin({});
    const result = await host.harness.runCli(["spawn", "--project", "proj_1"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--prompt is required");
  });
});

describe("the warning system", () => {
  it("warns once when the host goes critical and records it", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    await host.harness.runCli(["status"]);

    const warnings = host.harness.logEntries.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("critical");
    expect(
      host.harness.realtimeSignals.filter(
        (signal) => (signal.payload as { event: string }).event === "raised",
      ),
    ).toHaveLength(1);
  });

  it("does not repeat a warning that is still the same on the next sample", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1", repeatWarningMinutes: "1440" },
      threads: [listRow()],
    });
    await host.harness.runCli(["status"]);
    await host.harness.runCli(["status"]);

    expect(host.harness.logEntries.filter((entry) => entry.level === "warn")).toHaveLength(1);
  });

  it("announces recovery so silence is never ambiguous", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    await host.harness.runCli(["status"]);
    host.harness.sdk.stub("threads.list", async () => [] as never);
    await host.harness.runCli(["status"]);

    expect(
      host.harness.logEntries.some((entry) => entry.message.includes("capacity recovered")),
    ).toBe(true);
    const recovered = JSON.parse((await host.harness.runCli(["warnings", "--json"])).stdout);
    expect(recovered[0].clearedAt).not.toBeNull();
  });

  it("says nothing while the host is healthy", async () => {
    const host = await loadPlugin({ settings: { maxActiveAgents: "8" } });
    await host.harness.runCli(["status"]);
    expect(host.harness.logEntries.filter((entry) => entry.level === "warn")).toHaveLength(0);
  });
});

describe("the instructions contributed to agents", () => {
  it("contributes nothing before a sample exists", () => {
    return loadPlugin({}).then((host) => {
      const provider = host.harness.registrations.instructionProvider!;
      expect(provider({ threadId: "thr_1", projectId: "proj_1" })).toBeNull();
    });
  });

  it("contributes nothing while the host is healthy", async () => {
    const host = await loadPlugin({ settings: { maxActiveAgents: "8" } });
    await host.harness.runCli(["status"]);
    const provider = host.harness.registrations.instructionProvider!;
    expect(provider({ threadId: "thr_1", projectId: "proj_1" })).toBeNull();
  });

  it("tells an agent to stop fanning out when the host is critical", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    await host.harness.runCli(["status"]);

    const text = host.harness.registrations.instructionProvider!({
      threadId: "thr_1",
      projectId: "proj_1",
    })!;
    expect(text).toContain("Do not spawn threads, subagents, or workflows");
    expect(text).toContain("bb capacity spawn");
  });
});

describe("the agent tools", () => {
  it("capacity_check reports whether there is room", async () => {
    const host = await loadPlugin({ settings: { maxActiveAgents: "8" } });
    const result = await host.harness.callAgentTool("capacity_check", {});
    expect(String(result)).toContain("The host can take more agent work.");
  });

  it("capacity_check reports when there is no room", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    const result = await host.harness.callAgentTool("capacity_check", {});
    expect(String(result)).toContain("cannot take more agent work");
  });

  it("capacity_queue_agent defaults to the calling thread's project", async () => {
    const host = await loadPlugin({ settings: { maxActiveAgents: "4" } });
    await host.harness.callAgentTool(
      "capacity_queue_agent",
      { prompt: "background work" },
      { projectId: "proj_from_context" },
    );
    const [args] = host.harness.sdk.callsTo("threads.spawn")[0] as [
      { projectId: string },
    ];
    expect(args.projectId).toBe("proj_from_context");
  });

  it("capacity_queue_agent queues rather than spawning when the host is full", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "1" },
      threads: [listRow()],
    });
    const result = await host.harness.callAgentTool("capacity_queue_agent", {
      prompt: "background work",
    });
    expect(String(result)).toContain("Queued as cap_");
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

describe("enforcement", () => {
  const criticalThread = { maxActiveAgents: "1" };

  async function activate(host: FakePluginHost, thread: Record<string, unknown>) {
    await host.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_new", ...thread }),
    });
  }

  it("stops nothing while enforcement is off, even on a critical host", async () => {
    const host = await loadPlugin({
      settings: { ...criticalThread, enforcement: "off" },
      threads: [listRow()],
    });
    await activate(host, { visibility: "hidden" });
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("stops a hidden background thread that starts on a critical host", async () => {
    const host = await loadPlugin({
      settings: { ...criticalThread, enforcement: "background-only" },
      threads: [listRow()],
    });
    await activate(host, { visibility: "hidden" });

    expect(host.harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_new" }]]);
    const shed = JSON.parse((await host.harness.runCli(["shed", "--json"])).stdout);
    expect(shed[0].threadId).toBe("thr_new");
  });

  it("leaves a thread the user started alone in background-only mode", async () => {
    const host = await loadPlugin({
      settings: { ...criticalThread, enforcement: "background-only" },
      threads: [listRow()],
    });
    await activate(host, { visibility: "visible", originPluginId: null, parentThreadId: null });
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("stops a thread the user started only in the all mode", async () => {
    const host = await loadPlugin({
      settings: { ...criticalThread, enforcement: "all" },
      threads: [listRow()],
    });
    await activate(host, { visibility: "visible", originPluginId: null, parentThreadId: null });
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(1);
  });

  it("never stops a thread it released from its own queue", async () => {
    const host = await loadPlugin({
      settings: { ...criticalThread, enforcement: "all" },
      threads: [listRow()],
    });
    await activate(host, { originPluginId: "capacity" });
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("stops nothing while the host is merely strained", async () => {
    const host = await loadPlugin({
      settings: { maxActiveAgents: "4", warnAtPercent: "10", enforcement: "all" },
      threads: [listRow()],
    });
    await activate(host, { visibility: "hidden" });
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(0);
  });
});

describe("the monitor service", () => {
  it("starts, samples, and stops on abort", async () => {
    const host = await loadPlugin({ settings: { maxActiveAgents: "8", pollSeconds: "600" } });
    const service = host.harness.runService("capacity-monitor");
    // Give the first pass time to take a sample before shutting down.
    await new Promise((resolve) => setTimeout(resolve, 400));
    service.controller.abort();
    await service.done;

    const history = JSON.parse((await host.harness.runCli(["history", "--json"])).stdout);
    expect(history.length).toBeGreaterThan(0);
  });
});
