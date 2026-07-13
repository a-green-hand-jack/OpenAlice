import { createHash } from 'node:crypto';

export const D4_CELL_SCHEMA = 'steward-d4-candidate-cell/1';
export const D4_AUDIT_SCHEMA = 'steward-d4-cell-audit/1';
export const D4_SOURCE_RECEIPT_SCHEMA = 'steward-d4-source-receipt/1';
export const D4_FROZEN_AT = '2026-07-13T00:00:00.000Z';
export const D4_DATA_ROOT = 'tools/campaigns/data/d4-smoke-dev-a';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const D4_PROFILES = Object.freeze({
  bull: Object.freeze({
    barInterval: '1d',
    cadenceBars: 5,
    lookbackBars: 60,
    decisionCount: 12,
    sourceInterval: '1d',
    sourceStart: '2019-01-01T00:00:00.000Z',
    sourceEndExclusive: '2024-01-01T00:00:00.000Z',
  }),
  bear: Object.freeze({
    barInterval: '4h',
    cadenceBars: 6,
    lookbackBars: 90,
    decisionCount: 12,
    sourceInterval: '1h',
    sourceStart: '2024-08-01T00:00:00.000Z',
    sourceEndExclusive: '2026-07-01T00:00:00.000Z',
  }),
});

export const D4_INSTRUMENTS = Object.freeze([
  Object.freeze({
    market: 'crypto-major', provider: 'binance-public', symbol: 'BTCUSDT',
    assetClass: 'crypto', timezone: 'UTC', exchangeCalendar: '24/7',
  }),
  Object.freeze({
    market: 'us-index-etf', provider: 'yahoo-chart-public', symbol: 'SPY',
    assetClass: 'equity-etf', timezone: 'America/New_York', exchangeCalendar: 'XNYS',
  }),
  Object.freeze({
    market: 'us-single', provider: 'yahoo-chart-public', symbol: 'NVDA',
    assetClass: 'equity', timezone: 'America/New_York', exchangeCalendar: 'XNAS',
  }),
  Object.freeze({
    market: 'gcn-equity', provider: 'yahoo-chart-public', symbol: '0700.HK',
    assetClass: 'equity', timezone: 'Asia/Hong_Kong', exchangeCalendar: 'XHKG',
  }),
  Object.freeze({
    market: 'fx', provider: 'yahoo-chart-public', symbol: 'EURUSD=X',
    assetClass: 'fx', timezone: 'UTC', exchangeCalendar: '24/5',
  }),
  Object.freeze({
    market: 'commodity-proxy', provider: 'yahoo-chart-public', symbol: 'USO',
    assetClass: 'commodity-etf', timezone: 'America/New_York', exchangeCalendar: 'XNYS',
  }),
]);

export function d4CanonicalRoster() {
  return D4_INSTRUMENTS.flatMap((instrument) => ['bull', 'bear'].map((profile) => ({
    ...instrument,
    profile,
    window: 'a',
    cellId: `d4-${instrument.market}-${profile}-a`,
  })));
}

export function d4ProfileTotalBars(profile) {
  return profile.lookbackBars + profile.decisionCount * profile.cadenceBars;
}

export function d4DecisionSlices(profile) {
  return Array.from({ length: profile.decisionCount }, (_, ordinal) => {
    const visibleEndExclusive = profile.lookbackBars + ordinal * profile.cadenceBars;
    return {
      ordinal: ordinal + 1,
      visibleStart: 0,
      visibleEndExclusive,
      visibleBarCount: visibleEndExclusive,
      asOfBarIndex: visibleEndExclusive - 1,
    };
  });
}

export function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalBarsBytes(bars) {
  return `${stableJson(bars)}\n`;
}

