/**
 * Steward session rotation decision (issue #132).
 *
 * Covers the pure decision (`decideStewardRotation`), threshold resolution from
 * workspace config, and the adapter-driven `evaluateStewardRotation` seam —
 * including its failure isolation: an adapter with no telemetry method, or one
 * whose read throws, yields a no-rotate `telemetry_unavailable` decision so a
 * wake is never blocked on telemetry.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ContextTelemetry } from '../cli-adapter.js';
import {
  DEFAULT_ROTATION_THRESHOLD,
  decideStewardRotation,
  evaluateStewardRotation,
  resolveRotationThreshold,
} from './rotation.js';

const tel = (inputTokens: number, modelContextWindow: number): ContextTelemetry => ({
  inputTokens,
  modelContextWindow,
  source: '/tmp/rollout.jsonl',
});

describe('decideStewardRotation', () => {
  it('rotates when the window is already exceeded', () => {
    const d = decideStewardRotation(tel(125765, 121600), 0.65);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('window_exceeded');
  });

  it('rotates when input tokens cross threshold × window', () => {
    // 0.65 × 121600 = 79040; 80000 is over.
    const d = decideStewardRotation(tel(80000, 121600), 0.65);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('over_threshold');
  });

  it('reuses when input tokens are under threshold', () => {
    const d = decideStewardRotation(tel(24345, 121600), 0.65);
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('under_threshold');
  });

  it('does not rotate when telemetry is null', () => {
    const d = decideStewardRotation(null, 0.65);
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('telemetry_unavailable');
    expect(d.telemetry).toBeNull();
  });
});

describe('resolveRotationThreshold', () => {
  it('defaults when unset', () => {
    expect(resolveRotationThreshold({})).toBe(DEFAULT_ROTATION_THRESHOLD);
  });

  it('reads sessionRotation.threshold when a valid fraction', () => {
    expect(resolveRotationThreshold({ sessionRotation: { threshold: 0.8 } })).toBe(0.8);
  });

  it('falls back for out-of-range or non-numeric values', () => {
    expect(resolveRotationThreshold({ sessionRotation: { threshold: 0 } })).toBe(DEFAULT_ROTATION_THRESHOLD);
    expect(resolveRotationThreshold({ sessionRotation: { threshold: 1.5 } })).toBe(DEFAULT_ROTATION_THRESHOLD);
    expect(resolveRotationThreshold({ sessionRotation: { threshold: 'high' } })).toBe(DEFAULT_ROTATION_THRESHOLD);
  });
});

describe('evaluateStewardRotation', () => {
  it('rotates when the adapter reports over-threshold telemetry', async () => {
    const adapter = { id: 'codex', readContextTelemetry: vi.fn(async () => tel(80000, 121600)) };
    const d = await evaluateStewardRotation({ adapter, cwd: '/ws', sessionId: 's1', config: {} });
    expect(adapter.readContextTelemetry).toHaveBeenCalledWith('/ws', 's1');
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('over_threshold');
  });

  it('reuses when the adapter reports under-threshold telemetry', async () => {
    const adapter = { id: 'codex', readContextTelemetry: vi.fn(async () => tel(1000, 121600)) };
    const d = await evaluateStewardRotation({ adapter, cwd: '/ws', sessionId: 's1', config: {} });
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('under_threshold');
  });

  it('reuses (telemetry_unavailable) when the adapter has no telemetry method', async () => {
    const adapter = { id: 'claude' };
    const d = await evaluateStewardRotation({ adapter, cwd: '/ws', sessionId: 's1', config: {} });
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('telemetry_unavailable');
  });

  it('reuses and warns when the telemetry read throws', async () => {
    const adapter = {
      id: 'codex',
      readContextTelemetry: vi.fn(async () => {
        throw new Error('rollout unreadable');
      }),
    };
    const onWarn = vi.fn();
    const d = await evaluateStewardRotation({ adapter, cwd: '/ws', sessionId: 's1', config: {}, onWarn });
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('telemetry_unavailable');
    expect(onWarn).toHaveBeenCalledWith('steward.rotation_telemetry_failed', expect.objectContaining({ sessionId: 's1' }));
  });

  it('honors a workspace-configured threshold', async () => {
    // window 100000, threshold 0.5 -> 50000; 60000 is over.
    const adapter = { id: 'codex', readContextTelemetry: vi.fn(async () => tel(60000, 100000)) };
    const d = await evaluateStewardRotation({
      adapter,
      cwd: '/ws',
      sessionId: 's1',
      config: { sessionRotation: { threshold: 0.5 } },
    });
    expect(d.rotate).toBe(true);
    expect(d.threshold).toBe(0.5);
  });
});
