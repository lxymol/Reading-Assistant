import type { RuntimeProject, RuntimeProjectFile } from '../types'
import type { ProjectRepository } from './projectRepository'

type ProjectReader = Pick<ProjectRepository, 'get' | 'getSource'>

export const coolProject = (project: RuntimeProject): RuntimeProject => ({
  ...project,
  hydrated: false,
  files: project.files.map((file) => ({ ...file, paragraphs: [], source: undefined, pdf: null, sourceLoaded: false, indexLoaded: false })),
  conversations: project.conversations.map((conversation) => ({ ...conversation, history: [], historyLoaded: false })),
})

export async function hydrateProject(project: RuntimeProject, indexFileId: string | null, repository: ProjectReader, missingMessage: string): Promise<RuntimeProject> {
  const hasRequestedIndexes = indexFileId
    ? project.files.find((file) => file.id === indexFileId)?.indexLoaded !== false
    : project.files.every((file) => file.indexLoaded !== false)
  if (project.hydrated && hasRequestedIndexes) return project
  const stored = await repository.get(project.id, false, indexFileId)
  if (!stored) throw new Error(missingMessage)
  const metadata = { ...stored } as typeof stored & { projectNotes?: string; projectNoteAssets?: Record<string, string> }
  delete metadata.projectNotes
  delete metadata.projectNoteAssets
  const currentFiles = new Map(project.files.map((file) => [file.id, file]))
  const files = stored.files.map((file) => {
    const current = currentFiles.get(file.id)
    if (!current || !project.hydrated) return { ...file, sourceLoaded: false } as RuntimeProjectFile
    const loaded = (file as RuntimeProjectFile).indexLoaded !== false
    if (indexFileId && file.id !== indexFileId) return { ...file, ...current, paragraphs: [], source: undefined, pdf: null, sourceLoaded: false, indexLoaded: false }
    return { ...file, ...current, paragraphs: loaded ? file.paragraphs : current.paragraphs, indexState: loaded ? file.indexState : current.indexState, indexLoaded: loaded || current.indexLoaded !== false }
  })
  return { ...metadata, ...(project.hydrated ? project : {}), isLoose: stored.id === 'raid-loose-files' || stored.isLoose, files, hydrated: true }
}

export async function buildBrowserDocumentContext(project: RuntimeProject, repository: ProjectReader, fileId?: string) {
  const blocks: string[] = []
  let characters = 0
  for (const file of project.files.filter((item) => !fileId || item.id === fileId)) {
    const stored = await repository.get(project.id, false, file.id)
    const loaded = stored?.files.find((item) => item.id === file.id)
    const blob = file.kind === 'text' ? await repository.getSource(project.id, file.id, file.type) : null
    if (blob && blob.size > 1200000) throw new Error('全文超过 API 单次附件预算，请使用 Codex 账户模式或拆分文档；未截断文档内容。')
    const text = blob ? await blob.text() : (loaded?.paragraphs || []).map((paragraph) => `[Page ${paragraph.page}]\n${paragraph.text}`).join('\n\n')
    if (!text.trim()) throw new Error(`文档没有可读文字，需要先提取文字或进行 OCR：${file.name}`)
    const block = `File: ${file.name}\n${text}`
    characters += block.length
    if (characters > 300000) throw new Error('全文超过 API 单次附件预算，请使用 Codex 账户模式或拆分文档；未截断文档内容。')
    blocks.push(block)
  }
  return { context: blocks.join('\n\n'), references: [] }
}
