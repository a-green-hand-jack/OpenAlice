import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInboxStore,
  createMemoryInboxStore,
  type IInboxStore,
  type InboxEntry,
} from './inbox-store.js'

describe('InboxStore (in-memory)', () => {
  let store: IInboxStore

  beforeEach(() => {
    store = createMemoryInboxStore()
  })

  it('append with comments only succeeds', async () => {
    const before = Date.now()
    const entry = await store.append({
      workspaceId: 'ws-1',
      workspaceLabel: 'chat-with-kimi',
      comments: 'hey, can you check the SPY chart?',
      kind: 'question',
    })
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry.workspaceId).toBe('ws-1')
    expect(entry.comments).toBe('hey, can you check the SPY chart?')
    expect(entry.docs).toBeUndefined()
    expect(entry.ts).toBeGreaterThanOrEqual(before)
  })

  it('append with docs only succeeds', async () => {
    const entry = await store.append({
      workspaceId: 'ws-1',
      docs: [{ path: 'research/macro-2026-05-14.md' }],
      kind: 'done',
    })
    expect(entry.docs).toEqual([{ path: 'research/macro-2026-05-14.md' }])
    expect(entry.comments).toBeUndefined()
  })

  it('append with both docs and comments succeeds', async () => {
    const entry = await store.append({
      workspaceId: 'ws-1',
      docs: [{ path: 'a.md' }, { path: 'b.md' }],
      comments: 'two reports, b is more interesting',
    })
    expect(entry.docs).toHaveLength(2)
    expect(entry.comments).toContain('two reports')
  })

  it('append rejects missing workspaceId', async () => {
    await expect(
      // @ts-expect-error — exercising runtime guard
      store.append({ comments: 'orphan' }),
    ).rejects.toThrow(/workspaceId is required/)
  })

  it('append rejects when both docs and comments are empty', async () => {
    await expect(
      store.append({ workspaceId: 'ws-1' }),
    ).rejects.toThrow(/at least one of docs or comments/)
    await expect(
      store.append({ workspaceId: 'ws-1', docs: [], comments: '   ' }),
    ).rejects.toThrow(/at least one of docs or comments/)
  })

  it('append rejects malformed doc entries', async () => {
    await expect(
      store.append({ workspaceId: 'ws-1', docs: [{ path: '' }] }),
    ).rejects.toThrow(/non-empty `path`/)
  })

  it('read returns entries newest-first', async () => {
    await store.append({ workspaceId: 'ws-1', comments: 'first' })
    await store.append({ workspaceId: 'ws-1', comments: 'second' })
    await store.append({ workspaceId: 'ws-1', comments: 'third' })
    const { entries, hasMore } = await store.read()
    expect(entries.map((e) => e.comments)).toEqual(['third', 'second', 'first'])
    expect(hasMore).toBe(false)
  })

  it('read respects limit and reports hasMore', async () => {
    for (let i = 0; i < 5; i++) await store.append({ workspaceId: 'ws-1', comments: `n${i}` })
    const { entries, hasMore } = await store.read({ limit: 3 })
    expect(entries.map((e) => e.comments)).toEqual(['n4', 'n3', 'n2'])
    expect(hasMore).toBe(true)
  })

  it('read filters by workspaceId', async () => {
    await store.append({ workspaceId: 'ws-a', comments: 'a1' })
    await store.append({ workspaceId: 'ws-b', comments: 'b1' })
    await store.append({ workspaceId: 'ws-a', comments: 'a2' })
    const { entries } = await store.read({ workspaceId: 'ws-a' })
    expect(entries.map((e) => e.comments)).toEqual(['a2', 'a1'])
  })

  it('read uses `before` cursor to paginate older', async () => {
    const e1 = await store.append({ workspaceId: 'ws-1', comments: 'first' })
    const e2 = await store.append({ workspaceId: 'ws-1', comments: 'second' })
    const e3 = await store.append({ workspaceId: 'ws-1', comments: 'third' })
    const { entries } = await store.read({ before: e3.id, limit: 100 })
    expect(entries.map((e) => e.id)).toEqual([e2.id, e1.id])
  })

  it('onAppended fires on append, dispose stops further notifications', async () => {
    const seen: InboxEntry[] = []
    const dispose = store.onAppended((e) => seen.push(e))
    await store.append({ workspaceId: 'ws-1', comments: 'a' })
    await store.append({ workspaceId: 'ws-1', comments: 'b' })
    expect(seen).toHaveLength(2)
    dispose()
    await store.append({ workspaceId: 'ws-1', comments: 'c' })
    expect(seen).toHaveLength(2)
  })
})

describe('InboxStore (JSONL persistence)', () => {
  let dir: string
  let path: string
  let store: IInboxStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-inbox-'))
    path = join(dir, 'entries.jsonl')
    store = createInboxStore({ filePath: path })
  })

  it('persists across new store instances on the same file', async () => {
    await store.append({
      workspaceId: 'ws-1',
      docs: [{ path: 'report.md' }],
      comments: 'final draft',
      kind: 'done',
    })
    const fresh = createInboxStore({ filePath: path })
    const { entries } = await fresh.read()
    expect(entries).toHaveLength(1)
    expect(entries[0].docs).toEqual([{ path: 'report.md' }])
    expect(entries[0].comments).toBe('final draft')
    expect(entries[0].kind).toBe('done')
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty when file does not exist', async () => {
    const missing = createInboxStore({ filePath: join(dir, 'absent.jsonl') })
    const { entries, hasMore } = await missing.read()
    expect(entries).toEqual([])
    expect(hasMore).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})
