import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { retrieveProjectContext } from './project-retrieval.mjs'

// All operations use the existing v2 paths and file format. The worker executes
// requests serially so reads, saves and deletes retain IPC submission order.
export function createProjectStorage({ projectsDataPath, dataManifestPath, storageSchemaVersion = 2, appVersion, logStartup = () => {} }) {
  const writtenFiles = new Map()
  function readDataManifest() {
    let manifest = null
    if (fs.existsSync(dataManifestPath)) {
      try { manifest = JSON.parse(fs.readFileSync(dataManifestPath, 'utf8')) }
      catch { throw new Error('RAID_DATA_MANIFEST_INVALID') }
    }
    if (Number(manifest?.schemaVersion || 0) > storageSchemaVersion) throw new Error('RAID_DATA_FROM_NEWER_VERSION')
    return manifest && typeof manifest === 'object' ? manifest : { schemaVersion: storageSchemaVersion, createdAt: Date.now(), legacyProjectMigrationComplete: false }
  }

  function writeDataManifest(update = {}) {
    const manifest = { ...readDataManifest(), ...update, schemaVersion: storageSchemaVersion, appVersion, updatedAt: Date.now() }
    replaceFile(dataManifestPath, JSON.stringify(manifest, null, 2))
    return manifest
  }

  function projectDataDirectory(id) {
    const key = createHash('sha256').update(String(id)).digest('hex')
    const directory = path.join(projectsDataPath, key)
    if (!path.resolve(directory).startsWith(`${path.resolve(projectsDataPath)}${path.sep}`)) throw new Error('INVALID_PROJECT_ID')
    return directory
  }

  function projectFileDirectory(projectId, fileId) {
    const root = path.join(projectDataDirectory(projectId), 'files')
    const key = createHash('sha256').update(String(fileId)).digest('hex')
    const directory = path.join(root, key)
    if (!path.resolve(directory).startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('INVALID_FILE_ID')
    return directory
  }

  function replaceFile(filePath, content) {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, content)
      fs.renameSync(temporaryPath, filePath)
    } finally { fs.rmSync(temporaryPath, { force: true }) }
  }

  function writeJsonAtomically(filePath, value) {
    const content = JSON.stringify(value)
    const digest = createHash('sha256').update(content).digest('hex')
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null
    const cached = writtenFiles.get(filePath)
    if (stats && cached?.digest === digest && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.size === stats.size) return
    if (!stats || fs.readFileSync(filePath, 'utf8') !== content) {
      replaceFile(filePath, content)
    }
    const next = fs.statSync(filePath)
    writtenFiles.delete(filePath)
    writtenFiles.set(filePath, { digest, mtimeMs: next.mtimeMs, ctimeMs: next.ctimeMs, size: next.size })
    if (writtenFiles.size > 1024) writtenFiles.delete(writtenFiles.keys().next().value)
  }

  function projectSummary(record) {
    return { id: record.id, name: record.name, fileCount: Array.isArray(record.fileOrder) ? record.fileOrder.length : 0, conversationCount: Array.isArray(record.conversations) ? record.conversations.length : 0, updatedAt: record.updatedAt, activeFileId: record.activeFileId || null }
  }

  function readProjectRecord(id, lightweight = false, indexFileId = null) {
    const directory = projectDataDirectory(id)
    const metadataPath = path.join(directory, 'project.json')
    if (!fs.existsSync(metadataPath)) return null
    const stored = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    if (stored.kind !== 'raid-project' || Number(stored.schemaVersion) !== storageSchemaVersion) return null
    const { schemaVersion: _schemaVersion, kind: _kind, fileOrder = [], projectAssetManifest: _projectAssetManifest, ...project } = stored
    const files = fileOrder.flatMap((fileId) => {
      const fileDirectory = projectFileDirectory(id, fileId)
      const filePath = path.join(fileDirectory, 'file.json')
      if (!fs.existsSync(filePath)) return []
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const indexPath = path.join(fileDirectory, 'index.json')
      const indexLoaded = !lightweight && (!indexFileId || indexFileId === fileId)
      const index = indexLoaded && fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { paragraphs: [], indexState: value.indexState }
      const { assetManifest: _assetManifest, fileNotes: _fileNotes, fileNoteAssets: _fileNoteAssets, ...file } = value
      return [{ ...file, paragraphs: Array.isArray(index.paragraphs) ? index.paragraphs : [], indexState: index.indexState || file.indexState, ...((lightweight || indexFileId) ? { indexLoaded } : {}) }]
    })
    const { projectNotes: _projectNotes, projectNoteAssets: _projectNoteAssets, ...withoutLegacyNotes } = project
    return { ...withoutLegacyNotes, files, ...(lightweight ? { conversations: (project.conversations || []).map((conversation) => ({ ...conversation, history: [], historyLoaded: false })) } : {}) }
  }

  function listProjectSummaries() {
    const summaries = []
    for (const entry of fs.readdirSync(projectsDataPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const summaryPath = path.join(projectsDataPath, entry.name, 'summary.json')
        if (!fs.existsSync(summaryPath)) continue
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        if (summary.schemaVersion === storageSchemaVersion) summaries.push(summary)
      } catch (error) { logStartup(`Skipped unreadable project summary ${entry.name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return summaries.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  }

  function saveProjectRecord(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !Array.isArray(payload.files)) throw new Error('INVALID_PROJECT_RECORD')
    for (const value of payload.files) {
      if (!value || value.projectId !== payload.id || typeof value.id !== 'string') throw new Error('INVALID_PROJECT_FILE')
    }
    const directory = projectDataDirectory(payload.id)
    fs.mkdirSync(path.join(directory, 'files'), { recursive: true })
    const { files, projectNotes: _projectNotes, projectNoteAssets: _projectNoteAssets, ...project } = payload
    const metadataPath = path.join(directory, 'project.json')
    const previous = project.conversations?.some((conversation) => conversation.historyLoaded === false) && fs.existsSync(metadataPath)
      ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null
    const histories = new Map(previous?.conversations?.map((conversation) => [conversation.id, conversation.history]))
    project.conversations = (project.conversations || []).map(({ historyLoaded, ...conversation }) => historyLoaded === false
      ? { ...conversation, history: histories.get(conversation.id) || [] } : conversation)
    fs.rmSync(path.join(directory, 'resources'), { recursive: true, force: true })
    for (const value of files) {
      const fileDirectory = projectFileDirectory(payload.id, value.id)
      fs.mkdirSync(fileDirectory, { recursive: true })
      const { paragraphs, indexLoaded, fileNotes: _fileNotes, fileNoteAssets: _fileNoteAssets, assetManifest: _assetManifest, ...file } = value
      writeJsonAtomically(path.join(fileDirectory, 'file.json'), file)
      if (indexLoaded !== false) writeJsonAtomically(path.join(fileDirectory, 'index.json'), { indexState: file.indexState, paragraphs })
    }
    const record = { schemaVersion: storageSchemaVersion, kind: 'raid-project', ...project, fileOrder: files.map((file) => file.id) }
    writeJsonAtomically(path.join(directory, 'project.json'), record)
    writeJsonAtomically(path.join(directory, 'summary.json'), { schemaVersion: storageSchemaVersion, ...projectSummary(record) })
    writeDataManifest()
    return true
  }

  function getProjectFileSource(projectId, fileId) {
    const sourcePath = path.join(projectFileDirectory(projectId, fileId), 'source.bin')
    return fs.existsSync(sourcePath) ? new Uint8Array(fs.readFileSync(sourcePath)) : null
  }

  function saveProjectFileSource(payload) {
    if (!payload || typeof payload.projectId !== 'string' || typeof payload.fileId !== 'string' || payload.data == null) throw new Error('INVALID_PROJECT_FILE_SOURCE')
    const directory = projectFileDirectory(payload.projectId, payload.fileId)
    fs.mkdirSync(directory, { recursive: true })
    const sourcePath = path.join(directory, 'source.bin')
    const data = ArrayBuffer.isView(payload.data)
      ? Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
      : Buffer.from(payload.data)
    replaceFile(sourcePath, data)
    return true
  }

  function retrieveStoredProjectContext(id, query, options = {}) {
    const directory = projectDataDirectory(id)
    const metadataPath = path.join(directory, 'project.json')
    if (!fs.existsSync(metadataPath)) return { context: '', hitCount: 0 }
    const stored = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    const fileOrder = stored.fileOrder || []
    function * files() {
      for (const fileId of fileOrder) {
        const fileDirectory = projectFileDirectory(id, fileId)
        const metadata = path.join(fileDirectory, 'file.json')
        const index = path.join(fileDirectory, 'index.json')
        if (!fs.existsSync(metadata) || !fs.existsSync(index)) continue
        const file = JSON.parse(fs.readFileSync(metadata, 'utf8'))
        const indexed = JSON.parse(fs.readFileSync(index, 'utf8'))
        yield { name: file.name, paragraphs: indexed.paragraphs || [] }
      }
    }
    return retrieveProjectContext(files(), query, { ...options, fileCount: fileOrder.length })
  }

  function deleteProjectRecord(id) { fs.rmSync(projectDataDirectory(id), { recursive: true, force: true }); writeDataManifest() }
  function deleteProjectFile(projectId, fileId) { fs.rmSync(projectFileDirectory(projectId, fileId), { recursive: true, force: true }); writeDataManifest() }

  // Export complete documents one at a time in the storage worker. Neither the
  // renderer nor the main process needs to keep the combination's indexes alive.
  function writeAiDocuments(id, fileIds, workdir) {
    const stored = JSON.parse(fs.readFileSync(path.join(projectDataDirectory(id), 'project.json'), 'utf8'))
    const selected = Array.isArray(fileIds) && fileIds.length ? [...new Set(fileIds)] : stored.fileOrder
    if (!selected?.length || selected.some((fileId) => !stored.fileOrder.includes(fileId))) throw new Error('INVALID_DOCUMENT_ATTACHMENT')
    const directory = path.join(workdir, 'attachments')
    fs.mkdirSync(directory, { recursive: true })
    return selected.map((fileId, number) => {
      const sourceDirectory = projectFileDirectory(id, fileId)
      const file = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'file.json'), 'utf8'))
      const name = `${String(number + 1).padStart(3, '0')}-${String(file.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120)}.txt`
      const output = path.join(directory, name)
      if (file.kind === 'text' && fs.existsSync(path.join(sourceDirectory, 'source.bin'))) {
        fs.copyFileSync(path.join(sourceDirectory, 'source.bin'), output)
      } else {
        const indexPath = path.join(sourceDirectory, 'index.json')
        if (!fs.existsSync(indexPath)) throw new Error(`文档尚未完成文字提取：${file.name}`)
        if (fs.statSync(indexPath).size > 16 * 1024 * 1024) throw new Error(`文档索引超过单文件内存预算，请拆分后提问：${file.name}`)
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
        if (!index.paragraphs?.some((paragraph) => String(paragraph.text || '').trim())) throw new Error(`文档没有可读文字，需要先进行 OCR：${file.name}`)
        const descriptor = fs.openSync(output, 'w')
        try {
          for (const paragraph of index.paragraphs) fs.writeSync(descriptor, `[Page ${paragraph.page}]\n${paragraph.text}\n\n`)
        } finally { fs.closeSync(descriptor) }
      }
      const textAnnotations = (file.annotations || []).filter((annotation) => annotation.type === 'text' && annotation.text?.trim())
      for (const annotation of textAnnotations) fs.appendFileSync(output, `\n[User annotation, page ${annotation.page}]\n${annotation.text}\n`)
      if (!fs.statSync(output).size) throw new Error(`文档没有可读文字：${file.name}`)
      return { id: fileId, name: file.name, path: output, byteLength: fs.statSync(output).size }
    })
  }

  return { initialize: writeDataManifest, readProjectRecord, listProjectSummaries, saveProjectRecord, retrieveStoredProjectContext, writeAiDocuments, getProjectFileSource, saveProjectFileSource, deleteProjectRecord, deleteProjectFile, flush: () => true }
}
