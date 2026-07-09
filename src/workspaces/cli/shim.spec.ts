import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)

/**
 * The CLI shim is ONE file shipped under each export name as a byte-identical
 * copy (it self-detects which export it is via argv[0]). Guard the copies
 * against drift — if they diverge, one binary would lag behind a shim fix.
 * Add a new copy here whenever a new `alice-*` export ships.
 */
const EXPORT_BINARIES = ['alice', 'alice-workspace', 'traderhub', 'alice-uta']

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`bin/${name}`, import.meta.url)))

describe('CLI shim copies', () => {
  it('every export binary is byte-identical to the canonical `alice` shim', () => {
    const canonical = read('alice')
    for (const name of EXPORT_BINARIES) {
      expect(read(name).equals(canonical), `${name} has drifted from the alice shim`).toBe(true)
    }
  })

  it('the shim self-detects the export (no hardcoded binary name)', () => {
    const src = read('alice').toString('utf8')
    expect(src).toContain('process.argv[1]') // derives BIN from how it was invoked
    expect(src).toContain('exportKey') // routes to the per-export gateway path
  })

  it('stays ESM-safe when Node treats extensionless shims as modules', () => {
    const src = read('alice').toString('utf8')
    expect(src).not.toContain('require(')
    expect(src).toContain("await import('node:http')")
  })

  it('can fetch a manifest over OPENALICE_TOOL_SOCKET when executed as an ES module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-cli-shim-'))
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\openalice-cli-shim-${process.pid}-${Date.now()}`
      : join(dir, 'tools.sock')
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        description: 'test manifest',
        groups: {
          market: {
            search: {
              tool: 'marketSearchForResearch',
              description: 'Search market data',
              inputSchema: { type: 'object', properties: {} },
            },
          },
        },
      }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL('bin/alice', import.meta.url))], {
        env: {
          ...process.env,
          AQ_WS_ID: 'ws1',
          OPENALICE_TOOL_SOCKET: socketPath,
          OPENALICE_TOOL_URL: '/cli',
        },
        timeout: 5_000,
      })
      expect(stdout).toContain('OpenAlice CLI')
      expect(stdout).toContain('market')
      expect(seen).toEqual(['/cli/ws1/data/manifest'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a wrong CLI endpoint instead of throwing on an HTML manifest response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-cli-shim-html-'))
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\openalice-cli-shim-html-${process.pid}-${Date.now()}`
      : join(dir, 'tools.sock')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!DOCTYPE html><html><body>Vite fallback</body></html>')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(execFileAsync(process.execPath, [fileURLToPath(new URL('bin/alice-workspace', import.meta.url)), 'issue', 'list'], {
        env: {
          ...process.env,
          AQ_WS_ID: 'ws1',
          OPENALICE_TOOL_SOCKET: socketPath,
          OPENALICE_TOOL_URL: '/cli',
        },
        timeout: 5_000,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('invalid OpenAlice CLI manifest'),
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Windows has no shebang concept — it resolves executables on PATH by
  // extension (PATHEXT). The extensionless shims trigger a "how do you want to
  // open this file?" association dialog on every invocation. A `.cmd` twin per
  // export fixes it (ANG / issue #364). Each MUST invoke its OWN shim, because
  // the shim self-detects its export from argv[1] — a `.cmd` pointing at the
  // wrong shim would route to the wrong gateway export.
  it('every export ships a Windows `.cmd` twin that runs its own shim', () => {
    for (const name of EXPORT_BINARIES) {
      const cmd = read(`${name}.cmd`).toString('utf8')
      expect(cmd, `${name}.cmd should run node on its sibling shim`)
        .toContain(`@node "%~dp0${name}"`)
      expect(cmd, `${name}.cmd should forward args`).toContain('%*')
    }
  })
})

/**
 * `--json-file <path>` (issue #113): free-text order/commit fields kept
 * tripping Claude Code's own Bash-safety classifier when embedded raw in a
 * `--commitMessage "..."` argv string (e.g. an unescaped `+$543`). The fix
 * lets the agent write those fields into a JSON file via the Write tool and
 * pass only a plain path on the Bash command line instead.
 */
