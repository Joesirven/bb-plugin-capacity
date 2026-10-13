// Which machine a thread runs on. The plugin can only measure the machine the
// bb server runs on, so every verdict starts by asking whether a thread is on
// that machine. Anything that cannot be resolved is "unknown", and unknown is
// never treated as the server.

export interface MachineIdentity {
  hostId: string | null;
  hostName: string | null;
}

export interface ServerHost {
  id: string | null;
  name: string;
}

/** The slice of the bb software development kit this file reads. */
export interface MachineSdk {
  system: { config(): Promise<{ primaryHostId: string | null }> };
  hosts: { list(): Promise<Array<{ id: string; name: string }>> };
  environments: {
    get(args: { environmentId: string }): Promise<{ hostId: string | null }>;
  };
  threads: {
    get(args: { threadId: string }): Promise<{ environmentId: string | null }>;
  };
}

/** Far above the threads a server holds at once; the oldest entry is dropped. */
const THREAD_CACHE_LIMIT = 1000;

export const UNKNOWN_MACHINE_NAME = "an unknown machine";

export function createMachineResolver(sdk: MachineSdk) {
  let server: ServerHost | null = null;
  const threadHosts = new Map<string, string>();

  async function hostName(hostId: string): Promise<string | null> {
    try {
      return (await sdk.hosts.list()).find((host) => host.id === hostId)?.name ?? null;
    } catch {
      return null;
    }
  }

  /** The machine the bb server runs on. Cached once it resolves. */
  async function serverHost(): Promise<ServerHost> {
    if (server) return server;
    let id: string | null = null;
    try {
      id = (await sdk.system.config()).primaryHostId;
    } catch {
      return { id: null, name: "the bb server" };
    }
    if (!id) return { id: null, name: "the bb server" };
    server = { id, name: (await hostName(id)) ?? id };
    return server;
  }

  function remember(threadId: string, hostId: string): void {
    threadHosts.delete(threadId);
    threadHosts.set(threadId, hostId);
    if (threadHosts.size > THREAD_CACHE_LIMIT) {
      const oldest = threadHosts.keys().next().value;
      if (oldest !== undefined) threadHosts.delete(oldest);
    }
  }

  /**
   * The machine a thread runs on. A failure to resolve is `hostId: null`,
   * which callers must treat as not the server.
   */
  async function machineOf(
    threadId: string,
    environmentId?: string | null,
  ): Promise<MachineIdentity> {
    try {
      const environment =
        environmentId ?? (await sdk.threads.get({ threadId })).environmentId;
      if (!environment) {
        return { hostId: null, hostName: null };
      }
      const { hostId } = await sdk.environments.get({ environmentId: environment });
      if (hostId) remember(threadId, hostId);
      return { hostId, hostName: hostId ? await hostName(hostId) : null };
    } catch {
      return { hostId: null, hostName: null };
    }
  }

  return {
    serverHost,
    machineOf,
    /** Cache read for synchronous callers: undefined means not resolved yet; failures are not cached so they are retried. */
    cachedHost(threadId: string): string | undefined {
      return threadHosts.get(threadId);
    },
    /** The cached server, when it has resolved. */
    cachedServer(): ServerHost | null {
      return server;
    },
    clear(): void {
      server = null;
      threadHosts.clear();
    },
  };
}
