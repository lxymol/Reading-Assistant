import type { Conversation, DocumentAnnotation, DocumentHighlight } from '../types'

export type StoredConversation = Conversation

export type FileMemoryRecord = {
  id: string
  fileName: string
  fileSize: number
  fileType: string
  lastModified: number
  updatedAt: number
  conversations: StoredConversation[]
  activeConversationId: string
  currentPage: number
  zoom: number
  areaSelectionEnabled: boolean
  scope: 'selection' | 'document'
  fileBlob?: Blob
  documentText?: string
  documentTextVersion?: number
  note?: string
  noteAssets?: Record<string, string>
  highlights?: DocumentHighlight[]
  annotations?: DocumentAnnotation[]
}

export type FileMemorySummary = Pick<FileMemoryRecord, 'id' | 'fileName' | 'fileSize' | 'fileType' | 'lastModified' | 'updatedAt'> & { conversationCount: number }

const databaseName = 'reading-assistant-memory'
const storeName = 'file-memories'
const desktopSourceIds = new Set<string>()
let migrationPromise: Promise<void> | null = null

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开文件记忆数据库。'))
  })
}

function runRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = operation(transaction.objectStore(storeName))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error || new Error('文件记忆操作失败。'))
    transaction.oncomplete = () => { database.close(); resolve(result) }
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('文件记忆事务失败。')) }
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error('文件记忆事务已中止。')) }
  }))
}

export function getFileMemoryId(file: File) {
  return JSON.stringify([file.name, file.size, file.lastModified, file.type])
}

function getLegacyFileMemory(id: string) {
  return runRequest<FileMemoryRecord | undefined>('readonly', (store) => store.get(id))
}

function saveLegacyFileMemory(record: FileMemoryRecord) {
  return runRequest<IDBValidKey>('readwrite', (store) => store.put(record))
}

function deleteLegacyFileMemory(id: string) {
  return runRequest<undefined>('readwrite', (store) => store.delete(id))
}

function listLegacyFileMemoryRecords() {
  return runRequest<FileMemoryRecord[]>('readonly', (store) => store.getAll())
}

function deserializeDesktopRecord(value: Record<string, unknown> & { fileData?: Uint8Array }): FileMemoryRecord {
  const { fileData, ...record } = value
  const typed = record as FileMemoryRecord
  if (fileData) typed.fileBlob = new Blob([Uint8Array.from(fileData).buffer], { type: typed.fileType })
  desktopSourceIds.add(typed.id)
  return typed
}

async function saveDesktopRecord(record: FileMemoryRecord, forceSource = false) {
  const { fileBlob, ...metadata } = record
  const fileData = fileBlob && (forceSource || !desktopSourceIds.has(record.id)) ? await fileBlob.arrayBuffer() : undefined
  await window.readingAssistant!.saveProjectMemory(fileData ? { ...metadata, fileData } : metadata)
  if (fileBlob) desktopSourceIds.add(record.id)
}

async function ensureDesktopMigration() {
  if (!window.readingAssistant) return
  if (!migrationPromise) migrationPromise = (async () => {
    if (await window.readingAssistant!.getProjectMigrationStatus()) return
    const existing = new Set((await window.readingAssistant!.listProjectMemorySummaries()).map((item) => String(item.id)))
    const legacyRecords = await listLegacyFileMemoryRecords().catch(() => [])
    for (const record of legacyRecords) if (!existing.has(record.id)) await saveDesktopRecord(record, true)
    await window.readingAssistant!.completeProjectMigration()
  })().catch((error) => { migrationPromise = null; throw error })
  await migrationPromise
}

export async function getFileMemory(id: string) {
  if (!window.readingAssistant) return getLegacyFileMemory(id)
  await ensureDesktopMigration()
  const record = await window.readingAssistant.getProjectMemory(id)
  return record ? deserializeDesktopRecord(record) : undefined
}

export async function saveFileMemory(record: FileMemoryRecord) {
  if (!window.readingAssistant) return saveLegacyFileMemory(record)
  await ensureDesktopMigration()
  await saveDesktopRecord(record)
  return record.id
}

export async function deleteFileMemory(id: string) {
  if (!window.readingAssistant) return deleteLegacyFileMemory(id)
  await ensureDesktopMigration()
  await window.readingAssistant.deleteProjectMemory(id)
  desktopSourceIds.delete(id)
}

export async function listFileMemoryRecords() {
  if (!window.readingAssistant) return listLegacyFileMemoryRecords()
  await ensureDesktopMigration()
  return (await window.readingAssistant.listProjectMemories()).map(deserializeDesktopRecord)
}

export async function listFileMemories(): Promise<FileMemorySummary[]> {
  if (window.readingAssistant) {
    await ensureDesktopMigration()
    return await window.readingAssistant.listProjectMemorySummaries() as FileMemorySummary[]
  }
  const records = await listLegacyFileMemoryRecords()
  return records.sort((a, b) => b.updatedAt - a.updatedAt).map((record) => ({
    id: record.id,
    fileName: record.fileName,
    fileSize: record.fileSize,
    fileType: record.fileType,
    lastModified: record.lastModified,
    updatedAt: record.updatedAt,
    conversationCount: record.conversations.length,
  }))
}
