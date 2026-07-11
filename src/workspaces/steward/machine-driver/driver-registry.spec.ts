import { describe, expect, it, vi } from 'vitest';

import { MachineDriverRegistry } from './driver-registry.js';
import type { StewardMachineDriver } from './types.js';

/** Minimal fake driver with a dispose counter and a settable health flag — the
 *  registry only calls `dispose()` / `isHealthy()`, so the rest is inert. */
function makeFakeDriver(healthy = true): {
  driver: StewardMachineDriver;
  disposed: () => number;
  setHealthy: (v: boolean) => void;
} {
  let disposed = 0;
  let isHealthy = healthy;
  const driver: StewardMachineDriver = {
    ensureThread: async () => ({ threadId: 't', resumed: false }),
    runTurn: async () => ({
      turnId: 't',
      status: 'completed',
      agentMessage: null,
      durationMs: null,
      interrupted: false,
    }),
    interruptTurn: async () => {},
    interruptInFlight: async () => {},
    isThreadLive: () => true,
    isHealthy: () => isHealthy,
    readTelemetry: () => null,
    dispose: async () => {
      disposed += 1;
    },
  };
  return {
    driver,
    disposed: () => disposed,
    setHealthy: (v: boolean) => {
      isHealthy = v;
    },
  };
}

describe('MachineDriverRegistry', () => {
  it('getOrCreate creates once and returns the cached instance thereafter', () => {
    const registry = new MachineDriverRegistry();
    const { driver } = makeFakeDriver();
    const factory = vi.fn(() => driver);

    expect(registry.get('ws-1')).toBeUndefined();
    const first = registry.getOrCreate('ws-1', factory);
    const second = registry.getOrCreate('ws-1', factory);

    expect(first).toBe(driver);
    expect(second).toBe(driver);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.get('ws-1')).toBe(driver);
  });

  it('dispose(wsId) disposes the driver, forgets it, and is idempotent', async () => {
    const registry = new MachineDriverRegistry();
    const { driver, disposed } = makeFakeDriver();
    registry.getOrCreate('ws-1', () => driver);

    await registry.dispose('ws-1');
    expect(disposed()).toBe(1);
    expect(registry.get('ws-1')).toBeUndefined();

    // Second dispose is a no-op — no driver, no extra dispose call, no throw.
    await registry.dispose('ws-1');
    expect(disposed()).toBe(1);
  });

  it('getOrCreateHealthy reuses a healthy cached driver without re-running the factory', () => {
    const registry = new MachineDriverRegistry();
    const { driver } = makeFakeDriver(true);
    const factory = vi.fn(() => driver);
    const onEvict = vi.fn();

    const first = registry.getOrCreateHealthy('ws-1', factory, onEvict);
    const second = registry.getOrCreateHealthy('ws-1', factory, onEvict);

    expect(first).toBe(driver);
    expect(second).toBe(driver);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it('getOrCreateHealthy evicts + disposes a dead driver and builds a fresh one (crash recovery)', async () => {
    const registry = new MachineDriverRegistry();
    const dead = makeFakeDriver(true);
    const fresh = makeFakeDriver(true);
    const factory = vi.fn().mockReturnValueOnce(dead.driver).mockReturnValueOnce(fresh.driver);
    const onEvict = vi.fn();

    const first = registry.getOrCreateHealthy('ws-1', factory, onEvict);
    expect(first).toBe(dead.driver);

    // The app-server crashed: the cached driver now reports unhealthy.
    dead.setHealthy(false);
    const second = registry.getOrCreateHealthy('ws-1', factory, onEvict);

    expect(second).toBe(fresh.driver);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith({ wsId: 'ws-1' });
    // The evicted driver was disposed, and the registry now holds the fresh one.
    await Promise.resolve();
    expect(dead.disposed()).toBe(1);
    expect(registry.get('ws-1')).toBe(fresh.driver);
  });

  it('disposeAll disposes every driver and clears the registry', async () => {
    const registry = new MachineDriverRegistry();
    const a = makeFakeDriver();
    const b = makeFakeDriver();
    registry.getOrCreate('ws-a', () => a.driver);
    registry.getOrCreate('ws-b', () => b.driver);

    await registry.disposeAll();

    expect(a.disposed()).toBe(1);
    expect(b.disposed()).toBe(1);
    expect(registry.get('ws-a')).toBeUndefined();
    expect(registry.get('ws-b')).toBeUndefined();
  });
});
