// bb-plugin-capacity — admission control and overload warnings for the host
// the bb server runs on.
//
// The problem it exists for: agent threads are each a provider bridge worker
// plus a provider command-line process, and enough of them at once starve the
// bb server's event loop and exhaust memory. Nothing in bb counts them against
// the machine they land on. This plugin measures the host, holds new agent
// work in a queue when the host cannot take it, and warns through channels an
// operator and an agent both actually read.
//
// A plugin cannot veto a thread start: BB's six thread lifecycle events are
// observe-only. So the queue is an admission path callers opt into, and the
// enforcement mode is a backstop that stops work which started anyway.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { measureEventLoopLagMs, takeHostSample } from "./src/host-sample.js";
import {
  admits,
  describe,
  evaluate,
  type AgentCount,
  type CapacityReading,
} from "./src/policy.js";
import { parseSettings, SETTING_DESCRIPTORS } from "./src/settings.js";
import { CapacityStore, MIGRATIONS, type QueueRow } from "./src/store.js";
import {
  flagNumber,
  flagPresent,
  flagText,
  parseArgv,
} from "./src/argv.js";

/** Threads whose runtime is occupying an agent slot right now. */
const OCCUPYING_STATUSES = new Set(["active", "starting"]);

/** Upper bound on threads examined per count. Far above any real active set. */
const THREAD_SCAN_LIMIT = 500;

