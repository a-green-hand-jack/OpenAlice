/**
 * Economy AI Tools
 *
 * Macro / economic data surface exposed to the AI agent. Backed by
 * multiple providers under the hood — semantics drives the namespace
 * (the AI sees one cohesive "look up macro indicators" toolset), even
 * though the underlying SDK clients route them differently:
 *
 *   FRED (federal_reserve) — economyFredSearch / FredSeries / FredRegional
 *     (routed via /economy/* on the HTTP layer; uses EconomyClientLike)
 *   EIA — economyEnergyOutlook / economyPetroleumStatus
 *     (routed via /commodity/* upstream — OpenBB classifies oil/gas as
 *     commodity data; uses CommodityClientLike. Conceptually macro for
 *     the AI, structurally commodity for the wire.)
 *
 * Provider names are pinned at the tool boundary so the LLM never has
 * to know about the federal_reserve / eia provider strings.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { EconomyClientLike, CommodityClientLike } from '@/domain/market-data/client/types'

const FRED_PROVIDER = 'federal_reserve'
const EIA_PROVIDER = 'eia'
const BLS_PROVIDER = 'bls'

export function createEconomyTools(
  economyClient: EconomyClientLike,
  commodityClient: CommodityClientLike,
) {
  return {
    economyFredSearch: tool({
      description: `Search the FRED database for economic time series by keyword.

Returns a list of matching series with id, title, frequency, units, and seasonal adjustment.
Use this to discover the FRED series_id for a metric (e.g. "unemployment" → UNRATE,
"GDP" → GDP, "CPI" → CPIAUCSL), then pass the id to economyFredSeries to get observations.

The query is keyword-based and matches series titles + tags; expect dozens of hits per
common term. Increase limit only if you need to scan beyond the most popular results.`,
      inputSchema: z.object({
        query: z.string().describe('Keyword(s) to search FRED, e.g. "unemployment", "GDP", "CPI"'),
        limit: z.number().int().positive().optional().describe('Max results to return (default: 100)'),
      }).meta({ examples: [{ query: 'unemployment' }] }),
      execute: async ({ query, limit }) => {
        const params: Record<string, unknown> = { query, provider: FRED_PROVIDER }
        if (limit !== undefined) params.limit = limit
        return await economyClient.fredSearch(params)
      },
    }),

    economyFredSeries: tool({
      description: `Fetch observation values for one or more FRED series.

Pass a single series_id (e.g. "GDP") or comma-separated ids (e.g. "GDP,UNRATE,CPIAUCSL")
to retrieve and merge multiple series into one date-indexed result.

When limit is set without a date range, returns the LATEST N observations (e.g. limit=12
on a monthly series gives the most recent year). To pull a specific window, pass
start_date and/or end_date in YYYY-MM-DD form.

If you don't know the series_id, call economyFredSearch first.`,
      inputSchema: z.object({
        symbol: z.string().describe('FRED series id, or comma-separated ids for multi-series merge'),
        start_date: z.string().optional().describe('Start date YYYY-MM-DD (optional)'),
        end_date: z.string().optional().describe('End date YYYY-MM-DD (optional)'),
        limit: z.number().int().positive().optional().describe('Max observations per series (returns latest N when no date range given)'),
        frequency: z.string().optional().describe('Aggregation frequency override (e.g. "m", "q", "a")'),
      }).meta({ examples: [{ symbol: 'UNRATE', limit: 12 }] }),
      execute: async ({ symbol, start_date, end_date, limit, frequency }) => {
        const params: Record<string, unknown> = { symbol, provider: FRED_PROVIDER }
        if (start_date !== undefined) params.start_date = start_date
        if (end_date !== undefined) params.end_date = end_date
        if (limit !== undefined) params.limit = limit
        if (frequency !== undefined) params.frequency = frequency
        return await economyClient.fredSeries(params)
      },
    }),

    economyFredRegional: tool({
      description: `Fetch a US state-level cross-section for a FRED regional series.

The symbol is the regional series id (e.g. "WIPCPI" for per-capita personal income,
"UNRATE" for unemployment rate). Returns one row per region (~50 states + DC + territories)
with region name, code, and value for the given date.

Use this for state-by-state comparisons; for time-series of a single region,
use economyFredSeries with the region-specific id (e.g. "CAPCPI" for California
per-capita income).`,
      inputSchema: z.object({
        symbol: z.string().describe('FRED regional series id (e.g. "WIPCPI" for per-capita income)'),
        date: z.string().optional().describe('Observation date YYYY-MM-DD (defaults to latest available)'),
        region_type: z.string().optional().describe('Region granularity: "state" (default), "msa", "county"'),
        start_date: z.string().optional().describe('Start date for ranged queries (optional)'),
      }).meta({ examples: [{ symbol: 'WIPCPI' }] }),
      execute: async ({ symbol, date, region_type, start_date }) => {
        const params: Record<string, unknown> = { symbol, provider: FRED_PROVIDER }
        if (date !== undefined) params.date = date
        if (region_type !== undefined) params.region_type = region_type
        if (start_date !== undefined) params.start_date = start_date
        return await economyClient.fredRegional(params)
      },
    }),

    economyBlsSearch: tool({
      description: `Search the Bureau of Labor Statistics catalog for a series_id by keyword.

Returns a small curated list of common BLS series matching the query (CPI,
unemployment rate, nonfarm payrolls, JOLTS, PPI, productivity, etc.). BLS
itself does not expose a search API — this is a hand-maintained catalog
on the provider side, so coverage is intentionally narrow rather than
exhaustive.

Once you have the series_id, pass it to economyBlsSeries to get observations.`,
      inputSchema: z.object({
        query: z.string().describe('Keyword to filter the BLS catalog, e.g. "unemployment", "CPI", "JOLTS"'),
        limit: z.number().int().positive().optional().describe('Max results to return (default: 100)'),
      }).meta({ examples: [{ query: 'CPI' }] }),
      execute: async ({ query, limit }) => {
        const params: Record<string, unknown> = { query, provider: BLS_PROVIDER }
        if (limit !== undefined) params.limit = limit
        return await economyClient.getBlsSearch(params)
      },
    }),

    economyBlsSeries: tool({
      description: `Fetch observations for one or more BLS series.

Pass a single series_id (e.g. "LNS14000000" for unemployment rate) or
comma-separated ids (e.g. "LNS14000000,CUUR0000SA0") to retrieve multiple
series at once.

NOTE: Unlike economyFredSeries which pivots multi-series into one row per
date with a column per series, BLS results are returned in long form:
one row per (date, series_id) with a single \`value\` column. Filter or
group client-side if you need a pivot.

Default time window is the last 10 years if no date range is given. BLS
returns null/missing for unavailable observations (e.g. months affected
by funding lapses) — those rows are dropped before returning.

If you don't know the series_id, call economyBlsSearch first.`,
      inputSchema: z.object({
        symbol: z.string().describe('BLS series id, or comma-separated ids for multi-series'),
        start_date: z.string().optional().describe('Start date YYYY-MM-DD (only year is used; default: 10 years ago)'),
        end_date: z.string().optional().describe('End date YYYY-MM-DD (only year is used; default: current year)'),
      }).meta({ examples: [{ symbol: 'LNS14000000' }] }),
      execute: async ({ symbol, start_date, end_date }) => {
        const params: Record<string, unknown> = { symbol, provider: BLS_PROVIDER }
        if (start_date !== undefined) params.start_date = start_date
        if (end_date !== undefined) params.end_date = end_date
        return await economyClient.getBlsSeries(params)
      },
    }),

    economyEnergyOutlook: tool({
      description: `Fetch the EIA Short-Term Energy Outlook (STEO) for a given category.

Returns ~10 years of monthly observations (mix of historical + forecast). The
\`forecast\` field on each row is true when the observation is a projection,
false when it is a realised value — useful for distinguishing "what happened"
from "what EIA expects".

Use for energy-market context (oil price trajectory, refinery throughput,
gasoline price, gas/petroleum production trends). For macro indicators like
GDP / unemployment / CPI, use economyFredSeries instead.`,
      inputSchema: z.object({
        category: z.enum([
          'crude_oil_price',
          'gasoline_price',
          'natural_gas_price',
          'crude_oil_production',
          'petroleum_consumption',
        ]).describe('STEO category'),
        start_date: z.string().optional().describe('Start date YYYY-MM-DD (optional)'),
        end_date: z.string().optional().describe('End date YYYY-MM-DD (optional)'),
      }).meta({ examples: [{ category: 'crude_oil_price' }] }),
      execute: async ({ category, start_date, end_date }) => {
        const params: Record<string, unknown> = { category, provider: EIA_PROVIDER }
        if (start_date !== undefined) params.start_date = start_date
        if (end_date !== undefined) params.end_date = end_date
        return await commodityClient.getEnergyOutlook(params)
      },
    }),

    economyPetroleumStatus: tool({
      description: `Fetch the EIA Weekly Petroleum Status Report for a given category.

Returns ~5 years of weekly observations (no forecast — this is the EIA's
realised inventory + production data, released every Wednesday). Use for
short-horizon energy-market signals: crude/gasoline/distillate stock draws,
refinery utilisation, US crude production.

Categories cover commercial inventories ("..._stocks"), production, and
refinery utilisation. For longer-horizon outlook + forecasts use
economyEnergyOutlook.`,
      inputSchema: z.object({
        category: z.enum([
          'crude_oil_production',
          'crude_oil_stocks',
          'gasoline_stocks',
          'distillate_stocks',
          'refinery_utilization',
        ]).describe('Petroleum data category'),
        start_date: z.string().optional().describe('Start date YYYY-MM-DD (optional)'),
        end_date: z.string().optional().describe('End date YYYY-MM-DD (optional)'),
      }).meta({ examples: [{ category: 'crude_oil_stocks' }] }),
      execute: async ({ category, start_date, end_date }) => {
        const params: Record<string, unknown> = { category, provider: EIA_PROVIDER }
        if (start_date !== undefined) params.start_date = start_date
        if (end_date !== undefined) params.end_date = end_date
        return await commodityClient.getPetroleumStatus(params)
      },
    }),
  }
}
