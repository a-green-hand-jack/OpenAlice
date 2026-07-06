import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildCliPath, buildSpawnEnv } from './spawn-env.js'

/**
 * Guards the precedence the git-identity injection leans on: per-workspace
 * GIT_* vars are passed as `extras`, and extras must win over anything the
 * parent env leaked (e.g. a host ~/.gitconfig identity exported into the
 * shell). If a refactor stopped letting extras override the parent, workspace
 * commits would silently self-attribute to the host instead.
 */
describe('buildSpawnEnv', () => {
  it('passes extras through and they WIN over a colliding parent var', () => {
    const out = buildSpawnEnv(
      { GIT_AUTHOR_NAME: 'host-user', GIT_AUTHOR_EMAIL: 'host@example.com', KEEP: 'x' },
      { GIT_AUTHOR_NAME: 'Macro Research', GIT_AUTHOR_EMAIL: 'ws-1@workspace.local' },
    )
    // extras shadow the host-leaked identity
    expect(out['GIT_AUTHOR_NAME']).toBe('Macro Research')
    expect(out['GIT_AUTHOR_EMAIL']).toBe('ws-1@workspace.local')
    // non-colliding parent vars survive
    expect(out['KEEP']).toBe('x')
  })

  it('injects all four git identity vars when supplied as extras', () => {
    const out = buildSpawnEnv(
      {},
      {
        GIT_AUTHOR_NAME: 'tag',
        GIT_AUTHOR_EMAIL: 'id@workspace.local',
        GIT_COMMITTER_NAME: 'tag',
        GIT_COMMITTER_EMAIL: 'id@workspace.local',
      },
    )
    expect(out['GIT_AUTHOR_NAME']).toBe('tag')
    expect(out['GIT_COMMITTER_NAME']).toBe('tag')
    expect(out['GIT_AUTHOR_EMAIL']).toBe('id@workspace.local')
    expect(out['GIT_COMMITTER_EMAIL']).toBe('id@workspace.local')
  })

  it('overrides PWD to the spawn cwd when given', () => {
    const out = buildSpawnEnv({ PWD: '/somewhere/else' }, {}, '/ws/dir')
    expect(out['PWD']).toBe('/ws/dir')
  })

  it('strips launcher-owned tool/MCP env from the parent and only trusts extras', () => {
    const out = buildSpawnEnv(
      {
        OPENALICE_MCP_URL: 'http://stale/mcp',
        OPENALICE_TOOL_URL: 'http://stale/cli',
        OPENALICE_TOOL_SOCKET: '/tmp/stale.sock',
        OPENCODE_CONFIG_CONTENT: '{"mcp":{"stale":true}}',
      },
      {
        OPENALICE_TOOL_URL: '/cli',
        OPENALICE_TOOL_SOCKET: '/tmp/current.sock',
      },
    )
    expect(out['OPENALICE_MCP_URL']).toBeUndefined()
    expect(out['OPENCODE_CONFIG_CONTENT']).toBeUndefined()
    expect(out['OPENALICE_TOOL_URL']).toBe('/cli')
    expect(out['OPENALICE_TOOL_SOCKET']).toBe('/tmp/current.sock')
  })

  it('strips event-ingest secrets and bridge URL from the parent env', () => {
    const previous = {
      internal: process.env['OPENALICE_INTERNAL_EVENT_TOKEN'],
      ingest: process.env['OPENALICE_EVENT_INGEST_TOKEN'],
      url: process.env['OPENALICE_EVENT_INGEST_URL'],
      utaInternal: process.env['OPENALICE_UTA_INTERNAL_TOKEN'],
      utaUrl: process.env['OPENALICE_UTA_URL'],
    }
    try {
      process.env['OPENALICE_INTERNAL_EVENT_TOKEN'] = 'internal-secret'
      process.env['OPENALICE_EVENT_INGEST_TOKEN'] = 'uta-secret'
      process.env['OPENALICE_EVENT_INGEST_URL'] = 'http://127.0.0.1:47331/api/events/ingest'
      process.env['OPENALICE_UTA_INTERNAL_TOKEN'] = 'uta-internal-secret'
      process.env['OPENALICE_UTA_URL'] = 'http://127.0.0.1:47333'

      const out = buildSpawnEnv(process.env, { KEEP: 'safe' })

      expect(out['OPENALICE_INTERNAL_EVENT_TOKEN']).toBeUndefined()
      expect(out['OPENALICE_EVENT_INGEST_TOKEN']).toBeUndefined()
      expect(out['OPENALICE_EVENT_INGEST_URL']).toBeUndefined()
      expect(out['OPENALICE_UTA_INTERNAL_TOKEN']).toBeUndefined()
      expect(out['OPENALICE_UTA_URL']).toBeUndefined()
      expect(out['KEEP']).toBe('safe')
    } finally {
      if (previous.internal === undefined) delete process.env['OPENALICE_INTERNAL_EVENT_TOKEN']
      else process.env['OPENALICE_INTERNAL_EVENT_TOKEN'] = previous.internal
      if (previous.ingest === undefined) delete process.env['OPENALICE_EVENT_INGEST_TOKEN']
      else process.env['OPENALICE_EVENT_INGEST_TOKEN'] = previous.ingest
      if (previous.url === undefined) delete process.env['OPENALICE_EVENT_INGEST_URL']
      else process.env['OPENALICE_EVENT_INGEST_URL'] = previous.url
      if (previous.utaInternal === undefined) delete process.env['OPENALICE_UTA_INTERNAL_TOKEN']
      else process.env['OPENALICE_UTA_INTERNAL_TOKEN'] = previous.utaInternal
      if (previous.utaUrl === undefined) delete process.env['OPENALICE_UTA_URL']
      else process.env['OPENALICE_UTA_URL'] = previous.utaUrl
    }
  })

  it('defaults terminal locale to UTF-8 without overriding explicit locale', () => {
    expect(buildSpawnEnv({})['LANG']).toBe('en_US.UTF-8')
    expect(buildSpawnEnv({})['LC_CTYPE']).toBe('en_US.UTF-8')

    const explicit = buildSpawnEnv({ LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' })
    expect(explicit['LANG']).toBe('zh_CN.UTF-8')
    expect(explicit['LC_CTYPE']).toBe('zh_CN.UTF-8')

    const lcAll = buildSpawnEnv({ LC_ALL: 'C.UTF-8' })
    expect(lcAll['LC_CTYPE']).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('adds common user CLI bins missing from GUI app PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'openalice-home-'))
    try {
      const localBin = join(home, '.local/bin')
      const pnpmHome = join(home, 'Library/pnpm')
      mkdirSync(localBin, { recursive: true })
      mkdirSync(pnpmHome, { recursive: true })

      const path = buildCliPath({ HOME: home, PATH: '/usr/bin:/bin' })
        .split(delimiter)

      expect(path).toContain(localBin)
      expect(path).toContain(pnpmHome)
      expect(path).toContain('/usr/bin')
      expect(path).toContain('/bin')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('honors OPENALICE_EXTRA_AGENT_PATH for custom CLI installs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openalice-agent-bin-'))
    try {
      const path = buildCliPath({
        HOME: tmpdir(),
        PATH: '/usr/bin:/bin',
        OPENALICE_EXTRA_AGENT_PATH: dir,
      }).split(delimiter)

      expect(path[0]).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('augments an explicit PATH override from spawn extras', () => {
    const home = mkdtempSync(join(tmpdir(), 'openalice-home-'))
    try {
      const localBin = join(home, '.local/bin')
      mkdirSync(localBin, { recursive: true })

      const out = buildSpawnEnv(
        { HOME: home, PATH: '/usr/bin:/bin' },
        { PATH: '/app/cli-bin:/usr/bin:/bin' },
      )
      const path = out['PATH'].split(delimiter)

      expect(path).toContain('/app/cli-bin')
      expect(path).toContain(localBin)
      expect(path).toContain('/usr/bin')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