const readingShape = z.object({
  level: z.string(),
  agentLoad: z.number(),
  slotsFree: z.number(),
  maxActiveAgents: z.number(),
  activeThreads: z.number(),
  backgroundAgents: z.number(),
  memoryAvailableMb: z.number(),
  memoryTotalMb: z.number(),
  swapUsedMb: z.number(),
  loadPerCore: z.number(),
  cpuCount: z.number(),
  eventLoopLagMs: z.number(),
  breached: z.array(z.string()),
  strained: z.array(z.string()),
  queueDepth: z.number(),
  takenAt: z.number(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: readingShape },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  const store = new CapacityStore(database);

  /**
   * The most recent reading, kept in memory because two callers need it
   * synchronously or cheaply: the instruction contributor, which sits on the
   * thread-start path, and the agent tools.
   */
  let latest: CapacityReading | null = null;
  let openWarning: { level: string; notifiedAt: number } | null = null;
  let refreshInFlight: Promise<CapacityReading> | null = null;

  async function readSettings() {
    return parseSettings((await settings.get()) as Record<string, unknown>);
  }

  /** Agents occupying a slot: active or starting threads plus their subagents. */
  async function countAgents(): Promise<AgentCount> {
    const threads = await bb.sdk.threads.list({
      includeHidden: true,
      archived: false,
      limit: THREAD_SCAN_LIMIT,
    });
    let activeThreads = 0;
    let backgroundAgents = 0;
    for (const thread of threads) {
      if (!OCCUPYING_STATUSES.has(thread.status)) continue;
      activeThreads += 1;
      backgroundAgents += thread.activity.activeBackgroundAgentCount;
    }
    return { activeThreads, backgroundAgents };
  }

  function publish(reading: CapacityReading, event: string): void {
    bb.realtime.publish("capacity", {
      event,
      level: reading.level,
      agentLoad: reading.agentLoad,
      maxActiveAgents: reading.limits.maxActiveAgents,
      slotsFree: reading.slotsFree,
      memoryAvailableMb: reading.sample.memoryAvailableMb,
      loadPerCore: reading.sample.loadPerCore,
      eventLoopLagMs: reading.sample.eventLoopLagMs,
      reasons: [...reading.breached, ...reading.strained],
      takenAt: reading.sample.takenAt,
    });
  }

  /**
   * The warning system. Edge-triggered so a steady state does not spam, with a
   * repeat interval so a long overload keeps reminding, and an explicit
   * recovery notice so silence is never ambiguous.
   */
  function updateWarnings(reading: CapacityReading, repeatMinutes: number): void {
    const now = reading.sample.takenAt;
    if (reading.level === "ok") {
      if (openWarning) {
        store.clearOpenWarnings(now);
        openWarning = null;
        bb.log.info(`capacity recovered — ${describe(reading)}`);
        publish(reading, "recovered");
      }
      return;
    }

    const escalated = openWarning !== null && openWarning.level !== reading.level;
    const stale =
      openWarning !== null &&
      now - openWarning.notifiedAt >= repeatMinutes * 60_000;

    if (openWarning === null || escalated) {
      if (escalated) store.clearOpenWarnings(now);
      store.raiseWarning(reading, now);
      openWarning = { level: reading.level, notifiedAt: now };
      bb.log.warn(`capacity ${describe(reading)}`);
      publish(reading, "raised");
      return;
    }

    if (stale) {
      openWarning.notifiedAt = now;
      bb.log.warn(`capacity still ${describe(reading)}`);
      publish(reading, "repeated");
    }
  }

  /**
   * Measure the host, evaluate it, record it, and run the warning system.
   * Concurrent callers share one measurement — a burst of thread starts must
   * not turn into a burst of samples.
   */
  async function refresh(): Promise<CapacityReading> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const limits = await readSettings();
        const lagMs = await measureEventLoopLagMs();
        const [sample, count] = await Promise.all([
          takeHostSample(lagMs),
          countAgents(),
        ]);
        const reading = evaluate(sample, count, limits);
        latest = reading;
        store.recordSample(reading);
        updateWarnings(reading, limits.repeatWarningMinutes);
        return reading;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  /** Start one queued row now. Settles the row either way. */
  async function release(row: QueueRow): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId: row.projectId,
        environment: { type: "project-default" },
        prompt: row.prompt,
        ...(row.title ? { title: row.title } : {}),
        ...(row.providerId ? { providerId: row.providerId } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.parentThreadId ? { parentThreadId: row.parentThreadId } : {}),
        ...(row.visibility === "hidden" ? { visibility: "hidden" as const } : {}),
      });
      store.settle(row.id, "spawned", Date.now(), { threadId: thread.id });
      bb.log.info(`released queued agent ${row.id} as thread ${thread.id}`);
      return thread.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.settle(row.id, "failed", Date.now(), { error: message });
      bb.log.error(`queued agent ${row.id} failed to start: ${message}`);
      return null;
    }
  }

  /**
   * Release as many queued agents as the host can currently take, re-measuring
   * between each one because starting an agent changes the answer.
   */
  async function drain(): Promise<{ released: string[]; reading: CapacityReading }> {
    const limits = await readSettings();
    const released: string[] = [];
    let reading = await refresh();
    for (let index = 0; index < limits.drainPerTick; index += 1) {
      if (!admits(reading)) break;
      const [next] = store.nextQueued(1);
      if (!next) break;
      const threadId = await release(next);
      if (threadId) released.push(threadId);
      reading = await refresh();
    }
    if (released.length > 0) publish(reading, "released");
    return { released, reading };
  }

  // Enforcement backstop. Thread lifecycle events cannot veto a start, so the
  // only lever left is stopping a thread that started while the host was
  // already critical. Threads this plugin released are never shed: they were
  // admitted deliberately, and churning them would waste the slot.
  bb.events.on("thread.active", async ({ thread }) => {
    try {
      const limits = await readSettings();
      if (limits.enforcement === "off") return;
      if (thread.originPluginId === bb.pluginId) return;

      const isBackground =
        thread.visibility === "hidden" ||
        thread.originPluginId !== null ||
        thread.parentThreadId !== null;
      if (limits.enforcement === "background-only" && !isBackground) return;

      const reading = await refresh();
      if (reading.level !== "critical") return;

      const reason = reading.breached.join("; ");
      await bb.sdk.threads.stop({ threadId: thread.id });
      store.recordShed(thread.id, reason, Date.now());
      bb.log.warn(
        `stopped thread ${thread.id} on a critical host — ${reason}. ` +
          `Resume it from the thread when capacity returns.`,
      );
      publish(reading, "shed");
    } catch (error) {
      bb.log.error(
        `enforcement failed for thread ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  // The warning channel that reaches the thing actually causing the overload.
  // Synchronous and on the thread-start path, so it only reads cached state.
  bb.agents.contributeInstructions(() => {
    const reading = latest;
    if (!reading || reading.level === "ok") return null;
    const reasons = [...reading.breached, ...reading.strained].join("; ");
    const verb =
      reading.level === "critical" ? "cannot take" : "is close to not taking";
    return [
      `Host capacity warning: this bb host ${verb} more agent work right now.`,
      `Current state: ${reasons}.`,
      reading.level === "critical"
        ? "Do not spawn threads, subagents, or workflows until this clears. Queue the work instead with `bb capacity spawn`, which starts it when the host recovers."
        : "Prefer sequential work over fanning out. If you must start background agents, queue them with `bb capacity spawn` rather than spawning directly.",
      "Check the current numbers with `bb capacity status`.",
    ].join(" ");
  });

  bb.agents.registerTool({
    name: "capacity_check",
    description:
      "Report whether the bb host has room to run more agents right now. Call this before spawning threads, subagents, or workflows.",
    instructions:
      "Before fanning out agent work, call capacity_check. If it reports critical, queue the work with capacity_queue_agent instead of spawning directly.",
    experimental_statusLabels: {
      pending: "Checking host capacity",
      completed: "Checked host capacity",
    },
    parameters: z.object({}),
    async execute() {
      const reading = await refresh();
      return [
        describe(reading),
        `Free agent slots: ${reading.slotsFree}.`,
        `Queued agents waiting: ${store.queuedCount()}.`,
        admits(reading)
          ? "The host can take more agent work."
          : "The host cannot take more agent work. Queue it instead.",
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "capacity_queue_agent",
    description:
      "Queue a bb thread to start when the host has capacity. Starts immediately when there is room, otherwise waits in line. Use this instead of spawning threads directly when the host is under load.",
    experimental_statusLabels: {
      pending: "Queueing an agent",
      completed: "Queued an agent",
    },
    parameters: z.object({
      prompt: z.string().min(1).describe("The prompt the queued thread starts with."),
      title: z.string().optional().describe("Optional thread title."),
      projectId: z
        .string()
        .optional()
        .describe("Project to start in. Defaults to the calling thread's project."),
      priority: z
        .number()
        .int()
        .optional()
        .describe("Higher numbers leave the queue first. Defaults to 0."),
      hidden: z
        .boolean()
        .optional()
        .describe("Start as a hidden background worker rather than a visible thread."),
    }),
    async execute(params, ctx) {
      const row = store.enqueue(
        {
          id: `cap_${Math.random().toString(36).slice(2, 12)}`,
          projectId: params.projectId ?? ctx.projectId,
          prompt: params.prompt,
          title: params.title ?? null,
          visibility: params.hidden ? "hidden" : null,
          requestedBy: ctx.threadId,
          priority: params.priority ?? 0,
        },
        Date.now(),
      );
      const { released } = await drain();
      const settled = store.get(row.id);
      if (settled?.state === "spawned" && settled.threadId) {
        return `Started immediately as thread ${settled.threadId}. ${released.length - 1 > 0 ? `${released.length - 1} other queued agent(s) also started.` : ""}`.trim();
      }
      if (settled?.state === "failed") {
        return {
          content: [
            { type: "text", text: `Queued agent ${row.id} failed to start: ${settled.error}` },
          ],
          isError: true,
        };
      }
      const reading = latest ?? (await refresh());
      return [
        `Queued as ${row.id}, position ${store.position(row.id)} of ${store.queuedCount()}.`,
        `It starts automatically when the host has room. Current state: ${describe(reading)}.`,
        `Cancel it with \`bb capacity cancel ${row.id}\`.`,
      ].join("\n");
    },
  });

  bb.rpc.register(rpcContract, {
    async status() {
      const reading = latest ?? (await refresh());
      return {
        level: reading.level,
        agentLoad: reading.agentLoad,
        slotsFree: reading.slotsFree,
        maxActiveAgents: reading.limits.maxActiveAgents,
        activeThreads: reading.count.activeThreads,
        backgroundAgents: reading.count.backgroundAgents,
        memoryAvailableMb: reading.sample.memoryAvailableMb,
        memoryTotalMb: reading.sample.memoryTotalMb,
        swapUsedMb: reading.sample.swapUsedMb,
        loadPerCore: reading.sample.loadPerCore,
        cpuCount: reading.sample.cpuCount,
        eventLoopLagMs: reading.sample.eventLoopLagMs,
        breached: reading.breached,
        strained: reading.strained,
        queueDepth: store.queuedCount(),
        takenAt: reading.sample.takenAt,
      };
    },
  });

  bb.cli.register({
    name: "capacity",
    summary:
      "Measure this bb host's agent capacity, queue agent work, and read overload warnings.",
    commands: [
      {
        name: "status",
        summary: "Current capacity reading, limits, and queue depth.",
        usage: "bb capacity status [--json]",
      },
      {
        name: "queue",
        summary: "List queued and recently settled agent work.",
        usage: "bb capacity queue [--all] [--limit 20] [--json]",
      },
      {
        name: "spawn",
        summary:
          "Queue a thread to start when the host has room; starts now when there is room.",
        usage:
          "bb capacity spawn --prompt \"...\" [--project proj_x] [--title t] [--provider p] [--model m] [--priority 0] [--hidden]",
      },
      {
        name: "cancel",
        summary: "Cancel a queued agent before it starts.",
        usage: "bb capacity cancel <queue-id>",
      },
      {
        name: "drain",
        summary: "Run a release pass now instead of waiting for the next sample.",
        usage: "bb capacity drain",
      },
      {
        name: "warnings",
        summary: "Recent overload warnings, newest first.",
        usage: "bb capacity warnings [--limit 20] [--json]",
      },
      {
        name: "history",
        summary: "Recent capacity samples, newest first.",
        usage: "bb capacity history [--limit 20] [--json]",
      },
      {
        name: "shed",
        summary: "Threads enforcement stopped because the host was critical.",
        usage: "bb capacity shed [--limit 20] [--json]",
      },
    ],
    async run(argv, ctx) {
      const parsed = parseArgv(argv);
      const [command = "status"] = parsed.positionals;
      const wantsJson = flagPresent(parsed, "json");
      const limit = flagNumber(parsed, "limit", 20);
      const json = (value: unknown) => ({
        exitCode: 0,
        stdout: `${JSON.stringify(value, null, 2)}\n`,
      });

      switch (command) {
        case "status": {
          const reading = await refresh();
          const configured = await readSettings();
          const queueDepth = store.queuedCount();
          if (wantsJson) {
            return json({
              level: reading.level,
              agentLoad: reading.agentLoad,
              slotsFree: reading.slotsFree,
              queueDepth,
              limits: configured,
              count: reading.count,
              sample: reading.sample,
              breached: reading.breached,
              strained: reading.strained,
            });
          }
          const lines = [
            describe(reading),
            `Agent slots free: ${reading.slotsFree} of ${reading.limits.maxActiveAgents}`,
            `Threads active or starting: ${reading.count.activeThreads}; their subagents: ${reading.count.backgroundAgents}`,
            `Memory: ${reading.sample.memoryAvailableMb}MB available of ${reading.sample.memoryTotalMb}MB, swap used ${reading.sample.swapUsedMb}MB`,
            `Processors: ${reading.sample.cpuCount}, load per processor ${reading.sample.loadPerCore}`,
            `Queued agents waiting: ${queueDepth}`,
            `Enforcement: ${configured.enforcement}`,
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        case "queue": {
          const states = flagPresent(parsed, "all")
            ? (["queued", "spawned", "cancelled", "failed"] as const)
            : (["queued"] as const);
          const rows = store.list([...states], limit);
          if (wantsJson) return json(rows);
          if (rows.length === 0) {
            return { exitCode: 0, stdout: "No matching queued agents.\n" };
          }
          const lines = rows.map((row) => {
            const when = new Date(row.createdAt).toISOString();
            const target = row.threadId ? ` thread=${row.threadId}` : "";
            const failure = row.error ? ` error=${row.error}` : "";
            const title = row.title ?? row.prompt.slice(0, 60);
            return `${row.id}  ${row.state.padEnd(9)} p${row.priority}  ${when}  ${title}${target}${failure}`;
          });
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        case "spawn": {
          const prompt = flagText(parsed, "prompt");
          const projectId = flagText(parsed, "project") ?? ctx.projectId;
          if (!prompt) {
            return { exitCode: 2, stderr: "--prompt is required.\n" };
          }
          if (!projectId) {
            return {
              exitCode: 2,
              stderr:
                "--project is required when the command is not run from a project thread.\n",
            };
          }
          const row = store.enqueue(
            {
              id: `cap_${Math.random().toString(36).slice(2, 12)}`,
              projectId,
              prompt,
              title: flagText(parsed, "title") ?? null,
              providerId: flagText(parsed, "provider") ?? null,
              model: flagText(parsed, "model") ?? null,
              visibility: flagPresent(parsed, "hidden") ? "hidden" : null,
              parentThreadId: flagText(parsed, "parent") ?? null,
              requestedBy: ctx.threadId ?? "cli",
              priority: flagNumber(parsed, "priority", 0),
            },
            Date.now(),
          );
          await drain();
          const settled = store.get(row.id);
          if (wantsJson) return json(settled);
          if (settled?.state === "spawned") {
            return {
              exitCode: 0,
              stdout: `Started now as thread ${settled.threadId} (queue id ${row.id}).\n`,
            };
          }
          if (settled?.state === "failed") {
            return {
              exitCode: 1,
              stderr: `Queue id ${row.id} failed to start: ${settled.error}\n`,
            };
          }
          const reading = latest ?? (await refresh());
          return {
            exitCode: 0,
            stdout:
              `Queued as ${row.id}, position ${store.position(row.id)} of ${store.queuedCount()}.\n` +
              `Host is ${describe(reading)}.\n` +
              `It starts automatically when the host has room. Cancel with: bb capacity cancel ${row.id}\n`,
          };
        }

        case "cancel": {
          const id = parsed.positionals[1];
          if (!id) return { exitCode: 2, stderr: "Usage: bb capacity cancel <queue-id>\n" };
          const cancelled = store.cancel(id, Date.now());
          if (!cancelled) {
            const row = store.get(id);
            return {
              exitCode: 1,
              stderr: row
                ? `${id} is already ${row.state}; only queued agents can be cancelled.\n`
                : `No queued agent with id ${id}.\n`,
            };
          }
          return { exitCode: 0, stdout: `Cancelled ${id}.\n` };
        }

        case "drain": {
          const { released, reading } = await drain();
          if (wantsJson) return json({ released, level: reading.level });
          return {
            exitCode: 0,
            stdout:
              released.length === 0
                ? `Released nothing. Host is ${describe(reading)}. ${store.queuedCount()} still waiting.\n`
                : `Released ${released.length}: ${released.join(", ")}. ${store.queuedCount()} still waiting.\n`,
          };
        }

        case "warnings": {
          const rows = store.recentWarnings(limit);
          if (wantsJson) return json(rows);
          if (rows.length === 0) {
            return { exitCode: 0, stdout: "No warnings recorded.\n" };
          }
          const lines = rows.map((row) => {
            const state = row.clearedAt
              ? `cleared after ${Math.round((row.clearedAt - row.raisedAt) / 1000)}s`
              : "still open";
            return `${new Date(row.raisedAt).toISOString()}  ${row.level.padEnd(8)} ${state}  ${row.reasons}`;
          });
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        case "history": {
          const rows = store.recentSamples(limit);
          if (wantsJson) return json(rows);
          const lines = rows.map((row) => {
            const when = new Date(Number(row.taken_at)).toISOString();
            return `${when}  ${String(row.level).padEnd(8)} agents=${row.agent_load} memoryMb=${row.memory_available_mb} load=${row.load_per_core} lagMs=${row.event_loop_lag_ms}`;
          });
          return {
            exitCode: 0,
            stdout: lines.length ? `${lines.join("\n")}\n` : "No samples recorded yet.\n",
          };
        }

        case "shed": {
          const rows = store.recentShed(limit);
          if (wantsJson) return json(rows);
          if (rows.length === 0) {
            return { exitCode: 0, stdout: "Enforcement has stopped no threads.\n" };
          }
          const lines = rows.map(
            (row) =>
              `${new Date(row.shedAt).toISOString()}  ${row.threadId}  ${row.reason}`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        default:
          return {
            exitCode: 2,
            stderr: `Unknown command "${command}". Try: status, queue, spawn, cancel, drain, warnings, history, shed.\n`,
          };
      }
    },
  });

  bb.background.service("capacity-monitor", {
    async start(signal) {
      // A pruning pass roughly once an hour, counted in sample ticks.
      let ticksUntilPrune = 0;
      while (!signal.aborted) {
        try {
          const limits = await readSettings();
          await drain();
          if (ticksUntilPrune <= 0) {
            store.prune(Date.now() - limits.retentionDays * 86_400_000);
            ticksUntilPrune = Math.max(
              1,
              Math.round(3600 / Math.max(1, limits.pollSeconds)),
            );
          }
          ticksUntilPrune -= 1;
          await sleep(limits.pollSeconds * 1000, signal);
        } catch (error) {
          if (signal.aborted) return;
          bb.log.error(
            `capacity sample failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await sleep(30_000, signal);
        }
      }
    },
  });

  bb.onDispose(() => {
    latest = null;
    openWarning = null;
  });

  bb.log.info("capacity monitor registered");
}

/** A sleep that wakes on abort, so a reload is never held up by a full tick. */
function sleep(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
