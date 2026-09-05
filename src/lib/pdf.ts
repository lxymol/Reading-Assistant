import { GlobalWorkerOptions, Util, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { DocumentParagraph, NormalizedRegion } from '../types'
import { analyzePageLayout, stableTextHash, type LayoutWord } from '../services/layoutAnalyzer'

GlobalWorkerOptions.workerSrc = workerUrl
export { stableTextHash }
export type DocumentReference = { page: number; region: NormalizedRegion; text?: string }
export type PdfExtractionOptions = { signal?: AbortSignal; priorityPage?: number; batchSize?: number }
const loadingTasks = new WeakMap<PDFDocumentProxy, ReturnType<typeof getDocument>>()

const abortError = () => new DOMException('PDF indexing was cancelled', 'AbortError')
const yieldForReading = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  const finish = () => signal?.aborted ? reject(abortError()) : resolve()
  if ('requestIdleCallback' in globalThis) globalThis.requestIdleCallback(() => finish(), { timeout: 120 })
  else globalThis.setTimeout(finish, 16)
})

const prioritizedPages = (total: number, priorityPage = 1) => {
  const center = Math.max(1, Math.min(total, Math.round(priorityPage)))
  const pages: number[] = [center]
  for (let distance = 1; pages.length < total; distance += 1) {
    if (center + distance <= total) pages.push(center + distance)
    if (center - distance >= 1) pages.push(center - distance)
  }
  return pages
}

export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  const task = getDocument({
    url,
    cMapUrl: '/pdfjs-assets/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
    wasmUrl: '/pdfjs-assets/wasm/',
    useSystemFonts: true,
    enableXfa: false,
    disableAutoFetch: true,
    rangeChunkSize: 262_144,
  })
  const document = await task.promise
  loadingTasks.set(document, task)
  return document
}

export function destroyPdf(document: PDFDocumentProxy) {
  const task = loadingTasks.get(document)
  loadingTasks.delete(document)
  return task ? task.destroy() : document.cleanup()
}

export async function extractPdfParagraphs(pdf: PDFDocumentProxy, projectId: string, fileId: string, onProgress?: (done: number, total: number) => void, options: PdfExtractionOptions = {}) {
  const output: DocumentParagraph[] = []
  const pages = prioritizedPages(pdf.numPages, options.priorityPage)
  const batchSize = Math.max(1, options.batchSize || 4)
  for (let index = 0; index < pages.length; index += 1) {
    if (options.signal?.aborted) throw abortError()
    const pageNumber = pages[index]
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
    page.cleanup(); onProgress?.(index + 1, pdf.numPages)
    if ((index + 1) % batchSize === 0) await yieldForReading(options.signal)
  }
  return output.sort((a, b) => a.page - b.page || a.region.top - b.region.top || a.region.left - b.region.left).map((paragraph, order) => ({ ...paragraph, order }))
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
