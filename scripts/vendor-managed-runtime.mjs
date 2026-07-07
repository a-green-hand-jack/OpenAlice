#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')
const vendorRoot = resolve(repoRoot, 'vendor')
const piRoot = resolve(vendorRoot, 'pi')
const manifestPath = resolve(vendorRoot, 'manifest.json')
const piCliPath = resolve(
  piRoot,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'cli.js',
)

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const help = args.has('--help') || args.has('-h')
const knownArgs = new Set(['--force', '--help', '-h'])
const unknownArgs = [...args].filter((arg) => !knownArgs.has(arg))

const PI_VERSION = '0.80.3'
const PI_RELEASE_BASE = `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}`
const PI_ASSETS = [
  {
    name: 'package.json',
    url: `${PI_RELEASE_BASE}/pi-coding-agent-install-package.json`,
    sha256: 'ba96c5a6183936a113a7a48de45fdae8cd4489a22f4cc481fbce74afae85b6c7',
  },
  {
    name: 'package-lock.json',
    url: `${PI_RELEASE_BASE}/pi-coding-agent-install-package-lock.json`,
    sha256: '0d32c0854a23486ee80f7c82b9fad4bb5b03a380c649d5af105ad1a3c88fc54d',
  },
]

function printHelp() {
  console.log(`Usage: pnpm vendor:runtime [options]

Prepare managed workspace runtimes under vendor/.

Options:
  --force    Remove and reinstall vendor/pi even if it already matches
  -h, --help Show this help
`)
}

if (help) {
  printHelp()
  process.exit(0)
}

if (unknownArgs.length > 0) {
  console.error(`[vendor-runtime] unknown option(s): ${unknownArgs.join(', ')}`)
  printHelp()
  process.exit(1)
}

async function main() {
  await mkdir(vendorRoot, { recursive: true })
  await vendorPi()
  await writeManifest()
}

async function vendorPi() {
  const existingManifest = readManifest()
  if (
    !force &&
    existingManifest?.pi?.version === PI_VERSION &&
    existingManifest?.pi?.mode === 'npm' &&
    existsSync(piCliPath)
  ) {
    console.log(`[vendor-runtime] Pi ${PI_VERSION} already present at ${relativeForLog(piCliPath)}`)
    return
  }

  console.log(`[vendor-runtime] preparing Pi ${PI_VERSION} npm runtime`)
  await rm(piRoot, { recursive: true, force: true })
  await mkdir(piRoot, { recursive: true })

  for (const asset of PI_ASSETS) {
    const bytes = await download(asset.url)
    verifySha256(bytes, asset.sha256, asset.url)
    await writeFile(resolve(piRoot, asset.name), bytes)
  }

  run('npm ci for managed Pi', 'npm', [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
  ], { cwd: piRoot, shell: process.platform === 'win32' })

  if (!existsSync(piCliPath)) {
    throw new Error(`managed Pi CLI missing after npm ci: ${piCliPath}`)
  }
  console.log(`[vendor-runtime] Pi CLI -> ${relativeForLog(piCliPath)}`)
}

async function download(url) {
  console.log(`[vendor-runtime] download ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function verifySha256(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(`${label} sha256 mismatch: expected ${expected}, got ${actual}`)
  }
}

function run(label, command, commandArgs, opts = {}) {
  console.log(`\n[vendor-runtime] ${label}`)
  const result = spawnSync(command, commandArgs, {
    cwd: opts.cwd ?? repoRoot,
    stdio: 'inherit',
    env: process.env,
    shell: opts.shell ?? false,
  })
  if (result.error) {
    console.error(`[vendor-runtime] failed to start ${command}: ${result.error.message}`)
  }
  if (result.status !== 0 || result.error) process.exit(result.status ?? 1)
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

async function writeManifest() {
  const manifest = {
    pi: {
      version: PI_VERSION,
      mode: 'npm',
      root: 'vendor/pi',
      cli: relativeForManifest(piCliPath),
      node: 'electron',
    },
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[vendor-runtime] manifest -> ${relativeForLog(manifestPath)}`)
}

function relativeForManifest(path) {
  return relative(repoRoot, path).replaceAll('\\', '/')
}

function relativeForLog(path) {
  return relative(repoRoot, path)
}

main().catch((err) => {
  console.error(`[vendor-runtime] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
