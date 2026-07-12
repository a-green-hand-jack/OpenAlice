import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  calculateStewardModelCostMicros,
  scheduleStewardModelCost,
  summarizeStewardModelCosts,
  type StewardModelCostAccounting,
  type StewardModelCostRequest,
  type StewardStaticModelCatalog,
} from './model-cost-scheduler.js';

function model(
  id: string,
  options: {
    qualityScore?: number;
    inputPrice?: number;
    outputPrice?: number;
    maxRequests?: number | null;
  } = {},
): StewardStaticModelCatalog['models'][number] {
  return {
    id,
    enabled: true,
    capabilities: ['reasoning', 'structured_output'],
    qualityScore: options.qualityScore ?? 80,
    pricing: {
      inputMicrosPerMillionTokens: options.inputPrice ?? 1_000_000,
      outputMicrosPerMillionTokens: options.outputPrice ?? 2_000_000,
    },
    quota: {
      maxRequests: options.maxRequests ?? 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxCostMicros: 100_000,
    },
  };
}

function catalog(models = [model('model-beta'), model('model-alpha')]): StewardStaticModelCatalog {
  return {
    schema: 'steward-static-model-catalog/1',
    version: 1,
    source: 'fixture',
    catalogId: 'fixture-models',
    models,
  };
}

function accounting(over: Partial<StewardModelCostAccounting> = {}): StewardModelCostAccounting {
  return {
    schema: 'steward-model-cost-accounting/1',
    version: 1,
    catalogId: 'fixture-models',
    catalogVersion: 1,
    periodId: '2026-07',
    budgetMicros: 100_000,
    entries: [],
    ...over,
  };
}

