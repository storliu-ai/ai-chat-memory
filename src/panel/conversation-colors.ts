import type { CSSProperties } from 'react'
import {
  DISPLAY_COLOR_OPTIONS,
  type DisplayColorToken,
} from '../shared/display-colors'

interface ManagerConversationColorProperties {
  '--manager-account-tag-background': string
  '--manager-account-tag-border': string
  '--manager-account-tag-color': string
  '--manager-environment-background': string
  '--manager-environment-border': string
  '--manager-environment-hover-border': string
}

interface ManagerColorSwatchProperties {
  '--display-color-swatch': string
}

function getHue(color: DisplayColorToken): number {
  return DISPLAY_COLOR_OPTIONS.find(({ id }) => id === color)?.hue ?? 0
}

export function getManagerConversationColorStyle(
  accountColor: DisplayColorToken | undefined,
  environmentColor: DisplayColorToken | undefined,
): CSSProperties & Partial<ManagerConversationColorProperties> {
  const style: CSSProperties & Partial<ManagerConversationColorProperties> = {}
  if (accountColor !== undefined) {
    const hue = getHue(accountColor)
    style['--manager-account-tag-background'] = `hsl(${hue} 72% 93%)`
    style['--manager-account-tag-border'] = `hsl(${hue} 46% 82%)`
    style['--manager-account-tag-color'] = `hsl(${hue} 46% 30%)`
  }
  if (environmentColor !== undefined) {
    const hue = getHue(environmentColor)
    style['--manager-environment-background'] = `hsl(${hue} 58% 97%)`
    style['--manager-environment-border'] = `hsl(${hue} 30% 88%)`
    style['--manager-environment-hover-border'] = `hsl(${hue} 42% 76%)`
  }
  return style
}

export function getManagerColorSwatchStyle(
  color: DisplayColorToken,
): CSSProperties & ManagerColorSwatchProperties {
  return {
    '--display-color-swatch': `hsl(${getHue(color)} 62% 62%)`,
  }
}
