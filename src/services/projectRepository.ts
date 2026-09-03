import type { Project, ProjectSummary, RuntimeProject, RuntimeProjectFile } from '../types'

const databaseName = 'raid-projects-v2'
const projectStore = 'projects'
const sourceStore = 'sources'

const persistedProject = (project: RuntimeProject | Project): Project => {
  const { files, ...metadata } = project
  return {
    ...metadata,
    files: files.map((file) => {
      const value = { ...file } as RuntimeProjectFile
      delete value.source; delete value.pdf; delete value.sourceLoaded
      return value
    }),
  }
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(projectStore)) request.result.createObjectStore(projectStore, { keyPath: 'id' })
      if (!request.result.objectStoreNames.contains(sourceStore)) request.result.createObjectStore(sourceStore)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开项目数据库。'))
  })
}

async function idbRequest<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = operation(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('项目数据库操作失败。'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('项目数据库事务失败。')) }
  })
}

const sourceKey = (projectId: string, fileId: string) => `${projectId}:${fileId}`

export class ProjectRepository {
  async list(): Promise<ProjectSummary[]> {
    if (window.readingAssistant) return window.readingAssistant.listProjects()
    const projects = await idbRequest<Project[]>(projectStore, 'readonly', (store) => store.getAll())
    return projects.map((project) => ({ id: project.id, name: project.name, fileCount: project.files.length, conversationCount: project.conversations.length, updatedAt: project.updatedAt, activeFileId: project.activeFileId })).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<Project | null> {
    if (window.readingAssistant) return window.readingAssistant.getProject(id)
    return await idbRequest<Project | undefined>(projectStore, 'readonly', (store) => store.get(id)) || null
  }

  async save(project: RuntimeProject | Project) {
    const value = persistedProject(project)
    if (window.readingAssistant) return window.readingAssistant.saveProject(value)
    await idbRequest<IDBValidKey>(projectStore, 'readwrite', (store) => store.put(value))
    return true
  }

  async saveSource(projectId: string, fileId: string, file: File) {
    const data = await file.arrayBuffer()
    if (window.readingAssistant) return window.readingAssistant.saveProjectFileSource({ projectId, fileId, data })
    await idbRequest<IDBValidKey>(sourceStore, 'readwrite', (store) => store.put(new Blob([data], { type: file.type }), sourceKey(projectId, fileId)))
    return true
  }

  async getSource(projectId: string, fileId: string, type: string) {
    if (window.readingAssistant) {
      const data = await window.readingAssistant.getProjectFileSource(projectId, fileId)
      return data ? new Blob([Uint8Array.from(data)], { type }) : null
    }
    return await idbRequest<Blob | undefined>(sourceStore, 'readonly', (store) => store.get(sourceKey(projectId, fileId))) || null
  }

  async deleteProject(id: string) {
    if (window.readingAssistant) return window.readingAssistant.deleteProject(id)
    const project = await this.get(id)
    await idbRequest<undefined>(projectStore, 'readwrite', (store) => store.delete(id))
    for (const file of project?.files || []) await idbRequest<undefined>(sourceStore, 'readwrite', (store) => store.delete(sourceKey(id, file.id)))
  }

  async deleteFile(projectId: string, fileId: string) {
    if (window.readingAssistant) return window.readingAssistant.deleteProjectFile(projectId, fileId)
    await idbRequest<undefined>(sourceStore, 'readwrite', (store) => store.delete(sourceKey(projectId, fileId)))
  }
}

export const projectRepository = new ProjectRepository()
