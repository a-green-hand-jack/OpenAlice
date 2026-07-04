import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkAnatomyDrift } from '../../tools/check-anatomy-drift.js'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openalice-anatomy-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('checkAnatomyDrift', () => {
  it('passes for a clean fixture', async () => {
    const root = await fixture()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), 'one\ntwo\nthree\n')
    await writeFile(join(root, 'ANATOMY.md'), 'See src/main.ts:2 and src/main.ts:1-3.\n')

    const result = checkAnatomyDrift(root)

    expect(result.broken).toEqual([])
    expect(result.citationCount).toBe(2)
  })

  it('reports missing cited files', async () => {
    const root = await fixture()
    await writeFile(join(root, 'ANATOMY.md'), 'Broken: src/missing.ts:1\n')

    const result = checkAnatomyDrift(root)

    expect(result.broken).toEqual([
      {
        anatomyFile: 'ANATOMY.md',
        citedPath: 'src/missing.ts',
        range: '1',
        startLine: 1,
        endLine: 1,
        reason: 'file does not exist',
      },
    ])
  })

  it('reports out-of-bounds line ranges', async () => {
    const root = await fixture()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), 'one\ntwo\n')
    await writeFile(join(root, 'ANATOMY.md'), 'Broken: src/main.ts:1-3\n')

    const result = checkAnatomyDrift(root)

    expect(result.broken).toEqual([
      {
        anatomyFile: 'ANATOMY.md',
        citedPath: 'src/main.ts',
        range: '1-3',
        startLine: 1,
        endLine: 3,
        reason: 'line range exceeds file length (2 lines)',
      },
    ])
  })

  it('ignores URL and port-number lookalikes', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'ANATOMY.md'),
      [
        'Not a citation: https://example.com/path/file.ts:123',
        'Not a citation: http://127.0.0.1:47331/mcp',
        'Not a citation: 127.0.0.1:47331',
        '',
      ].join('\n'),
    )

    const result = checkAnatomyDrift(root)

    expect(result.broken).toEqual([])
    expect(result.citationCount).toBe(0)
  })
})