export function assertChronologicalBars(bars, expectedIntervalMs = null) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('bars must be a non-empty array');
  let previous = -Infinity;
  for (const [index, bar] of bars.entries()) {
    const timestamp = Date.parse(bar.timestamp);
    const availableAt = Date.parse(bar.availableAt);
    if (!Number.isFinite(timestamp) || !Number.isFinite(availableAt)) {
      throw new Error(`bar ${index} has an invalid timestamp`);
    }
    if (timestamp <= previous) throw new Error(`bar ${index} is not strictly chronological`);
    if (availableAt <= timestamp) throw new Error(`bar ${index} must become available after it opens`);
    if (expectedIntervalMs !== null && availableAt - timestamp !== expectedIntervalMs) {
      throw new Error(`bar ${index} has an unexpected availability interval`);
    }
    const { open, high, low, close, volume } = bar;
    if (![open, high, low, close, volume].every(Number.isFinite)) {
      throw new Error(`bar ${index} contains a non-finite value`);
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 ||
        high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      throw new Error(`bar ${index} has invalid OHLCV bounds`);
    }
    previous = timestamp;
  }
  return bars;
}

/** Aggregate complete UTC-aligned buckets only. Partial sessions and gaps are
 * dropped rather than being mislabeled as four-hour bars. */
export function aggregateFourHourBars(hourlyBars) {
  assertChronologicalBars(hourlyBars, HOUR_MS);
  const bucketMs = 4 * HOUR_MS;
  const groups = new Map();
  for (const bar of hourlyBars) {
    const bucket = Math.floor(Date.parse(bar.timestamp) / bucketMs) * bucketMs;
    const group = groups.get(bucket) ?? [];
    group.push(bar);
    groups.set(bucket, group);
  }

  const derived = [];
  for (const group of groups.values()) {
    if (group.length !== 4) continue;
    if (group.some((bar, index) => index > 0 &&
      Date.parse(bar.timestamp) - Date.parse(group[index - 1].timestamp) !== HOUR_MS)) continue;
    derived.push({
      timestamp: group[0].timestamp,
      availableAt: group[3].availableAt,
      open: group[0].open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group[3].close,
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
      sourceTimestamps: group.map((bar) => bar.timestamp),
    });
  }
  return assertChronologicalBars(derived, 4 * HOUR_MS);
}

export function selectRegimeWindow(bars, totalBars, profileName) {
  if (!Number.isSafeInteger(totalBars) || totalBars < 2 || bars.length < totalBars) {
    throw new Error(`cannot select ${totalBars} bars from ${bars.length}`);
  }
  if (profileName !== 'bull' && profileName !== 'bear') throw new Error(`unsupported profile: ${profileName}`);
  let selected = null;
  for (let start = 0; start + totalBars <= bars.length; start += 1) {
    const end = start + totalBars;
    const first = bars[start].close;
    const last = bars[end - 1].close;
    const score = Math.log(last / first);
    if (!Number.isFinite(score)) throw new Error(`non-finite regime score at bar ${start}`);
    if (selected === null || (profileName === 'bull' ? score > selected.score : score < selected.score)) {
      selected = { start, endExclusive: end, score };
    }
  }
  if ((profileName === 'bull' && selected.score <= 0) || (profileName === 'bear' && selected.score >= 0)) {
    throw new Error(`${profileName} source has no directionally consistent exact window`);
  }
  return selected;
}

export function sourceBarsForDerivedWindow(sourceBars, selectedDerivedBars) {
  const timestamps = new Set(selectedDerivedBars.flatMap((bar) => bar.sourceTimestamps ?? [bar.timestamp]));
  const selected = sourceBars.filter((bar) => timestamps.has(bar.timestamp));
  const expected = selectedDerivedBars.reduce((sum, bar) => sum + (bar.sourceTimestamps?.length ?? 1), 0);
  if (selected.length !== expected) throw new Error(`selected source coverage mismatch: ${selected.length} != ${expected}`);
  return selected;
}

export function anonymizeBars(bars) {
  assertChronologicalBars(bars);
  const priceBase = bars[0].close;
  if (!(priceBase > 0)) throw new Error('first close must be positive');
  const volumeBase = bars.find((bar) => bar.volume > 0)?.volume ?? null;
  return bars.map((bar, index) => ({
    index,
    open: round((bar.open / priceBase) * 100),
    high: round((bar.high / priceBase) * 100),
    low: round((bar.low / priceBase) * 100),
    close: round((bar.close / priceBase) * 100),
    volume: volumeBase === null ? 0 : round((bar.volume / volumeBase) * 100),
  }));
}

