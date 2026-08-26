// The visible half of the warning system.
//
// Logs and contributed agent instructions reach machines. A person watching bb
// needs to see the host go red without going looking, so this renders one
// compact row on the homepage and repaints it the moment the backend
// publishes a capacity signal.
import { useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";

type Level = "ok" | "warn" | "critical";

interface CapacityStatus {
  level: string;
  agentLoad: number;
  slotsFree: number;
  maxActiveAgents: number;
  activeThreads: number;
  backgroundAgents: number;
  memoryAvailableMb: number;
  memoryTotalMb: number;
  swapUsedMb: number;
  loadPerCore: number;
  cpuCount: number;
  eventLoopLagMs: number;
  breached: string[];
  strained: string[];
  queueDepth: number;
  takenAt: number;
}

/** Host theme tokens only — hardcoded colors break custom palettes. */
const TONE: Record<Level, { dot: string; text: string }> = {
  ok: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
  warn: { dot: "bg-primary", text: "text-foreground" },
  critical: { dot: "bg-destructive", text: "text-destructive" },
};

function toLevel(value: string): Level {
  return value === "critical" || value === "warn" ? value : "ok";
}

function CapacitySection() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CapacityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setStatus((await rpc.call("status")) as CapacityStatus);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Plugin signals are ephemeral, so treat every one as an invalidation and
  // re-read the authoritative status rather than trusting the payload.
  useRealtime("capacity", () => {
    void reload();
  });

  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        Host capacity unavailable: {error}
      </p>
    );
  }
  if (!status) {
    return <p className="text-sm text-muted-foreground">Measuring host capacity…</p>;
  }

  const level = toLevel(status.level);
  const tone = TONE[level];
  const reasons = [...status.breached, ...status.strained];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${tone.dot}`} aria-hidden />
          <span className={`font-medium ${tone.text}`}>
            {level === "ok"
              ? "Host has capacity"
              : level === "warn"
                ? "Host is filling up"
                : "Host is out of capacity"}
          </span>
        </span>
        <span className="text-muted-foreground">
          {status.agentLoad}/{status.maxActiveAgents} agents
        </span>
        <span className="text-muted-foreground">
          {status.memoryAvailableMb}MB of {status.memoryTotalMb}MB free
        </span>
        <span className="text-muted-foreground">
          load {status.loadPerCore} per processor
        </span>
        <span className="text-muted-foreground">
          event loop {status.eventLoopLagMs}ms behind
        </span>
        {status.queueDepth > 0 && (
          <span className="text-muted-foreground">
            {status.queueDepth} agent{status.queueDepth === 1 ? "" : "s"} waiting
          </span>
        )}
      </div>
      {reasons.length > 0 && (
        <p className="text-xs text-muted-foreground">{reasons.join(" · ")}</p>
      )}
      {level === "critical" && (
        <p className="text-xs text-muted-foreground">
          Queue new agent work with <code>bb capacity spawn</code> rather than
          starting it now.
        </p>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "host-capacity",
    title: "Host capacity",
    component: CapacitySection,
  });
});
