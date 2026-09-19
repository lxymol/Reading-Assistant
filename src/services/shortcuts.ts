import type { ShortcutAction, ShortcutSettings } from '../types'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

export const defaultShortcutSettings: ShortcutSettings = { projects: '', tags: '', chat: '', annotation: '' }

const modifierParts = (event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) => [
  event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '',
].filter(Boolean)

export function shortcutFromKeyboardEvent(event: KeyboardEvent | ReactKeyboardEvent) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return ''
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  return [...modifierParts(event), key].join('+')
}

export function shortcutFromMouseEvent(event: MouseEvent | ReactMouseEvent | ReactPointerEvent) {
  const button = event.button === 2 ? 2 : event.button === 1 ? 3 : event.button + 1
  return [...modifierParts(event), `Mouse${button}`].join('+')
}

export function findShortcutAction(settings: ShortcutSettings, shortcut: string): ShortcutAction | null {
  if (!shortcut) return null
  return (Object.keys(settings) as ShortcutAction[]).find((action) => Boolean(settings[action]) && settings[action] === shortcut) || null
}
