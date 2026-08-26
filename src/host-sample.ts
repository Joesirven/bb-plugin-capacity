// Reading the health of the machine the bb server runs on.
//
// Everything here is server-local: /proc is the server's own filesystem, so
// the multi-machine rule about ctx.cwd paths does not apply. The numbers
// describe the host the bb server process lives on and nothing else.
import { readFile } from "node:fs/promises";
import os from "node:os";

export interface HostSample {
  /** Milliseconds since the epoch when the sample was taken. */
  takenAt: number;
  /** Memory the kernel believes is available without swapping, in megabytes. */
  memoryAvailableMb: number;
  memoryTotalMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
  /** One-minute load average divided by the processor count. */
  loadPerCore: number;
  cpuCount: number;
  /** Measured delay of a timer that asked to fire after a known interval. */
  eventLoopLagMs: number;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const KILOBYTES_PER_MEGABYTE = 1024;

function parseMeminfo(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]));
  }
  return values;
}

/**
 * Memory figures, in megabytes. Linux reports MemAvailable, which already
 * accounts for reclaimable page cache; os.freemem() does not and would make a
 * healthy host look starved. Non-Linux hosts fall back to os.freemem().
 */
async function readMemory(): Promise<
  Pick<
    HostSample,
    "memoryAvailableMb" | "memoryTotalMb" | "swapUsedMb" | "swapTotalMb"
  >
> {
  try {
    const meminfo = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
    const available = meminfo.get("MemAvailable");
    const total = meminfo.get("MemTotal");
    const swapTotal = meminfo.get("SwapTotal") ?? 0;
    const swapFree = meminfo.get("SwapFree") ?? 0;
    if (available !== undefined && total !== undefined) {
      return {
        memoryAvailableMb: Math.round(available / KILOBYTES_PER_MEGABYTE),
        memoryTotalMb: Math.round(total / KILOBYTES_PER_MEGABYTE),
        swapUsedMb: Math.round((swapTotal - swapFree) / KILOBYTES_PER_MEGABYTE),
        swapTotalMb: Math.round(swapTotal / KILOBYTES_PER_MEGABYTE),
      };
    }
  } catch {
    // Fall through to the portable numbers below.
  }
  return {
    memoryAvailableMb: Math.round(os.freemem() / BYTES_PER_MEGABYTE),
    memoryTotalMb: Math.round(os.totalmem() / BYTES_PER_MEGABYTE),
    swapUsedMb: 0,
    swapTotalMb: 0,
  };
}

/**
 * How late a timer asking for `intervalMs` actually fired. A stalled event
 * loop is the symptom operators actually feel, so measure it rather than
 * inferring it from processor load.
 */
export async function measureEventLoopLagMs(intervalMs = 200): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const elapsedMs =
    Number(process.hrtime.bigint() - startedAt) / 1_000_000 - intervalMs;
  return Math.max(0, Math.round(elapsedMs));
}

export async function takeHostSample(
  eventLoopLagMs: number,
): Promise<HostSample> {
  const memory = await readMemory();
  const cpuCount = Math.max(1, os.cpus().length);
  return {
    takenAt: Date.now(),
    ...memory,
    cpuCount,
    loadPerCore: Number((os.loadavg()[0]! / cpuCount).toFixed(2)),
    eventLoopLagMs,
  };
}