function request(runId = 'run-1'): StewardModelCostRequest {
  return {
    schema: 'steward-model-cost-request/1',
    version: 1,
    runId,
    wakeId: `wake-${runId}`,
    requiredCapabilities: ['reasoning'],
    minimumQualityScore: 70,
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 500,
    maxCostMicros: 10_000,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('D3-1 scheduler must not use the network');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deterministic steward model-cost scheduler', () => {
  it('selects by cost, quality, then model id independent of catalog order', () => {
    const left = scheduleStewardModelCost({
      catalog: catalog([model('model-beta'), model('model-alpha')]),
      accounting: accounting(),
      request: request(),
    });
    const right = scheduleStewardModelCost({
      catalog: catalog([model('model-alpha'), model('model-beta')]),
      accounting: accounting(),
      request: request(),
    });

    expect(left).toMatchObject({ status: 'selected', modelId: 'model-alpha', estimatedCostMicros: 2_000 });
    expect(right).toMatchObject({ status: 'selected', modelId: 'model-alpha', estimatedCostMicros: 2_000 });
    expect(left.status === 'selected' && right.status === 'selected'
      ? left.reservation
      : null).toEqual(right.status === 'selected' ? right.reservation : null);
  });

  it('prefers higher quality only when deterministic estimated cost ties', () => {
    const result = scheduleStewardModelCost({
      catalog: catalog([
        model('model-cheap-low-quality', { qualityScore: 71 }),
        model('model-cheap-high-quality', { qualityScore: 95 }),
        model('model-expensive', { qualityScore: 100, inputPrice: 4_000_000 }),
      ]),
      accounting: accounting(),
      request: request(),
    });
    expect(result).toMatchObject({ status: 'selected', modelId: 'model-cheap-high-quality' });
  });

  it('reserves quota and cost, then deterministically moves to the next eligible model', () => {
    const first = scheduleStewardModelCost({
      catalog: catalog(),
      accounting: accounting(),
      request: request('run-1'),
    });
    if (first.status !== 'selected') throw new Error('first schedule unexpectedly rejected');
    expect(summarizeStewardModelCosts(catalog(), first.accounting)).toEqual({
      requests: 1,
      inputTokens: 1_000,
      outputTokens: 500,
      costMicros: 2_000,
      remainingBudgetMicros: 98_000,
      byModel: {
        'model-alpha': {
          requests: 1,
          inputTokens: 1_000,
          outputTokens: 500,
          costMicros: 2_000,
        },
      },
    });

    const second = scheduleStewardModelCost({
      catalog: catalog(),
      accounting: first.accounting,
      request: request('run-2'),
    });
    expect(second).toMatchObject({
      status: 'selected',
      modelId: 'model-beta',
      rejections: [expect.objectContaining({ modelId: 'model-alpha', reasons: ['request_quota'] })],
    });
  });

  it('enforces __proto__ quotas, summarizes safely, and rejects repeated scheduling without prototype pollution', () => {
    const protoCatalog = catalog([model('__proto__', { maxRequests: 1 })]);
    const first = scheduleStewardModelCost({
      catalog: protoCatalog,
      accounting: accounting(),
      request: request('proto-run-1'),
    });
    if (first.status !== 'selected') throw new Error('prototype-key first schedule unexpectedly rejected');
    expect(first.modelId).toBe('__proto__');

    const summary = summarizeStewardModelCosts(protoCatalog, first.accounting);
    expect(Object.prototype.hasOwnProperty.call(summary.byModel, '__proto__')).toBe(true);
    expect(summary.byModel['__proto__']).toEqual({
      requests: 1,
      inputTokens: 1_000,
      outputTokens: 500,
      costMicros: 2_000,
    });
    expect((Object.prototype as { requests?: unknown }).requests).toBeUndefined();

    expect(scheduleStewardModelCost({
      catalog: protoCatalog,
      accounting: first.accounting,
      request: request('proto-run-2'),
    })).toMatchObject({
      status: 'rejected',
      code: 'no_eligible_model',
      rejections: [expect.objectContaining({ modelId: '__proto__', reasons: ['request_quota'] })],
    });
  });

  it.each(['__proto__', 'constructor'])(
    'does not let prototype key %s bypass a zero request quota',
    (modelId) => {
      const result = scheduleStewardModelCost({
        catalog: catalog([
          model(modelId, { maxRequests: 0 }),
          model('fallback-model', { inputPrice: 2_000_000 }),
        ]),
        accounting: accounting(),
        request: request(`run-${modelId}`),
      });

      expect(result).toMatchObject({
        status: 'selected',
        modelId: 'fallback-model',
        rejections: [expect.objectContaining({ modelId, reasons: ['request_quota'] })],
      });
    },
  );

  it('fails closed when global budget or per-request cost cannot fund any candidate', () => {
    const result = scheduleStewardModelCost({
      catalog: catalog(),
      accounting: accounting({ budgetMicros: 1_999 }),
      request: request(),
    });
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'no_eligible_model',
      rejections: [
        expect.objectContaining({ modelId: 'model-alpha', reasons: ['global_budget'] }),
        expect.objectContaining({ modelId: 'model-beta', reasons: ['global_budget'] }),
      ],
    });

    const capped = { ...request(), maxCostMicros: 1_999 };
    const cappedResult = scheduleStewardModelCost({
      catalog: catalog(),
      accounting: accounting(),
      request: capped,
    });
    expect(cappedResult.status).toBe('rejected');
    expect(cappedResult.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasons: ['request_cost_cap'] }),
    ]));
  });

  it('rejects tampered accounting instead of trusting caller-provided cost', () => {
    const tampered = accounting({
      entries: [{
        kind: 'usage',
        runId: 'past-run',
        wakeId: 'past-wake',
        modelId: 'model-alpha',
        inputTokens: 1_000,
        outputTokens: 500,
        costMicros: 1,
      }],
    });
    expect(scheduleStewardModelCost({
      catalog: catalog(),
      accounting: tampered,
      request: request(),
    })).toMatchObject({ status: 'rejected', code: 'accounting_invalid' });
  });

  it('uses integer micro-USD accounting with deterministic round-up', () => {
    expect(calculateStewardModelCostMicros(model('m'), 1, 1)).toBe(3);
    expect(calculateStewardModelCostMicros(model('m'), 1_000, 500)).toBe(2_000);
  });

  it('accepts only static or fixture catalogs and performs zero network/model activity', () => {
    const fetchSpy = vi.mocked(fetch);
    expect(scheduleStewardModelCost({
      catalog: { ...catalog(), source: 'remote' },
      accounting: accounting(),
      request: request(),
    })).toMatchObject({ status: 'rejected', code: 'invalid_input' });

    expect(scheduleStewardModelCost({
      catalog: catalog(),
      accounting: accounting(),
      request: request(),
    }).status).toBe('selected');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
