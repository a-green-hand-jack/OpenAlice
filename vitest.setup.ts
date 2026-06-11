/**
 * Global test hermeticity: pin OPENALICE_HOME to a per-worker temp dir so
 * module-level `dataPath(...)` constants (session store, auth store, config,
 * event log, …) never resolve into the developer's real data root. Without
 * this, any spec that touches a store would read/write the real
 * `~/.openalice/data` once the default user-data home moves off cwd.
 *
 * Runs before each test file's module graph is imported (vitest setupFiles
 * semantics); the env guard makes it once-per-worker. Specs that need a
 * specific home (paths.spec, global-provider-keys.spec) still override via
 * vi.resetModules() + their own env handling — this is only the fallback.
 *
 * Deliberately NOT wired into vitest.e2e.config.ts: the e2e suite reads real
 * broker credentials from the real store by design.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env['OPENALICE_HOME']) {
  process.env['OPENALICE_HOME'] = mkdtempSync(join(tmpdir(), 'oa-vitest-'))
}
