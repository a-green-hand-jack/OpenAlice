import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createTradingTools } from '../../tool/trading.js'
import { CLI_EXPORTS, mappedToolNames } from '../../server/cli-commands.js'

const repoSrc = new URL('../../..', import.meta.url)

describe('authz change surfaces are human-only', () => {
  it('does not expose authz mutation through trading tools or CLI catalogs', () => {
    const tradingToolNames = Object.keys(createTradingTools({} as never))
    for (const name of tradingToolNames) {
      expect(name).not.toMatch(/authz|maxAuthz|authzLevel/i)
    }
    for (const key of Object.keys(CLI_EXPORTS)) {
      for (const name of mappedToolNames(key)) {
        expect(name).not.toMatch(/authz|maxAuthz|authzLevel/i)
      }
    }
  })

  it('keeps the workspace registry authzLevel mutator behind the audited human route', async () => {
    const hits: string[] = []
    for (const file of await tsFiles(repoSrc)) {
      const rel = relative(repoSrc.pathname, file)
      if (rel.endsWith('.spec.ts')) continue
      const source = await readFile(file, 'utf8')
      if (source.includes('.setAuthzLevel(')) hits.push(rel)
    }
    expect(hits).toEqual(['src/webui/routes/workspaces.ts'])

    const routeSource = await readFile(new URL('./workspaces.ts', import.meta.url), 'utf8')
    expect(routeSource).toContain("opts.authzProducer.emit('authz.level-changed'")
  })

  it('audits account maxAuthzLevel changes in the Settings config write path', async () => {
    const source = await readFile(new URL('./trading-config.ts', import.meta.url), 'utf8')
    expect(source).toContain('const from = normalizeAuthzLevel(existing.maxAuthzLevel)')
    expect(source).toContain("authzProducer.emit('authz.level-changed'")
  })
})

async function tsFiles(root: URL): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  await visit(root.pathname)
  return out
}
