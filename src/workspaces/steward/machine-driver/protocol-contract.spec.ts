import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_CODEX_VERSION } from './codex-app-server-driver.js';

/**
 * Contract-drift guard: the driver hard-codes a handful of JSON-RPC method
 * strings. If a `codex app-server` upgrade renames or drops one, re-capturing
 * the schema snapshot (`fixtures/schema/`) makes these assertions fail loudly
 * instead of the driver silently hanging on a method the server no longer knows.
 */

const SCHEMA_DIR = fileURLToPath(new URL('./fixtures/schema/', import.meta.url));

function methodEnums(file: string): Set<string> {
  const doc = JSON.parse(readFileSync(SCHEMA_DIR + file, 'utf8')) as {
    oneOf?: Array<{ properties?: { method?: { enum?: string[] } } }>;
  };
  const methods = new Set<string>();
  for (const variant of doc.oneOf ?? []) {
    for (const method of variant.properties?.method?.enum ?? []) methods.add(method);
  }
  return methods;
}

describe('codex app-server protocol contract', () => {
  it('exposes every client request method the driver issues', () => {
    const clientRequests = methodEnums('ClientRequest.json');
    for (const method of ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) {
      expect(clientRequests, `ClientRequest is missing ${method}`).toContain(method);
    }
  });

  it('exposes the `initialized` client notification the driver sends', () => {
    expect(methodEnums('ClientNotification.json')).toContain('initialized');
  });

  it('exposes every server notification the driver listens for', () => {
    const serverNotifications = methodEnums('ServerNotification.json');
    for (const method of [
      'turn/started',
      'turn/completed',
      'thread/tokenUsage/updated',
      'item/completed',
      'error',
    ]) {
      expect(serverNotifications, `ServerNotification is missing ${method}`).toContain(method);
    }
  });

  it('pins the schema snapshot to SUPPORTED_CODEX_VERSION', () => {
    const firstLine = readFileSync(SCHEMA_DIR + 'VERSION', 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe(`codex-cli ${SUPPORTED_CODEX_VERSION}`);
  });
});
