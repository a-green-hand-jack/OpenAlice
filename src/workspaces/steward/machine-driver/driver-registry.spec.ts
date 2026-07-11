import { describe, expect, it, vi } from 'vitest';

import { MachineDriverRegistry } from './driver-registry.js';
import type { StewardMachineDriver } from './types.js';

/** Minimal fake driver with a dispose counter — the registry only calls
 *  `dispose()`, so the rest of the interface is inert. */
function makeFakeDriver(): { driver: StewardMachineDriver; disposed: () => number } {
  let disposed = 0;
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
    isThreadLive: () => true,
    readTelemetry: () => null,
    dispose: async () => {
      disposed += 1;
    },
  };
  return { driver, disposed: () => disposed };
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
