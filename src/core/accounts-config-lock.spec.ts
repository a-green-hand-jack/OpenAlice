import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  withAccountsConfigLock,
  type AccountsConfigLockHookContext,
} from './accounts-config-lock.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('accounts config lock', () => {
  it('keeps a successor lock intact when an incomplete creator resumes after stale reclaim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-paused-'))
    tempDirs.push(root)
    const lockPath = join(root, '.accounts.json.lock')
    const creatorCreated = deferred<AccountsConfigLockHookContext>()
    const resumeCreator = deferred<void>()
    const creatorLostOwnership = deferred<void>()
    const successorEntered = deferred<void>()
    const releaseSuccessor = deferred<void>()
    let successorToken = ''
    let active = 0
    let maxActive = 0
    let entries = 0

    const enter = async (hold?: Promise<void>) => {
      active += 1
      entries += 1
      maxActive = Math.max(maxActive, active)
      await hold
      active -= 1
    }

    const creator = withAccountsConfigLock(root, () => enter(), {
      incompleteOwnerTtlMs: 15,
      acquireBackoffMs: 1,
      hooks: {
        afterCanonicalCreate: async (ctx) => {
          creatorCreated.resolve(ctx)
          await resumeCreator.promise
        },
        afterOwnershipLost: () => creatorLostOwnership.resolve(),
      },
    })

    const creatorContext = await creatorCreated.promise
    await sleep(25)

    const successor = withAccountsConfigLock(root, async () => {
      successorEntered.resolve()
      await enter(releaseSuccessor.promise)
    }, {
      incompleteOwnerTtlMs: 15,
      acquireBackoffMs: 1,
      hooks: {
        afterOwnerPublished: (ctx) => { successorToken = ctx.owner.token },
      },
    })

    await successorEntered.promise
    resumeCreator.resolve()
    await creatorLostOwnership.promise

    const canonicalOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string }
    expect(canonicalOwner.token).toBe(successorToken)
    const staleNames = (await readdir(root)).filter((name) => name.startsWith('.accounts.json.lock.stale-'))
    expect(staleNames).toHaveLength(1)
    expect(JSON.parse(await readFile(join(root, staleNames[0]!), 'utf8'))).toMatchObject({
      token: creatorContext.owner.token,
    })

    let thirdEntered = false
    const third = withAccountsConfigLock(root, async () => {
      thirdEntered = true
      await enter()
    }, {
      incompleteOwnerTtlMs: 15,
      acquireBackoffMs: 1,
    })
    await sleep(10)
    expect(thirdEntered).toBe(false)
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { token: string }).token).toBe(successorToken)

    releaseSuccessor.resolve()
    await Promise.all([creator, successor, third])

    expect(entries).toBe(3)
    expect(maxActive).toBe(1)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims an incomplete owner only after its stale threshold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-incomplete-'))
    tempDirs.push(root)
    const lockPath = join(root, '.accounts.json.lock')
    const incomplete = await open(lockPath, 'wx', 0o600)
    await incomplete.close()
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    let entered = false
    await withAccountsConfigLock(root, async () => { entered = true }, {
      incompleteOwnerTtlMs: 10,
      acquireBackoffMs: 1,
    })

    expect(entered).toBe(true)
  })

  it('reclaims a stale previous-generation directory with no published owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-legacy-incomplete-'))
    tempDirs.push(root)
    const lockPath = join(root, '.accounts.json.lock')
    await mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    let entered = false
    await withAccountsConfigLock(root, async () => { entered = true }, {
      incompleteOwnerTtlMs: 10,
      acquireBackoffMs: 1,
    })

    expect(entered).toBe(true)
  })

  it('recognizes a healthy previous-generation directory owner and never reclaims it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-legacy-healthy-'))
    tempDirs.push(root)
    const lockPath = join(root, '.accounts.json.lock')
    await mkdir(lockPath)
    const owner = {
      pid: process.pid,
      hostname: hostname(),
      token: 'legacy-healthy-token',
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }
    await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    await expect(withAccountsConfigLock(root, async () => undefined, {
      incompleteOwnerTtlMs: 1,
      acquireAttempts: 10,
      acquireBackoffMs: 1,
    })).rejects.toThrow(/timed out acquiring accounts config lock/)

    expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toEqual(owner)
  })

  it('never reclaims a healthy published owner even after the incomplete-owner TTL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-healthy-'))
    tempDirs.push(root)
    const firstEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let secondEntered = false
    let active = 0
    let maxActive = 0

    const first = withAccountsConfigLock(root, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      firstEntered.resolve()
      await releaseFirst.promise
      active -= 1
    }, {
      incompleteOwnerTtlMs: 1,
      acquireBackoffMs: 1,
    })
    await firstEntered.promise

    const second = withAccountsConfigLock(root, async () => {
      secondEntered = true
      active += 1
      maxActive = Math.max(maxActive, active)
      active -= 1
    }, {
      incompleteOwnerTtlMs: 1,
      acquireBackoffMs: 1,
    })

    await sleep(20)
    expect(secondEntered).toBe(false)
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(maxActive).toBe(1)
  })

  it('recovers a canonical lock left by a crashed owner process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-crash-'))
    tempDirs.push(root)
    const moduleUrl = pathToFileURL(resolve('src/core/accounts-config-lock.ts')).href
    const program = `
      const { withAccountsConfigLock } = await import(process.argv[1])
      await withAccountsConfigLock(process.argv[2], async () => {
        await new Promise((resolve) => process.stdout.write('LOCKED\\n', resolve))
        process.exit(23)
      })
    `
    const crash = await runCrashHolder([
      '--no-warnings',
      '-e',
      program,
      moduleUrl,
      root,
    ], root)
    expect(crash.code).toBe(23)
    expect(crash.stdout).toContain('LOCKED')

    let recovered = false
    await withAccountsConfigLock(root, async () => { recovered = true }, {
      acquireBackoffMs: 1,
    })
    expect(recovered).toBe(true)
  })

  it('serializes adversarial read-modify-write loops across processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-accounts-lock-xproc-'))
    tempDirs.push(root)
    const counterPath = join(root, 'counter.txt')
    await writeFile(counterPath, '0', 'utf8')

    const moduleUrl = pathToFileURL(resolve('src/core/accounts-config-lock.ts')).href
    const workers = 6
    const iterations = 40
    const program = `
      const { readFile, writeFile } = await import('node:fs/promises')
      const { setTimeout: sleep } = await import('node:timers/promises')
      const { withAccountsConfigLock } = await import(process.argv[1])
      const root = process.argv[2]
      const counterPath = process.argv[3]
      const iterations = Number(process.argv[4])
      for (let index = 0; index < iterations; index++) {
        await withAccountsConfigLock(root, async () => {
          const current = Number(await readFile(counterPath, 'utf8'))
          await sleep(Math.floor(Math.random() * 4))
          await writeFile(counterPath, String(current + 1), 'utf8')
        })
      }
    `

    await Promise.all(Array.from({ length: workers }, (_, index) => runChild([
      '--no-warnings',
      '-e',
      program,
      moduleUrl,
      root,
      counterPath,
      String(iterations),
    ], index, root)))

    expect(Number(await readFile(counterPath, 'utf8'))).toBe(workers * iterations)
  }, 30_000)
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value?: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T) => void
  const promise = new Promise<T>((done) => {
    resolve = (value?: T) => done(value as T)
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function runChild(args: string[], index: number, root: string): Promise<void> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        NODE_OPTIONS: `--localstorage-file=${join(root, `child-${index}.localstorage`)}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', rejectChild)
    child.once('exit', (code) => {
      if (code === 0) resolveChild()
      else rejectChild(new Error(`accounts lock child ${index} exited ${code}: ${stderr}`))
    })
  })
}

function runCrashHolder(
  args: string[],
  root: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        NODE_OPTIONS: `--localstorage-file=${join(root, 'crash-holder.localstorage')}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', rejectChild)
    child.once('exit', (code) => resolveChild({ code, stdout, stderr }))
  })
}
