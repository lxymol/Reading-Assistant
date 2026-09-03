import type { ChatReference } from '../types'

const citationPattern = /\\?\[\\?\[\s*(?:REF\s*:\s*\d+(?:\s*\|\s*PAGE\s*:\s*\d+)?(?:\s*\|\s*RECT\s*:[^\]\r\n]+)?|PAGE\s*:\s*\d+|SOURCE\s*:\s*\d+\s*\|[^\]\r\n]*)\s*\\?\]\\?\]/gi

export function inlineCitationsToMarkdown(content: string, references: ChatReference[] = []) {
  const available = new Set(references.map((reference) => reference.number))
  return content.replace(citationPattern, (tag) => {
    const number = Number(tag.match(/REF\s*:\s*(\d+)/i)?.[1])
    return available.has(number) ? `[${number}](#raid-reference-${number})` : ''
  })
}

export function referenceNumberFromHref(href: string | null | undefined) {
  const match = String(href || '').match(/^#raid-reference-(\d+)$/)
  return match ? Number(match[1]) : null
}
