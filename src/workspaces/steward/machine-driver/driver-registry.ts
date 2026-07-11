import type { StewardMachineDriver } from './types.js';

/**
 * In-memory registry of live `StewardMachineDriver` instances, one per
 * workspace (issue #146). Purely runtime — no persistence (the resumable thread
 * id lives in `MachineThreadStore`); a fresh process starts with an empty
 * registry and lazily re-creates drivers on demand. S3's dispatcher populates
 * it via `getOrCreate`; the supervisor only reads it (liveness + telemetry). A
 * workspace with no entry means "no live driver" — the supervisor's reader
 * accessors resolve to not-live / null, which is exactly the pre-S3 state.
 */
export class MachineDriverRegistry {
  private readonly drivers = new Map<string, StewardMachineDriver>();

  get(wsId: string): StewardMachineDriver | undefined {
    return this.drivers.get(wsId);
  }

  /** Return the workspace's driver, creating and caching it via `factory` on
   *  first use. `factory` runs only when there is no existing entry. */
  getOrCreate(wsId: string, factory: () => StewardMachineDriver): StewardMachineDriver {
    const existing = this.drivers.get(wsId);
    if (existing) return existing;
    const created = factory();
    this.drivers.set(wsId, created);
    return created;
  }

  /**
   * Like {@link getOrCreate}, but EVICTS a cached driver that reports unhealthy
   * before reusing it (issue #146 S5, item 2). Without this, an app-server crash
   * leaves a dead client memoized here and the next wake reuses it. The dead
   * driver is disposed (fire-and-forget — the replacement must not block on a
   * broken transport's teardown), forgotten, `onEvict` fired for the caller's
   * structured event, then a fresh driver is built via `factory`. A healthy
   * cached driver is returned untouched.
   */
  getOrCreateHealthy(
    wsId: string,
    factory: () => StewardMachineDriver,
    onEvict?: (info: { readonly wsId: string }) => void,
  ): StewardMachineDriver {
    const existing = this.drivers.get(wsId);
    if (existing) {
      if (existing.isHealthy()) return existing;
      this.drivers.delete(wsId);
      void existing.dispose().catch(() => undefined);
      onEvict?.({ wsId });
    }
    const created = factory();
    this.drivers.set(wsId, created);
    return created;
  }

  /** Dispose and forget one workspace's driver. Idempotent — a no-op if absent. */
  async dispose(wsId: string): Promise<void> {
    const driver = this.drivers.get(wsId);
    if (!driver) return;
    this.drivers.delete(wsId);
    await driver.dispose();
  }

  /**
   * Dispose every driver and clear the registry (process shutdown).
   * allSettled, not all: one rejecting driver must not strand the teardown
   * that runs after this call (pool, transcript watcher, process lock).
   */
  async disposeAll(): Promise<void> {
    const drivers = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(drivers.map((driver) => driver.dispose()));
  }
}
