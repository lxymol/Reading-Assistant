import { GlobalWorkerOptions, Util, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export type DocumentReference = { id: number; page: number; region: { left: number; top: number; width: number; height: number }; text: string }

export function findDocumentReference(documentText: string, id: number): DocumentReference | null {
  const pattern = /\[\[REF:(\d+)\|PAGE:(\d+)\|RECT:([\d.]+),([\d.]+),([\d.]+),([\d.]+)\]\]\s*([^\n]*)/g
  for (const match of documentText.matchAll(pattern)) {
    if (Number(match[1]) !== id) continue
    return { id, page: Number(match[2]), region: { left: Number(match[3]), top: Number(match[4]), width: Number(match[5]), height: Number(match[6]) }, text: match[7].trim() }
  }
  return null
}

export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  return getDocument({ url }).promise
}

export async function extractPdfText(pdf: PDFDocumentProxy, onProgress?: (done: number, total: number) => void, maximumCharacters = Number.POSITIVE_INFINITY) {
  const pages: string[] = []
  const pageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1)
  let characters = 0
  let reference = 0
  for (let index = 0; index < pageNumbers.length; index += 1) {
    const pageNumber = pageNumbers[index]
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const words = content.items.flatMap((item) => {
      if (!('str' in item) || !item.str.trim()) return []
      const transform = Util.transform(viewport.transform, item.transform)
      const height = Math.max(Math.hypot(transform[2], transform[3]), item.height || 1)
      return [{ text: item.str.trim(), x: transform[4], y: transform[5], width: Math.max(item.width * viewport.scale, 1), height }]
    })
    const lines: Array<{ text: string; left: number; top: number; right: number; bottom: number; y: number; height: number }> = []
    for (const word of words.sort((a, b) => a.y - b.y || a.x - b.x)) {
      let line: (typeof lines)[number] | undefined
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        if (Math.abs(lines[lineIndex].y - word.y) <= Math.max(2.5, Math.min(lines[lineIndex].height, word.height) * .45)) { line = lines[lineIndex]; break }
        if (word.y - lines[lineIndex].y > word.height * 1.5) break
      }
      if (!line) {
        lines.push({ text: word.text, left: word.x, top: word.y - word.height, right: word.x + word.width, bottom: word.y + word.height * .18, y: word.y, height: word.height })
        continue
      }
      line.text += `${word.x - line.right > Math.max(2, word.height * .12) ? ' ' : ''}${word.text}`
      line.left = Math.min(line.left, word.x); line.right = Math.max(line.right, word.x + word.width)
      line.top = Math.min(line.top, word.y - word.height); line.bottom = Math.max(line.bottom, word.y + word.height * .18)
    }
    const bodyLines = lines.filter((line) => line.right - line.left < viewport.width * .72)
    const starts = bodyLines.map((line) => line.left).sort((a, b) => a - b)
    const columns: Array<{ x: number; count: number }> = []
    for (const start of starts) {
      const nearby = columns.findIndex((column) => Math.abs(column.x - start) < viewport.width * .09)
      if (nearby < 0) columns.push({ x: start, count: 1 })
      else {
        columns[nearby].x = (columns[nearby].x * columns[nearby].count + start) / (columns[nearby].count + 1)
        columns[nearby].count += 1
      }
    }
    const minimumColumnLines = Math.max(2, Math.floor(bodyLines.length * .06))
    const usefulColumns = (columns.filter((column) => column.count >= minimumColumnLines).length ? columns.filter((column) => column.count >= minimumColumnLines) : columns)
      .sort((a, b) => a.x - b.x).slice(0, 4).map((column) => column.x)
    const ordered = lines.slice().sort((a, b) => {
      const wideA = a.right - a.left >= viewport.width * .72
      const wideB = b.right - b.left >= viewport.width * .72
      if (wideA || wideB) return Math.abs(a.y - b.y) > Math.max(a.height, b.height) * 1.5 ? a.y - b.y : a.left - b.left
      const columnA = usefulColumns.reduce((best, value, i) => Math.abs(value - a.left) < Math.abs(usefulColumns[best] - a.left) ? i : best, 0)
      const columnB = usefulColumns.reduce((best, value, i) => Math.abs(value - b.left) < Math.abs(usefulColumns[best] - b.left) ? i : best, 0)
      return columnA === columnB ? a.y - b.y : columnA - columnB
    })
    const paragraphs: typeof lines = []
    for (const line of ordered) {
      const previous = paragraphs.at(-1)
      const sameColumn = previous && Math.abs(previous.left - line.left) < viewport.width * .11
      const close = previous && line.y >= previous.y && line.y - previous.y <= Math.max(previous.height, line.height) * 1.9
      if (!previous || !sameColumn || !close) paragraphs.push({ ...line })
      else {
        previous.text += `${previous.text.endsWith('-') ? '' : ' '}${line.text}`
        previous.left = Math.min(previous.left, line.left); previous.right = Math.max(previous.right, line.right)
        previous.top = Math.min(previous.top, line.top); previous.bottom = Math.max(previous.bottom, line.bottom)
        previous.y = line.y; previous.height = Math.max(previous.height, line.height)
      }
    }
    const rendered: string[] = []
    for (const paragraph of paragraphs) {
      if (characters >= maximumCharacters) break
      const text = paragraph.text.slice(0, Math.max(0, maximumCharacters - characters))
      if (!text) continue
      reference += 1
      const rect = [paragraph.left / viewport.width, paragraph.top / viewport.height, (paragraph.right - paragraph.left) / viewport.width, (paragraph.bottom - paragraph.top) / viewport.height].map((value) => Math.max(0, Math.min(1, value)).toFixed(5)).join(',')
      rendered.push(`[[REF:${reference}|PAGE:${pageNumber}|RECT:${rect}]] ${text}`)
      characters += text.length
    }
    pages.push(`[第 ${pageNumber} 页]\n${rendered.join('\n')}`)
    onProgress?.(index + 1, pageNumbers.length)
    page.cleanup()
    if (characters >= maximumCharacters) break
  }
  return pages.join('\n\n')
}

export async function extractPdfRegionText(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  region: { left: number; top: number; width: number; height: number },
) {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const selection = {
    left: region.left * viewport.width,
    top: region.top * viewport.height,
    right: (region.left + region.width) * viewport.width,
    bottom: (region.top + region.height) * viewport.height,
  }

  const lines: Array<{ x: number; y: number; text: string }> = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const transform = Util.transform(viewport.transform, item.transform)
    const x = transform[4]
    const baseline = transform[5]
    const height = Math.max(Math.hypot(transform[2], transform[3]), item.height || 1)
    const width = Math.max(item.width * viewport.scale, 1)
    const box = { left: x, top: baseline - height, right: x + width, bottom: baseline + height * 0.2 }
    const intersects = box.right >= selection.left && box.left <= selection.right && box.bottom >= selection.top && box.top <= selection.bottom
    if (intersects) lines.push({ x, y: baseline, text: item.str })
  }

  lines.sort((a, b) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x)
  const output: string[] = []
  let lastY: number | null = null
  for (const item of lines) {
    if (lastY !== null && Math.abs(item.y - lastY) > 3) output.push('\n')
    else if (output.length && output.at(-1) !== '\n') output.push(' ')
    output.push(item.text)
    lastY = item.y
  }
  return output.join('').replace(/\s*\n\s*/g, '\n').trim()
}
