// Reading plugin settings into validated policy values.
//
// BB settings descriptors carry strings, booleans, selects, and projects, so
// every number arrives as text. Parsing lives here, clamped, with the same
// defaults the descriptors declare.
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import type { CapacityLimits } from "./policy.js";

export type EnforcementMode = "off" | "background-only" | "all";

export interface CapacitySettings extends CapacityLimits {
  pollSeconds: number;
  /** Agents released from the queue on a single drain pass. */
  drainPerTick: number;
  enforcement: EnforcementMode;
  /** Minutes between repeat warnings while a strained state persists. */
  repeatWarningMinutes: number;
  retentionDays: number;
}

export const SETTING_DESCRIPTORS = {
  maxActiveAgents: {
    type: "string",
    label: "Maximum active agents",
    description:
      "Agent threads plus their subagents allowed to run at once (1-64).",
    default: "3",
  },
  warnAtPercent: {
    type: "string",
    label: "Warn at percent",
    description:
      "Percentage of each critical threshold that starts warning (10-99).",
    default: "70",
  },
  minFreeMemoryMb: {
    type: "string",
    label: "Memory floor (megabytes)",
    description:
      "Available memory below this is critical and holds new agents back.",
    default: "800",
  },
  maxLoadPerCore: {
    type: "string",
    label: "Load ceiling per processor",
    description:
      "One-minute load average divided by processor count; above this is critical.",
    default: "2.5",
  },
  maxEventLoopLagMs: {
    type: "string",
    label: "Event loop delay ceiling (milliseconds)",
    description:
      "Server event loop delay above this is critical. This is the stall operators feel.",
    default: "750",
  },
  pollSeconds: {
    type: "string",
    label: "Sample interval (seconds)",
    description: "How often capacity is measured (5-600).",
    default: "15",
  },
  drainPerTick: {
    type: "string",
    label: "Queue releases per sample",
    description:
      "Queued agents started per sample interval. Keep low so load settles between starts (1-16).",
    default: "1",
  },
  enforcement: {
    type: "select",
    label: "Enforcement",
    description:
      "off warns only. background-only stops plugin, automation, child, and hidden threads that start while the host is critical. all also stops threads you started yourself.",
    options: ["off", "background-only", "all"],
    default: "off",
  },
  repeatWarningMinutes: {
    type: "string",
    label: "Repeat warning interval (minutes)",
    description:
      "Minutes before a warning that is still true is raised again (1-1440).",
    default: "15",
  },
  retentionDays: {
    type: "string",
    label: "History retention (days)",
    description: "Days of capacity samples and settled queue rows to keep.",
    default: "14",
  },
} satisfies PluginSettingDescriptors;

function clampNumber(
  raw: string | undefined,
  fallback: number,
  low: number,
  high: number,
  allowFraction = false,
): number {
  const parsed = allowFraction ? Number.parseFloat(raw ?? "") : Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, parsed));
}

export function parseSettings(raw: Record<string, unknown>): CapacitySettings {
  const text = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };
  const enforcement = text("enforcement");
  return {
    maxActiveAgents: clampNumber(text("maxActiveAgents"), 3, 1, 64),
    warnAtPercent: clampNumber(text("warnAtPercent"), 70, 10, 99),
    minFreeMemoryMb: clampNumber(text("minFreeMemoryMb"), 800, 64, 1_048_576),
    maxLoadPerCore: clampNumber(text("maxLoadPerCore"), 2.5, 0.5, 64, true),
    maxEventLoopLagMs: clampNumber(text("maxEventLoopLagMs"), 750, 50, 60_000),
    pollSeconds: clampNumber(text("pollSeconds"), 15, 5, 600),
    drainPerTick: clampNumber(text("drainPerTick"), 1, 1, 16),
    enforcement:
      enforcement === "background-only" || enforcement === "all"
        ? enforcement
        : "off",
    repeatWarningMinutes: clampNumber(text("repeatWarningMinutes"), 15, 1, 1440),
    retentionDays: clampNumber(text("retentionDays"), 14, 1, 3650),
  };
}