export function reverseFutureSplitAdjustments(bars, splitEvents, asOf) {
  const asOfMs = Date.parse(asOf);
  return bars.map((bar) => {
    const barMs = Date.parse(bar.timestamp);
    const factor = splitEvents.reduce((product, event) => {
      const effectiveMs = Date.parse(event.effectiveAt);
      return effectiveMs > asOfMs && barMs < effectiveMs
        ? product * (event.numerator / event.denominator)
        : product;
    }, 1);
    if (factor === 1) return { ...bar };
    return {
      ...bar,
      open: bar.open * factor,
      high: bar.high * factor,
      low: bar.low * factor,
      close: bar.close * factor,
      volume: bar.volume / factor,
    };
  });
}

export function decisionSnapshotBytes(cell, decision) {
  return `${stableJson({
    schema: 'steward-d4-decision-snapshot/1',
    instrument: cell.codename,
    interval: cell.interval,
    decisionOrdinal: decision.ordinal,
    visibleRange: [decision.visibleStart, decision.visibleEndExclusive],
    bars: cell.bars.slice(decision.visibleStart, decision.visibleEndExclusive),
  })}\n`;
}

export async function fetchSourceBars(instrument, profile) {
  if (instrument.provider === 'binance-public') return fetchBinanceBars(instrument.symbol, profile);
  if (instrument.provider === 'yahoo-chart-public') return fetchYahooBars(instrument.symbol, profile);
  throw new Error(`unsupported provider: ${instrument.provider}`);
}

