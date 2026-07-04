/**
 * ANATOMY citation drift checker.
 *
 * Citation rule:
 * - Matches repo-relative file citations of the form `path/to/file.ext:N` or
 *   `path/to/file.ext:N-M`.
 * - The path token must contain at least one `/`, use plain path characters
 *   (`A-Z a-z 0-9 _ . - /`), and end in a filename with an extension.
 * - A non-path boundary is required before the token and a non-path/line
 *   boundary after it. This intentionally avoids URLs such as
 *   `https://host/path/file.ts:12` and non-path lookalikes such as
 *   `127.0.0.1:47331`.
 * - Paths are resolved relative to the repository root being checked, not
 *   relative to the ANATOMY.md file that mentions them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.worktrees',
  'dist',
  '.git',
  // Fork-workflow worktree sandboxes (CLAUDE.md § Fork mode) — may contain
  // nested workspace checkouts with their own ANATOMY.md files.
  '.sandbox-home',
  '.sandbox-ws',
])

const CITATION_RE =
  /(^|[^A-Za-z0-9_./:@-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?=$|[^A-Za-z0-9_/:-])/g

export interface AnatomyCitation {
  anatomyFile: string
  citedPath: string
  range: string
  startLine: number
  endLine: number
}

export interface BrokenAnatomyCitation {
  anatomyFile: string
  citedPath: string
  range: string
  reason: string
}

export interface AnatomyDriftResult {
  root: string
  anatomyFiles: string[]
  citationCount: number
  broken: BrokenAnatomyCitation[]
}

export function findAnatomyFiles(root: string): string[] {
  const absRoot = resolve(root)
  const found: string[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile() && entry.name === 'ANATOMY.md') {
        found.push(join(dir, entry.name))
      }
    }
  }

  walk(absRoot)
  return found.sort()
}

export function extractCitations(markdown: string, anatomyFile: string): AnatomyCitation[] {
  const citations: AnatomyCitation[] = []

  for (const match of markdown.matchAll(CITATION_RE)) {
    const citedPath = match[2]
    const startLine = Number(match[3])
    const endLine = match[4] ? Number(match[4]) : startLine
    citations.push({
      anatomyFile,
      citedPath,
      range: match[4] ? `${match[3]}-${match[4]}` : match[3],
      startLine,
      endLine,
    })
  }

  return citations
}

export function checkAnatomyDrift(root = process.cwd()): AnatomyDriftResult {
  const absRoot = resolve(root)
  const anatomyFiles = findAnatomyFiles(absRoot)
  const broken: BrokenAnatomyCitation[] = []
  let citationCount = 0

  for (const anatomyPath of anatomyFiles) {
    const anatomyRel = toPosix(relative(absRoot, anatomyPath))
    const markdown = readFileSync(anatomyPath, 'utf-8')
    const citations = extractCitations(markdown, anatomyRel)
    citationCount += citations.length

    for (const citation of citations) {
      const citedAbs = resolve(absRoot, citation.citedPath)
      const citedRel = toPosix(relative(absRoot, citedAbs))

      if (citedRel.startsWith('..') || citedRel === '' || citedAbs === absRoot) {
        broken.push({ ...citation, reason: 'citation escapes repository root' })
        continue
      }

      if (!existsSync(citedAbs)) {
        broken.push({ ...citation, reason: 'file does not exist' })
        continue
      }

      if (!statSync(citedAbs).isFile()) {
        broken.push({ ...citation, reason: 'path is not a file' })
        continue
      }

      if (citation.startLine < 1 || citation.endLine < citation.startLine) {
        broken.push({ ...citation, reason: 'invalid line range' })
        continue
      }

      const lineCount = countLines(readFileSync(citedAbs, 'utf-8'))
      if (citation.endLine > lineCount) {
        broken.push({
          ...citation,
          reason: `line range exceeds file length (${lineCount} lines)`,
        })
      }
    }
  }

  return {
    root: absRoot,
    anatomyFiles: anatomyFiles.map((file) => toPosix(relative(absRoot, file))),
    citationCount,
    broken,
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const withoutFinalTerminator = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized
  return withoutFinalTerminator.split('\n').length
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

function formatBroken(broken: BrokenAnatomyCitation): string {
  return `${broken.anatomyFile} -> ${broken.citedPath}:${broken.range} (${broken.reason})`
}

function runCli(): void {
  // Without --check, broken citations are reported but the exit code stays 0
  // (informational mode). Every gating call site (CI, PR template, ANATOMY.md
  // Drift Rule) must pass --check.
  const checkMode = process.argv.includes('--check')
  const result = checkAnatomyDrift()

  if (result.broken.length === 0) {
    console.log(
      `anatomy drift check: OK (${result.anatomyFiles.length} ANATOMY.md files, ${result.citationCount} citations)`,
    )
    return
  }

  console.error(
    `anatomy drift check: FAILED (${result.broken.length} broken of ${result.citationCount} citations)`,
  )
  for (const broken of result.broken) {
    console.error(formatBroken(broken))
  }

  if (checkMode) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli()
}
