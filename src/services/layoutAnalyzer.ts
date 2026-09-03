import type { NormalizedRegion } from '../types'

export type LayoutWord = { text: string; left: number; top: number; right: number; bottom: number; baseline: number; height: number }
export type LayoutParagraph = { text: string; textHash: string; region: NormalizedRegion }
type TextLine = LayoutWord & { column: number; wide: boolean }

export function stableTextHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(36)
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

function mergeWords(words: LayoutWord[], pageWidth: number) {
  const lines: TextLine[] = []
  for (const word of [...words].sort((a, b) => a.baseline - b.baseline || a.left - b.left)) {
    let line: TextLine | undefined
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index]
      if (Math.abs(candidate.baseline - word.baseline) <= Math.max(2.4, Math.min(candidate.height, word.height) * .45) && word.left - candidate.right <= Math.max(pageWidth * .04, word.height * 2.5)) { line = candidate; break }
    }
    if (!line) { lines.push({ ...word, column: 0, wide: false }); continue }
    line.text += `${word.left - line.right > Math.max(1.5, word.height * .1) ? ' ' : ''}${word.text}`
    line.left = Math.min(line.left, word.left); line.top = Math.min(line.top, word.top)
    line.right = Math.max(line.right, word.right); line.bottom = Math.max(line.bottom, word.bottom); line.height = Math.max(line.height, word.height)
  }
  return lines
}

function assignColumns(lines: TextLine[], pageWidth: number) {
  const body = lines.filter((line) => line.right - line.left < pageWidth * .68)
  const clusters: Array<{ x: number; count: number }> = []
  for (const line of body) {
    const nearest = clusters.map((cluster, index) => ({ index, distance: Math.abs(cluster.x - line.left) })).sort((a, b) => a.distance - b.distance)[0]
    if (!nearest || nearest.distance > pageWidth * .105) clusters.push({ x: line.left, count: 1 })
    else { const cluster = clusters[nearest.index]; cluster.x = (cluster.x * cluster.count + line.left) / (cluster.count + 1); cluster.count += 1 }
  }
  const minimum = Math.max(2, Math.floor(body.length * .045))
  const useful = clusters.filter((cluster) => cluster.count >= minimum)
  const centers = (useful.length ? useful : clusters).sort((a, b) => a.x - b.x).slice(0, 4).map((cluster) => cluster.x)
  for (const line of lines) {
    line.wide = line.right - line.left >= pageWidth * .68
    line.column = line.wide || !centers.length ? -1 : centers.reduce((best, center, index) => Math.abs(center - line.left) < Math.abs(centers[best] - line.left) ? index : best, 0)
  }
}

function mergeParagraphs(lines: TextLine[]) {
  const paragraphs: TextLine[] = []
  const groups = new Map<number, TextLine[]>()
  for (const line of lines) groups.set(line.column, [...(groups.get(line.column) || []), line])
  for (const [column, columnLines] of groups) {
    for (const line of columnLines.sort((a, b) => a.top - b.top || a.left - b.left)) {
      let previous: TextLine | undefined
      for (let index = paragraphs.length - 1; index >= 0; index -= 1) if (paragraphs[index].column === column) { previous = paragraphs[index]; break }
      const gap = previous ? line.top - previous.bottom : Number.POSITIVE_INFINITY
      const aligned = previous && Math.abs(previous.left - line.left) <= Math.max(previous.height * 2.2, .02 * Math.max(previous.right, line.right))
      const close = previous && gap >= -Math.max(previous.height, line.height) * .4 && gap <= Math.max(previous.height, line.height) * 1.05
      if (!previous || column === -1 || !aligned || !close) paragraphs.push({ ...line })
      else {
        previous.text += `${previous.text.endsWith('-') && /^[a-z]/i.test(line.text) ? '' : ' '}${line.text}`
        previous.left = Math.min(previous.left, line.left); previous.top = Math.min(previous.top, line.top)
        previous.right = Math.max(previous.right, line.right); previous.bottom = Math.max(previous.bottom, line.bottom)
        previous.baseline = line.baseline; previous.height = Math.max(previous.height, line.height)
      }
    }
  }
  return paragraphs
}

function readingOrder(paragraphs: TextLine[]) {
  const wide = paragraphs.filter((item) => item.wide).sort((a, b) => a.top - b.top)
  const narrow = paragraphs.filter((item) => !item.wide)
  const ordered: TextLine[] = []
  let boundary = Number.NEGATIVE_INFINITY
  for (const separator of wide) {
    ordered.push(...narrow.filter((item) => item.top >= boundary && item.top < separator.top).sort((a, b) => a.column - b.column || a.top - b.top || a.left - b.left), separator)
    boundary = separator.top
  }
  ordered.push(...narrow.filter((item) => item.top >= boundary).sort((a, b) => a.column - b.column || a.top - b.top || a.left - b.left))
  return ordered
}

export function analyzePageLayout(words: LayoutWord[], pageWidth: number, pageHeight: number): LayoutParagraph[] {
  const lines = mergeWords(words, pageWidth)
  assignColumns(lines, pageWidth)
  return readingOrder(mergeParagraphs(lines)).flatMap((paragraph) => {
    const text = paragraph.text.replace(/\s+/g, ' ').trim()
    if (!text) return []
    return [{ text, textHash: stableTextHash(text), region: { left: clamp(paragraph.left / pageWidth), top: clamp(paragraph.top / pageHeight), width: clamp((paragraph.right - paragraph.left) / pageWidth), height: clamp((paragraph.bottom - paragraph.top) / pageHeight) } }]
  })
}
