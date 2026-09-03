import type { ChatReference, DocumentParagraph, RuntimeProject } from '../types'

export type RetrievalHit = { paragraph: DocumentParagraph; fileName: string; score: number }

export function createReferences(project: RuntimeProject, hits: RetrievalHit[], limit = 24): ChatReference[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    if (seen.has(hit.paragraph.id)) return false
    seen.add(hit.paragraph.id)
    return true
  }).slice(0, limit).map((hit, index) => ({
    id: crypto.randomUUID(), number: index + 1, projectId: project.id, fileId: hit.paragraph.fileId,
    fileName: hit.fileName, paragraphId: hit.paragraph.id, page: hit.paragraph.page,
    region: hit.paragraph.region, text: hit.paragraph.text.slice(0, 1400), textHash: hit.paragraph.textHash,
  }))
}

export function validateReference(project: RuntimeProject, reference: ChatReference) {
  const file = project.files.find((item) => item.id === reference.fileId)
  if (!file) return null
  const paragraph = file.paragraphs.find((item) => item.id === reference.paragraphId)
  if (!paragraph || paragraph.textHash !== reference.textHash) return null
  return { file, paragraph }
}

export function createCitationContext(references: ChatReference[]) {
  return references.map((reference) => `[引用编号：${reference.number}｜来源文件：${reference.fileName}｜第 ${reference.page} 页｜段落 ${reference.paragraphId}]\n${reference.text}`).join('\n\n')
}
