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
    const temporaryPath = `${dataManifestPath}.${process.pid}.${randomUUID()}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2))
    fs.renameSync(temporaryPath, dataManifestPath)
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

  function writeJsonAtomically(filePath, value) {
    const content = JSON.stringify(value)
    const digest = createHash('sha256').update(content).digest('hex')
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null
    const cached = writtenFiles.get(filePath)
    if (stats && cached?.digest === digest && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.size === stats.size) return
    if (!stats || fs.readFileSync(filePath, 'utf8') !== content) {
      const temporaryPath = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp'
      try {
        fs.writeFileSync(temporaryPath, content)
        fs.renameSync(temporaryPath, filePath)
      } finally { fs.rmSync(temporaryPath, { force: true }) }
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
    return { ...withoutLegacyNotes, files, ...(lightweight ? { conversations: (project.conversations || []).map((conversation) => ({ ...conversation, history: [] })) } : {}) }
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
    const temporaryPath = `${sourcePath}.${process.pid}.${randomUUID()}.tmp`
    fs.writeFileSync(temporaryPath, Buffer.from(payload.data)); fs.renameSync(temporaryPath, sourcePath)
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


  return { initialize: writeDataManifest, readProjectRecord, listProjectSummaries, saveProjectRecord, retrieveStoredProjectContext, getProjectFileSource, saveProjectFileSource, deleteProjectRecord, deleteProjectFile, flush: () => true }
}
