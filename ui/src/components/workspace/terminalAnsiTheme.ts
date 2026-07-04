import { terminalThemeProfileForVariant, type TerminalThemeProfile, type TerminalThemeRgb } from './terminalThemeProfile'

/**
 * xterm themes only remap palette colors. TUIs that emit explicit 256-color or
 * truecolor SGR values bypass that palette, so a dark-mode message bubble stays
 * dark inside OpenAlice's light app. This rewriter keeps the byte stream intact
 * in dark mode, and only normalizes color SGRs before writing to xterm in light
 * mode. It is display-only: backend scrollback and stdin remain raw.
 */
export class TerminalOutputThemeRewriter {
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private carry = ''

  reset(): void {
    this.carry = ''
    this.decoder.decode()
  }

  rewrite(data: Uint8Array, profile: TerminalThemeProfile): Uint8Array {
    if (!profile.ansiRewrite.enabled) {
      this.reset()
      return data
    }

    const decoded = this.carry + this.decoder.decode(data, { stream: true })
    const split = splitIncompleteCsi(decoded)
    this.carry = split.carry
    return this.encoder.encode(rewriteSgrForProfile(split.complete, profile))
  }
}

export function rewriteLightSgr(input: string): string {
  return rewriteSgrForProfile(input, terminalThemeProfileForVariant('light'))
}

export function rewriteSgrForProfile(input: string, profile: TerminalThemeProfile): string {
  if (!profile.ansiRewrite.enabled) return input
  return input.replace(/\x1b\[([0-9;:]*)m/g, (_match, rawParams: string) => {
    const separator = rawParams.includes(':') ? ':' : ';'
    const raw = rawParams.length > 0 ? rawParams.split(/[;:]/) : ['0']
    const params = raw.map((value) => (value === '' ? 0 : Number(value)))
    if (params.some((value) => !Number.isFinite(value))) return _match
    return `\x1b[${rewriteSgrParams(params, profile).join(separator)}m`
  })
}

function rewriteSgrParams(params: number[], profile: TerminalThemeProfile): number[] {
  const rewrite = profile.ansiRewrite
  if (!rewrite.enabled) return params
  const out: number[] = []
  for (let i = 0; i < params.length; i += 1) {
    const code = params[i] ?? 0

    if (code === 38 || code === 48) {
      const mode = params[i + 1]
      const isForeground = code === 38
      if (mode === 5 && params[i + 2] !== undefined) {
        const rgb = ansi256ToRgb(params[i + 2]!)
        if (rgb) {
          if (isForeground && luminance(rgb) > rewrite.brightForegroundMinLuma) {
            out.push(38, 2, ...darkenForLightForeground(rgb, rewrite.targetForegroundLuma, rewrite.textForeground))
          } else if (!isForeground && luminance(rgb) < rewrite.darkBackgroundMaxLuma) {
            out.push(48, 2, ...rewrite.panelBackground)
          } else {
            out.push(code, 5, params[i + 2]!)
          }
          i += 2
          continue
        }
      }
      if (mode === 2 && params[i + 2] !== undefined && params[i + 3] !== undefined && params[i + 4] !== undefined) {
        const rgb = clampRgb([params[i + 2]!, params[i + 3]!, params[i + 4]!])
        if (isForeground && luminance(rgb) > rewrite.brightForegroundMinLuma) {
          out.push(38, 2, ...darkenForLightForeground(rgb, rewrite.targetForegroundLuma, rewrite.textForeground))
        } else if (!isForeground && luminance(rgb) < rewrite.darkBackgroundMaxLuma) {
          out.push(48, 2, ...rewrite.panelBackground)
        } else {
          out.push(code, 2, ...rgb)
        }
        i += 4
        continue
      }
    }

    if (code === 37 || code === 97) {
      out.push(38, 2, ...rewrite.textForeground)
    } else if (code === 40 || code === 100) {
      out.push(48, 2, ...rewrite.panelBackground)
    } else {
      out.push(code)
    }
  }
  return out.length > 0 ? out : [0]
}

function splitIncompleteCsi(input: string): { complete: string; carry: string } {
  const start = input.lastIndexOf('\x1b[')
  if (start < 0) return { complete: input, carry: '' }
  const tail = input.slice(start)
  if (/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/.test(tail)) {
    return { complete: input, carry: '' }
  }
  return { complete: input.slice(0, start), carry: tail }
}

function ansi256ToRgb(index: number): TerminalThemeRgb | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  const base: Array<readonly [number, number, number]> = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [192, 192, 192],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ]
  if (index < 16) return base[index]!
  if (index >= 232) {
    const value = 8 + (index - 232) * 10
    return [value, value, value]
  }
  const n = index - 16
  const scale = [0, 95, 135, 175, 215, 255]
  return [
    scale[Math.floor(n / 36)]!,
    scale[Math.floor((n % 36) / 6)]!,
    scale[n % 6]!,
  ]
}

function luminance(rgb: readonly [number, number, number]): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

function darkenForLightForeground(
  rgb: TerminalThemeRgb,
  targetLuma: number,
  fallback: TerminalThemeRgb,
): TerminalThemeRgb {
  const luma = luminance(rgb)
  if (luma <= 0) return fallback
  const factor = Math.min(0.62, targetLuma / luma)
  return clampRgb([rgb[0] * factor, rgb[1] * factor, rgb[2] * factor])
}

function clampRgb(rgb: readonly [number, number, number]): TerminalThemeRgb {
  return rgb.map((value) => Math.max(0, Math.min(255, Math.round(value)))) as [number, number, number]
}
