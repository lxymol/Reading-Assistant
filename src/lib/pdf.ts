import { GlobalWorkerOptions, Util, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { DocumentParagraph, NormalizedRegion } from '../types'
import { analyzePageLayout, stableTextHash, type LayoutWord } from '../services/layoutAnalyzer'

GlobalWorkerOptions.workerSrc = workerUrl
export { stableTextHash }
export type DocumentReference = { page: number; region: NormalizedRegion; text?: string }

export async function loadPdf(url: string): Promise<PDFDocumentProxy> { return getDocument({ url }).promise }

export async function extractPdfParagraphs(pdf: PDFDocumentProxy, projectId: string, fileId: string, onProgress?: (done: number, total: number) => void) {
  const output: DocumentParagraph[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const words: LayoutWord[] = content.items.flatMap((item) => {
      if (!('str' in item) || !item.str.trim()) return []
      const transform = Util.transform(viewport.transform, item.transform)
      const height = Math.max(Math.hypot(transform[2], transform[3]), 'height' in item ? item.height || 1 : 1)
      const width = Math.max(('width' in item ? item.width : 1) * viewport.scale, 1)
      return [{ text: item.str.trim(), left: transform[4], top: transform[5] - height, right: transform[4] + width, bottom: transform[5] + height * .2, baseline: transform[5], height }]
    })
    for (const paragraph of analyzePageLayout(words, viewport.width, viewport.height)) {
      output.push({ id: `${fileId}:p${pageNumber}:${stableTextHash(`${paragraph.textHash}:${paragraph.region.left.toFixed(4)}:${paragraph.region.top.toFixed(4)}`)}`, projectId, fileId, page: pageNumber, ...paragraph, order: output.length })
    }
    page.cleanup(); onProgress?.(pageNumber, pdf.numPages)
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  }
  return output
}

export async function extractPdfText(pdf: PDFDocumentProxy, onProgress?: (done: number, total: number) => void, maximumCharacters = Number.POSITIVE_INFINITY) {
  const paragraphs = await extractPdfParagraphs(pdf, 'temporary', 'temporary', onProgress)
  let used = 0
  return paragraphs.flatMap((paragraph) => {
    const available = maximumCharacters - used
    if (available <= 0) return []
    const text = paragraph.text.slice(0, available); used += text.length
    return [`[第 ${paragraph.page} 页]\n${text}`]
  }).join('\n\n')
}

export async function extractPdfRegionText(pdf: PDFDocumentProxy, pageNumber: number, region: NormalizedRegion) {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const selection = { left: region.left * viewport.width, top: region.top * viewport.height, right: (region.left + region.width) * viewport.width, bottom: (region.top + region.height) * viewport.height }
  const items: Array<{ x: number; y: number; text: string }> = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const transform = Util.transform(viewport.transform, item.transform)
    const height = Math.max(Math.hypot(transform[2], transform[3]), 'height' in item ? item.height || 1 : 1)
    const width = Math.max(('width' in item ? item.width : 1) * viewport.scale, 1)
    const box = { left: transform[4], top: transform[5] - height, right: transform[4] + width, bottom: transform[5] + height * .2 }
    if (box.right >= selection.left && box.left <= selection.right && box.bottom >= selection.top && box.top <= selection.bottom) items.push({ x: transform[4], y: transform[5], text: item.str })
  }
  items.sort((a, b) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x)
  const output: string[] = []
  let lastY: number | null = null
  for (const item of items) {
    if (lastY !== null && Math.abs(item.y - lastY) > 3) output.push('\n')
    else if (output.length && output.at(-1) !== '\n') output.push(' ')
    output.push(item.text); lastY = item.y
  }
  page.cleanup()
  return output.join('').replace(/\s*\n\s*/g, '\n').trim()
}
