import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { DocumentParagraph, IndexState } from '../types'
import { extractPdfParagraphs } from '../lib/pdf'

export const documentIndexVersion = 1

export type DocumentIndex = { paragraphs: DocumentParagraph[]; state: IndexState }

export class DocumentIndexer {
  async indexPdf(pdf: PDFDocumentProxy, projectId: string, fileId: string, onProgress?: (done: number, total: number) => void): Promise<DocumentIndex> {
    try {
      const paragraphs = await extractPdfParagraphs(pdf, projectId, fileId, onProgress)
      return { paragraphs, state: { status: 'ready', version: documentIndexVersion, indexedAt: Date.now() } }
    } catch (error) {
      return { paragraphs: [], state: { status: 'error', version: documentIndexVersion, error: error instanceof Error ? error.message : '索引失败' } }
    }
  }
}

export const documentIndexer = new DocumentIndexer()
