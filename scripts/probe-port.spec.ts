import { createServer, type Server } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { probeFreePort } from './probe-port.js'

// High, unlikely-to-collide base; each test offsets to stay independent.
const BASE = 28460

let held: Server[] = []

function hold(port: number, host?: string): Promise<Server> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.once('listening', () => {
      held.push(srv)
      res(srv)
    })
    if (host === undefined) srv.listen(port) // node default — wildcard, dual-stack
    else srv.listen(port, host)
  })
}

afterEach(async () => {
  await Promise.all(held.map((s) => new Promise((r) => s.close(r))))
  held = []
})

describe('probeFreePort', () => {
  it('returns the start port when it is genuinely free', async () => {
    expect(await probeFreePort(BASE)).toBe(BASE)
  })

  it('skips a port held on the loopback address', async () => {
    await hold(BASE + 10, '127.0.0.1')
    expect(await probeFreePort(BASE + 10)).toBe(BASE + 11)
  })

  it('skips a port held by a default (wildcard) listener — the MCP-shaped regression', async () => {
    // This is how `serve({ port })` with no hostname listens. On macOS/BSD a
    // 127.0.0.1-only probe reports this port as free (SO_REUSEADDR lets the
    // specific bind coexist), which handed instance B a port instance A was
    // actively serving on.
    await hold(BASE + 20)
    expect(await probeFreePort(BASE + 20)).toBe(BASE + 21)
  })

  it('skips a port held on the v4 wildcard 0.0.0.0', async () => {
    await hold(BASE + 30, '0.0.0.0')
    expect(await probeFreePort(BASE + 30)).toBe(BASE + 31)
  })

  it('fails loud when the whole window is held', async () => {
    await hold(BASE + 40, '127.0.0.1')
    await hold(BASE + 41, '127.0.0.1')
    await expect(probeFreePort(BASE + 40, BASE + 41)).rejects.toThrow(/no free port/)
  })
})