export async function fetchSplitEvidence(instrument) {
  if (instrument.provider === 'binance-public') {
    return {
      providerAdjustmentMode: 'native_unadjusted',
      cutoff: D4_FROZEN_AT,
      request: null,
      events: [],
      note: 'Native spot units have no issuer corporate-split action.',
    };
  }
  if (instrument.provider !== 'yahoo-chart-public') {
    throw new Error(`unsupported split-evidence provider: ${instrument.provider}`);
  }
  const startMs = Date.parse(D4_PROFILES.bull.sourceStart);
  const endMs = Date.parse(D4_FROZEN_AT);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(instrument.symbol)}`);
  url.searchParams.set('period1', String(Math.floor(startMs / 1000)));
  url.searchParams.set('period2', String(Math.floor(endMs / 1000)));
  url.searchParams.set('interval', '1d');
  url.searchParams.set('events', 'splits');
  url.searchParams.set('includeAdjustedClose', 'false');
  url.searchParams.set('includePrePost', 'false');
  const response = await fetch(url, {
    headers: { 'user-agent': 'OpenAlice-D4-Smoke/1' },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || body?.chart?.error || !body?.chart?.result?.[0]) {
    throw new Error(`Yahoo split evidence failed for ${instrument.symbol}: ${response.status} ${JSON.stringify(body?.chart?.error)}`);
  }
  const rawEvents = Object.values(body.chart.result[0].events?.splits ?? {});
  const events = rawEvents.map((event) => ({
    effectiveAt: new Date(Number(event.date) * 1000).toISOString(),
    numerator: Number(event.numerator),
    denominator: Number(event.denominator),
    splitRatio: String(event.splitRatio),
  })).sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt));
  for (const [index, event] of events.entries()) {
    if (!(event.numerator > 0) || !(event.denominator > 0) ||
        !Number.isFinite(Date.parse(event.effectiveAt)) || Date.parse(event.effectiveAt) > endMs) {
      throw new Error(`invalid Yahoo split evidence ${instrument.symbol}[${index}]`);
    }
  }
  return {
    providerAdjustmentMode: 'retrospective_split_adjusted',
    cutoff: D4_FROZEN_AT,
    request: {
      method: 'GET',
      url: url.toString(),
      normalization: 'Yahoo split events through the frozen cutoff; sorted by effective timestamp.',
    },
    events,
    note: 'Yahoo chart quote OHLCV is retrospectively normalized for split events even when adjusted-close output is disabled.',
  };
}

async function fetchYahooBars(symbol, profile) {
  const startMs = Date.parse(profile.sourceStart);
  const endMs = Date.parse(profile.sourceEndExclusive);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', String(Math.floor(startMs / 1000)));
  url.searchParams.set('period2', String(Math.floor(endMs / 1000)));
  url.searchParams.set('interval', profile.sourceInterval);
  url.searchParams.set('events', 'div,splits');
  url.searchParams.set('includeAdjustedClose', 'false');
  url.searchParams.set('includePrePost', 'false');
  const response = await fetch(url, {
    headers: { 'user-agent': 'OpenAlice-D4-Smoke/1' },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || body?.chart?.error || !body?.chart?.result?.[0]) {
    throw new Error(`Yahoo source failed for ${symbol}: ${response.status} ${JSON.stringify(body?.chart?.error)}`);
  }
  const result = body.chart.result[0];
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error(`Yahoo source returned no quote data for ${symbol}`);
  const intervalMs = profile.sourceInterval === '1h' ? HOUR_MS : DAY_MS;
  const bars = [];
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const timestampMs = result.timestamp[index] * 1000;
    if (timestampMs < startMs || timestampMs >= endMs) continue;
    const open = Number(quote.open[index]);
    const high = Number(quote.high[index]);
    const low = Number(quote.low[index]);
    const close = Number(quote.close[index]);
    const rawVolume = Number(quote.volume?.[index] ?? 0);
    if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) continue;
    bars.push({
      timestamp: new Date(timestampMs).toISOString(),
      availableAt: new Date(timestampMs + intervalMs).toISOString(),
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : 0,
    });
  }
  return {
    bars: assertChronologicalBars(bars, intervalMs),
    providerAdjustmentMode: 'retrospective_split_adjusted',
    request: {
      method: 'GET',
      url: url.toString(),
      normalization: 'chart.result[0] OHLCV; requested half-open range; non-finite/nonpositive rows removed; high/low expanded to include open/close; unadjusted',
    },
  };
}

async function fetchBinanceBars(symbol, profile) {
  const startMs = Date.parse(profile.sourceStart);
  const endMs = Date.parse(profile.sourceEndExclusive);
  const intervalMs = profile.sourceInterval === '1h' ? HOUR_MS : DAY_MS;
  let cursor = startMs;
  const bars = [];
  while (cursor < endMs) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', profile.sourceInterval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs - 1));
    url.searchParams.set('limit', '1000');
    const response = await fetch(url, {
      headers: { 'user-agent': 'OpenAlice-D4-Smoke/1' },
      signal: AbortSignal.timeout(30_000),
    });
    const rows = await response.json();
    if (!response.ok || !Array.isArray(rows)) {
      throw new Error(`Binance source failed for ${symbol}: ${response.status} ${JSON.stringify(rows)}`);
    }
    if (rows.length === 0) break;
    for (const row of rows) {
      const timestampMs = Number(row[0]);
      if (timestampMs < startMs || timestampMs >= endMs) continue;
      bars.push({
        timestamp: new Date(timestampMs).toISOString(),
        availableAt: new Date(timestampMs + intervalMs).toISOString(),
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
      });
    }
    const next = Number(rows.at(-1)[0]) + intervalMs;
    if (next <= cursor) throw new Error(`Binance pagination stalled for ${symbol}`);
    cursor = next;
  }
  return {
    bars: assertChronologicalBars(bars, intervalMs),
    providerAdjustmentMode: 'native_unadjusted',
    request: {
      method: 'GET',
      url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${profile.sourceInterval}`,
      startTime: startMs,
      endTimeExclusive: endMs,
      pageLimit: 1000,
      normalization: 'Binance kline OHLCV; requested half-open range; paginated by open time; unadjusted',
    },
  };
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function round(value) {
  return Number(value.toFixed(6));
}