describe('CLI shim --json-file input', () => {
  const MANIFEST = {
    groups: {
      order: {
        place: { tool: 'placeOrder', description: 'place an order', schema: { properties: {} } },
      },
    },
  }

  // Spins up a fake gateway over a unix socket (mirrors the manifest tests
  // above) that records the JSON body of the /invoke POST so assertions can
  // inspect exactly what args the shim sent.
  async function startCaptureServer() {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-cli-shim-jsonfile-'))
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\openalice-cli-shim-jsonfile-${process.pid}-${Date.now()}`
      : join(dir, 'tools.sock')
    let invokeBody: { tool: string; args: Record<string, unknown> } | null = null
    const server = createServer((req, res) => {
      if (req.url && req.url.endsWith('/manifest')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(MANIFEST))
        return
      }
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        invokeBody = JSON.parse(raw)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    return {
      socketPath,
      getInvokeBody: () => invokeBody,
      cleanup: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(dir, { recursive: true, force: true })
      },
    }
  }

  it('reads --json-file and forwards its contents as args, special characters intact, with no jsonFile/json-file key leaking through', async () => {
    const { socketPath, getInvokeBody, cleanup } = await startCaptureServer()
    const dir = await mkdtemp(join(tmpdir(), 'openalice-cli-shim-jsonfile-fixture-'))
    const fixture = join(dir, 'order.json')
    const commitMessage = 'Week 3 observe: trend exhaustion... lock in +$543 gain `with backticks` and "quotes".'
    await writeFile(fixture, JSON.stringify({
      aliceId: 'mock-simulator-bd1b0230|ASSET-A',
      action: 'SELL',
      orderType: 'MKT',
      totalQuantity: '50',
      commitMessage,
    }))
    try {
      await execFileAsync(process.execPath, [
        fileURLToPath(new URL('bin/alice-uta', import.meta.url)),
        'order', 'place', '--json-file', fixture,
      ], {
        env: { ...process.env, AQ_WS_ID: 'ws1', OPENALICE_TOOL_SOCKET: socketPath, OPENALICE_TOOL_URL: '/cli' },
        timeout: 5_000,
      })
      const body = getInvokeBody()
      expect(body?.tool).toBe('placeOrder')
      // Byte-for-byte survival of $, backticks, and quotes through the round trip.
      expect(body?.args.commitMessage).toBe(commitMessage)
      expect(body?.args.aliceId).toBe('mock-simulator-bd1b0230|ASSET-A')
      expect(body?.args.totalQuantity).toBe('50')
      // The flag itself must never reach the gateway under either casing.
      expect(body?.args).not.toHaveProperty('json-file')
      expect(body?.args).not.toHaveProperty('jsonFile')
    } finally {
      await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('merges --json-file with other flags, file content winning on overlapping keys', async () => {
    const { socketPath, getInvokeBody, cleanup } = await startCaptureServer()
    const dir = await mkdtemp(join(tmpdir(), 'openalice-cli-shim-jsonfile-merge-'))
    const fixture = join(dir, 'order.json')
    await writeFile(fixture, JSON.stringify({
      aliceId: 'from-file|ASSET-A', // should win over the --aliceId flag below
      commitMessage: 'from the json file',
    }))
    try {
      await execFileAsync(process.execPath, [
        fileURLToPath(new URL('bin/alice-uta', import.meta.url)),
        'order', 'place',
        '--aliceId', 'from-flag|ASSET-A', // overlapping key — file must win
        '--action', 'SELL', // non-overlapping flag — must survive the merge
        '--json-file', fixture,
      ], {
        env: { ...process.env, AQ_WS_ID: 'ws1', OPENALICE_TOOL_SOCKET: socketPath, OPENALICE_TOOL_URL: '/cli' },
        timeout: 5_000,
      })
      const body = getInvokeBody()
      expect(body?.args.aliceId).toBe('from-file|ASSET-A')
      expect(body?.args.action).toBe('SELL')
      expect(body?.args.commitMessage).toBe('from the json file')
    } finally {
      await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loudly (not silently) when --json-file points at a missing or invalid file', async () => {
    const { socketPath, cleanup } = await startCaptureServer()
    try {
      await expect(execFileAsync(process.execPath, [
        fileURLToPath(new URL('bin/alice-uta', import.meta.url)),
        'order', 'place', '--json-file', '/nonexistent/path/does-not-exist.json',
      ], {
        env: { ...process.env, AQ_WS_ID: 'ws1', OPENALICE_TOOL_SOCKET: socketPath, OPENALICE_TOOL_URL: '/cli' },
        timeout: 5_000,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('cannot read --json-file'),
      })
    } finally {
      await cleanup()
    }
  })
})
