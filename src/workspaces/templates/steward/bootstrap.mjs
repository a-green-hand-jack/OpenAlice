/**
 * Bootstrap a Steward workspace: a fresh git repo with durable folders for
 * selector events, decision records, and the steward journal.
 *
 * Context injection (persona + steward instruction + CLI skills) and the
 * initial commit are launcher-owned after this script returns.
 *
 *   argv:  process.argv[2] = tag, process.argv[3] = outDir
 *   env:   AQ_TEMPLATE_ROOT - abs path to this template's root (for README)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { initWorkspaceDir, copyReadme, setupGitExcludes, git } from '../_common.mjs'

const tag = process.argv[2]
const outDir = process.argv[3]
if (!tag || !outDir) {
  console.error('usage: bootstrap.mjs <tag> <outDir>')
  process.exit(1)
}

initWorkspaceDir(outDir)
copyReadme(outDir)

await git(['init', '-q'], outDir)
setupGitExcludes(outDir)

for (const rel of ['.alice/steward/events', 'decisions', 'journal']) {
  const dir = join(outDir, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.gitkeep'), '')
}

console.log(`bootstrapped steward workspace '${tag}' at ${outDir}`)
