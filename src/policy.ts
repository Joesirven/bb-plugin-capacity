// Turning a host sample plus an agent count into an admission decision.
//
// Pure functions only: no bb API, no clock, no input/output. Everything the
// service and the command-line interface decide runs through here so the
// thresholds have exactly one definition.
import type { HostSample } from "./host-sample.js";

export type CapacityLevel = "ok" | "warn" | "critical";

export interface CapacityLimits {
  /** Agents allowed to run at once before new work is held back. */
  maxActiveAgents: number;
  /** Fraction of maxActiveAgents that starts producing warnings, 1-99. */
  warnAtPercent: number;
  /** Available memory below this many megabytes is critical. */
  minFreeMemoryMb: number;
  /** One-minute load average per processor above this is critical. */
  maxLoadPerCore: number;
  /** Event loop delay above this many milliseconds is critical. */
  maxEventLoopLagMs: number;
}

export interface AgentCount {
  /** Threads whose own runtime is starting or active. */
  activeThreads: number;
  /** Subagents those threads report running underneath themselves. */
  backgroundAgents: number;
}

export interface CapacityReading {
  level: CapacityLevel;
  /** Agents currently occupying a slot: threads plus their subagents. */
  agentLoad: number;
  slotsFree: number;
  /** Every limit currently at or past its critical threshold. */
  breached: string[];
  /** Every limit past its warning threshold but not yet critical. */
  strained: string[];
  sample: HostSample;
  count: AgentCount;
  limits: CapacityLimits;
}

/**
 * A warning threshold sits at `warnAtPercent` of the way to each critical
 * threshold, so one setting tunes how early every signal speaks up.
 */
function warnThreshold(critical: number, warnAtPercent: number): number {
  return (critical * warnAtPercent) / 100;
}

export function evaluate(
  sample: HostSample,
  count: AgentCount,
  limits: CapacityLimits,
): CapacityReading {
  const agentLoad = count.activeThreads + count.backgroundAgents;
  const breached: string[] = [];
  const strained: string[] = [];

  if (agentLoad >= limits.maxActiveAgents) {
    breached.push(
      `${agentLoad} agents running, limit is ${limits.maxActiveAgents}`,
    );
  } else if (agentLoad >= warnThreshold(limits.maxActiveAgents, limits.warnAtPercent)) {
    strained.push(
      `${agentLoad} of ${limits.maxActiveAgents} agent slots in use`,
    );
  }

  // Memory runs the other way: the floor is critical and the warning sits
  // above it, so divide instead of multiply.
  const memoryWarnMb =
    limits.minFreeMemoryMb / (limits.warnAtPercent / 100);
  if (sample.memoryAvailableMb <= limits.minFreeMemoryMb) {
    breached.push(
      `${sample.memoryAvailableMb}MB memory available, floor is ${limits.minFreeMemoryMb}MB`,
    );
  } else if (sample.memoryAvailableMb <= memoryWarnMb) {
    strained.push(`${sample.memoryAvailableMb}MB memory available`);
  }

  if (sample.loadPerCore >= limits.maxLoadPerCore) {
    breached.push(
      `load ${sample.loadPerCore} per processor, ceiling is ${limits.maxLoadPerCore}`,
    );
  } else if (
    sample.loadPerCore >= warnThreshold(limits.maxLoadPerCore, limits.warnAtPercent)
  ) {
    strained.push(`load ${sample.loadPerCore} per processor`);
  }

  if (sample.eventLoopLagMs >= limits.maxEventLoopLagMs) {
    breached.push(
      `event loop ${sample.eventLoopLagMs}ms behind, ceiling is ${limits.maxEventLoopLagMs}ms`,
    );
  } else if (
    sample.eventLoopLagMs >=
    warnThreshold(limits.maxEventLoopLagMs, limits.warnAtPercent)
  ) {
    strained.push(`event loop ${sample.eventLoopLagMs}ms behind`);
  }

  const level: CapacityLevel =
    breached.length > 0 ? "critical" : strained.length > 0 ? "warn" : "ok";

  return {
    level,
    agentLoad,
    slotsFree: Math.max(0, limits.maxActiveAgents - agentLoad),
    breached,
    strained,
    sample,
    count,
    limits,
  };
}

/** True when the host has room to start one more agent right now. */
export function admits(reading: CapacityReading): boolean {
  return reading.level !== "critical" && reading.slotsFree > 0;
}

export function describe(reading: CapacityReading): string {
  const reasons = [...reading.breached, ...reading.strained];
  const headline =
    `${reading.level}: ${reading.agentLoad}/${reading.limits.maxActiveAgents} agents, ` +
    `${reading.sample.memoryAvailableMb}MB memory available, ` +
    `load ${reading.sample.loadPerCore} per processor, ` +
    `event loop ${reading.sample.eventLoopLagMs}ms behind`;
  return reasons.length > 0 ? `${headline} — ${reasons.join("; ")}` : headline;
}
