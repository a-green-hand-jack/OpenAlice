import { describe, expect, it } from 'vitest'

import { TerminalOutputThemeRewriter, rewriteLightSgr } from '../terminalAnsiTheme'
import { terminalThemeProfileForVariant } from '../terminalThemeProfile'

const decoder = new TextDecoder()

describe('terminal ANSI theme rewriting', () => {
  it('maps dark ANSI backgrounds to a light panel color', () => {
    expect(rewriteLightSgr('\x1b[100mhello\x1b[0m')).toBe('\x1b[48;2;244;241;232mhello\x1b[0m')
    expect(rewriteLightSgr('\x1b[40;37mhello\x1b[0m')).toBe(
      '\x1b[48;2;244;241;232;38;2;28;42;65mhello\x1b[0m',
    )
  })

  it('maps dark 256-color and truecolor backgrounds to a light panel color', () => {
    expect(rewriteLightSgr('\x1b[48;5;8mhello\x1b[0m')).toBe('\x1b[48;2;244;241;232mhello\x1b[0m')
    expect(rewriteLightSgr('\x1b[48;2;48;47;61mhello\x1b[0m')).toBe(
      '\x1b[48;2;244;241;232mhello\x1b[0m',
    )
  })

  it('darkens bright explicit foreground colors for light backgrounds', () => {
    expect(rewriteLightSgr('\x1b[38;5;11mwarning\x1b[0m')).toBe('\x1b[38;2;129;129;0mwarning\x1b[0m')
    expect(rewriteLightSgr('\x1b[38;2;255;245;80mwarning\x1b[0m')).toBe(
      '\x1b[38;2;130;125;41mwarning\x1b[0m',
    )
  })

  it('leaves dark mode bytes untouched', () => {
    const data = new TextEncoder().encode('\x1b[100mhello\x1b[0m')
    const out = new TerminalOutputThemeRewriter().rewrite(data, terminalThemeProfileForVariant('dark'))
    expect(out).toBe(data)
  })

  it('carries incomplete SGR sequences across light-mode chunks', () => {
    const rewriter = new TerminalOutputThemeRewriter()
    const profile = terminalThemeProfileForVariant('light')
    const first = rewriter.rewrite(new TextEncoder().encode('\x1b[48;5;'), profile)
    const second = rewriter.rewrite(new TextEncoder().encode('8mhello'), profile)
    expect(decoder.decode(first)).toBe('')
    expect(decoder.decode(second)).toBe('\x1b[48;2;244;241;232mhello')
  })

  it('drops carried SGR state when reset before a profile replay', () => {
    const rewriter = new TerminalOutputThemeRewriter()
    const profile = terminalThemeProfileForVariant('light')
    const first = rewriter.rewrite(new TextEncoder().encode('\x1b[48;5;'), profile)
    rewriter.reset()
    const second = rewriter.rewrite(new TextEncoder().encode('8mhello'), profile)
    expect(decoder.decode(first)).toBe('')
    expect(decoder.decode(second)).toBe('8mhello')
  })
})
