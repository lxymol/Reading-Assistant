import type { Project, ProjectSummary, RuntimeProject, RuntimeProjectFile } from '../types'
import { retrievalService } from './retrievalService'
import { createIndexedDatabase } from './indexedDatabase.js'
import { ProjectWriter } from './projectWriter.js'

const databaseName = 'raid-projects-v2'
const projectStore = 'projects'
const sourceStore = 'sources'

const persistedProject = (project: RuntimeProject | Project): Project => {
  const { files, ...metadata } = project as (RuntimeProject | Project) & { projectNotes?: string; projectNoteAssets?: Record<string, string> }
  delete metadata.projectNotes; delete metadata.projectNoteAssets
  return {
    ...metadata,
    files: files.map((file) => {
      const value = { ...file } as RuntimeProjectFile
      delete value.source; delete value.pdf; delete value.sourceLoaded
      return value
    }),
  }
}

const database = createIndexedDatabase(databaseName, { [projectStore]: { keyPath: 'id' }, [sourceStore]: undefined })
const idbRequest = database.request

const sourceKey = (projectId: string, fileId: string) => `${projectId}:${fileId}`

export class ProjectRepository {
  private desktopWriter = new ProjectWriter((project) => window.readingAssistant!.saveProject(project))
  private writeListeners = new Set<(projectId: string) => void>()

  onWrite(listener: (projectId: string) => void) {
    this.writeListeners.add(listener)
    return () => { this.writeListeners.delete(listener) }
  }

  async list(): Promise<ProjectSummary[]> {
    if (window.readingAssistant) {
      await this.desktopWriter.flush()
      return window.readingAssistant.listProjects()
    }
    return database.transaction<ProjectSummary[]>(projectStore, 'readonly', (transaction, result) => {
      const summaries: ProjectSummary[] = []
      const cursor = transaction.objectStore(projectStore).openCursor()
      cursor.onsuccess = () => {
        if (!cursor.result) { result(summaries.sort((a, b) => b.updatedAt - a.updatedAt)); return }
        const project = cursor.result.value as Project
        summaries.push({ id: project.id, name: project.name, fileCount: project.files.length, conversationCount: project.conversations.length, updatedAt: project.updatedAt, activeFileId: project.activeFileId })
        cursor.result.continue()
      }
    })
  }

  async get(id: string, lightweight = false, indexFileId: string | null = null): Promise<Project | null> {
    if (window.readingAssistant) {
      await this.desktopWriter.flush(id)
      return window.readingAssistant.getProject(id, lightweight, indexFileId)
    }
    const project = await idbRequest<Project | undefined>(projectStore, 'readonly', (store) => store.get(id))
    if (!project) return null
    return { ...project, files: project.files.map((file) => ({ ...file, paragraphs: !lightweight && (!indexFileId || file.id === indexFileId) ? file.paragraphs : [], indexLoaded: !lightweight && (!indexFileId || file.id === indexFileId) })), ...(lightweight ? { conversations: project.conversations.map((conversation) => ({ ...conversation, history: [], historyLoaded: false })) } : {}) }
  }

  async retrieveContext(id: string, query: string, options: { maxCharacters?: number; maxHits?: number }) {
    if (window.readingAssistant?.retrieveProjectContext) {
      await this.desktopWriter.flush(id)
      return window.readingAssistant.retrieveProjectContext(id, query, options)
    }
    const project = await this.get(id)
    if (!project) return { context: '', hitCount: 0 }
    const result = retrievalService.retrieve({ ...project, files: project.files as RuntimeProjectFile[] }, query, { ...options, strategy: 'project' })
    return { context: result.context, hitCount: result.hits.length }
  }

  async save(project: RuntimeProject | Project) {
    for (const listener of this.writeListeners) listener(project.id)
    const value = persistedProject(project)
    if (window.readingAssistant) return this.desktopWriter.save(value)
    await database.transaction<void>(projectStore, 'readwrite', (transaction) => {
      const store = transaction.objectStore(projectStore)
      const request = store.get(value.id)
      request.onsuccess = () => {
        const existing = request.result as Project | undefined
        const storedFiles = new Map(existing?.files.map((file) => [file.id, file]))
        const storedConversations = new Map(existing?.conversations.map((conversation) => [conversation.id, conversation]))
        store.put({
          ...value,
          files: value.files.map((file) => (file as RuntimeProjectFile).indexLoaded === false
            ? { ...file, paragraphs: storedFiles.get(file.id)?.paragraphs || [] } : file),
          conversations: value.conversations.map(({ historyLoaded, ...conversation }) => historyLoaded === false
            ? { ...conversation, history: storedConversations.get(conversation.id)?.history || [] } : conversation),
        })
      }
    })
    return true
  }

  async saveSource(projectId: string, fileId: string, file: File) {
    if (window.readingAssistant) return window.readingAssistant.saveProjectFileSource({ projectId, fileId, data: await file.arrayBuffer() })
    await idbRequest<IDBValidKey>(sourceStore, 'readwrite', (store) => store.put(file, sourceKey(projectId, fileId)))
    return true
  }

  async getSource(projectId: string, fileId: string, type: string) {
    if (window.readingAssistant) {
      const data = await window.readingAssistant.getProjectFileSource(projectId, fileId)
      return data ? new Blob([data as Uint8Array<ArrayBuffer>], { type }) : null
    }
    return await idbRequest<Blob | undefined>(sourceStore, 'readonly', (store) => store.get(sourceKey(projectId, fileId))) || null
  }

  async deleteProject(id: string) {
    for (const listener of this.writeListeners) listener(id)
    if (window.readingAssistant) return this.desktopWriter.remove(id, () => window.readingAssistant!.deleteProject(id))
    await database.transaction<void>([projectStore, sourceStore], 'readwrite', (transaction) => {
      transaction.objectStore(projectStore).delete(id)
      // Include orphaned sources left behind by an interrupted import.
      const prefix = `${id}:`
      const cursor = transaction.objectStore(sourceStore).openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'))
      cursor.onsuccess = () => {
        if (!cursor.result) return
        cursor.result.delete()
        cursor.result.continue()
      }
    })
  }

  async deleteFile(projectId: string, fileId: string) {
    for (const listener of this.writeListeners) listener(projectId)
    if (window.readingAssistant) return this.desktopWriter.remove(projectId, () => window.readingAssistant!.deleteProjectFile(projectId, fileId))
    await idbRequest<undefined>(sourceStore, 'readwrite', (store) => store.delete(sourceKey(projectId, fileId)))
  }
}

export const projectRepository = new ProjectRepository()
