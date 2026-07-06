import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('SettingsPage authz cleanup', () => {
  it('does not render the retired allowAiTrading toggle', async () => {
    const source = await readFile(resolve(process.cwd(), 'ui/src/pages/SettingsPage.tsx'), 'utf8')
    expect(source).not.toContain('allowAiTrading')
    expect(source).not.toContain('AiTradingToggle')
  })
})
