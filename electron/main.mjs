import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { startServer } from '../server/index.mjs'

const execFileAsync = promisify(execFile)
let localServer = null
let mainWindow = null
let exitCacheCleanupStarted = false
let exitCacheCleanupComplete = false
const dockZoneWindows = new Map()
const panelDragBounds = new WeakMap()
const panelPreparedBounds = new WeakMap()
const dirname = path.dirname(fileURLToPath(import.meta.url))
const appIconPath = path.join(dirname, process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png')
const dockZoneWidth = 32
const textFileExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.tex'])
const packagedTestMarker = path.join(path.dirname(process.execPath), 'TEST_BUILD')
const isDevelopmentInstance = process.argv.includes('--development-instance') || (app.isPackaged && fs.existsSync(packagedTestMarker))
const applicationDirectory = app.isPackaged ? path.dirname(process.execPath) : path.resolve(dirname, '..')
const raidDataPath = path.join(applicationDirectory, isDevelopmentInstance ? 'RaidData-test' : 'RaidData')
const runtimeDataPath = path.join(raidDataPath, 'Runtime')
const durableDataPath = path.join(raidDataPath, 'Data')
const projectsDataPath = path.join(durableDataPath, 'projects')
const cacheDataPath = path.join(raidDataPath, 'Cache')
const sessionDataPath = path.join(runtimeDataPath, 'Chromium')
const crashDataPath = path.join(cacheDataPath, 'Crashpad')
const conversionCachePath = path.join(cacheDataPath, 'Conversion')
const dataManifestPath = path.join(raidDataPath, 'manifest.json')
const storageSchemaVersion = 1
const defaultUserDataPath = app.getPath('userData')
const defaultSessionDataPath = app.getPath('sessionData')
const chromiumDiskCacheLimit = 64 * 1024 * 1024
const chromiumMediaCacheLimit = 16 * 1024 * 1024

// Keep a small, warm Chromium profile on the system drive for fast launches.
// Durable reader data is stored separately in RaidData/Data beside the app.
app.commandLine.appendSwitch('disk-cache-size', String(chromiumDiskCacheLimit))
app.commandLine.appendSwitch('media-cache-size', String(chromiumMediaCacheLimit))

function moveLegacyRuntimeEntry(name, destination = path.join(runtimeDataPath, name)) {
  const source = path.join(raidDataPath, name)
  if (!fs.existsSync(source) || fs.existsSync(destination)) return
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try { fs.renameSync(source, destination) } catch { /* Keep the readable legacy copy when migration is blocked. */ }
}

fs.mkdirSync(runtimeDataPath, { recursive: true })
moveLegacyRuntimeEntry('Chromium', sessionDataPath)
moveLegacyRuntimeEntry('Code Cache')
for (const directory of [raidDataPath, runtimeDataPath, durableDataPath, projectsDataPath, cacheDataPath, sessionDataPath, crashDataPath, conversionCachePath]) fs.mkdirSync(directory, { recursive: true })
if (isDevelopmentInstance) {
  const testUserDataPath = `${defaultUserDataPath}-test`
  const testSessionDataPath = `${defaultSessionDataPath}-test`
  fs.mkdirSync(testUserDataPath, { recursive: true })
  fs.mkdirSync(testSessionDataPath, { recursive: true })
  app.setPath('userData', testUserDataPath)
  app.setPath('sessionData', testSessionDataPath)
}
app.setPath('crashDumps', crashDataPath)
if (process.platform === 'win32') app.setAppUserModelId('cn.lxymol.readingassistant')
const internalPort = isDevelopmentInstance ? 18788 : 18787
const hasSingleInstanceLock = app.requestSingleInstanceLock()

function logStartup(message) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging must never prevent the reader from opening.
  }
}

function readTextFiles(folderPath, options = {}) {
  const { requiredName = '', maxFiles = 48, maxBytes = 1024 * 1024 } = options
  const files = []
  let totalBytes = 0
  const visit = (currentPath) => {
    if (files.length >= maxFiles || totalBytes >= maxBytes) return
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const absolutePath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        visit(absolutePath)
        continue
      }
      if (!entry.isFile() || (!textFileExtensions.has(path.extname(entry.name).toLowerCase()) && entry.name !== requiredName)) continue
      const size = fs.statSync(absolutePath).size
      if (size > 256 * 1024 || totalBytes + size > maxBytes) continue
      files.push({ path: path.relative(folderPath, absolutePath).replaceAll('\\', '/'), content: fs.readFileSync(absolutePath, 'utf8') })
      totalBytes += size
      if (files.length >= maxFiles || totalBytes >= maxBytes) return
    }
  }
  visit(folderPath)
  return files
}

async function selectImportFolder(kind) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'skill' ? '选择 Skill 文件夹' : '选择语言包文件夹',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const folderPath = path.resolve(result.filePaths[0])
  try {
    const files = readTextFiles(folderPath, { requiredName: kind === 'skill' ? 'SKILL.md' : 'language.json' })
    if (kind === 'skill' && !files.some((file) => file.path.toLowerCase() === 'skill.md')) {
      return { error: '所选文件夹根目录中没有 SKILL.md。' }
    }
    const languageFiles = files.filter((file) => file.path.toLowerCase() === 'language.json' || file.path.toLowerCase().endsWith('.json'))
    if (kind === 'language' && !languageFiles.length) return { error: '所选文件夹中没有 language.json 或其他 JSON 语言包。' }
    return { folderPath, files: kind === 'language' ? languageFiles : files }
  } catch (error) {
    return { error: error instanceof Error ? error.message : '无法读取所选文件夹。' }
  }
}

const convertibleTextExtensions = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.xml', '.html', '.htm', '.css', '.csv', '.tsv', '.log', '.ini', '.cfg', '.conf',
  '.yaml', '.yml', '.toml', '.tex', '.bib', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.sql', '.sh', '.ps1', '.bat', '.cmd', '.vue', '.svelte',
])
const officeParserExtensions = new Set(['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.rtf', '.epub'])

function readableText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0) && !(sample[0] === 0xff && sample[1] === 0xfe) && !(sample[0] === 0xfe && sample[1] === 0xff)) return null
  if (sample[0] === 0xff && sample[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (sample[0] === 0xfe && sample[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]]
    return swapped.toString('utf16le')
  }
  const value = buffer.toString('utf8')
  const invalid = (value.match(/\uFFFD/g) || []).length
  return invalid > Math.max(4, value.length * .01) ? null : value
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

async function htmlToPdf(html, workingDirectory) {
  const htmlPath = path.join(workingDirectory, 'document.html')
  fs.writeFileSync(htmlPath, html)
  const printWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  try {
    await printWindow.loadFile(htmlPath)
    return await printWindow.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: .35, bottom: .35, left: .35, right: .35 } })
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy()
  }
}

async function textToPdf(text, title, workingDirectory) {
  return htmlToPdf(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{size:A4;margin:16mm 15mm}*{box-sizing:border-box}body{margin:0;color:#181818;background:#fff;font:12px/1.55 "Segoe UI","Microsoft YaHei UI",sans-serif}h1{margin:0 0 14px;font-size:16px;overflow-wrap:anywhere}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.55 Consolas,"Microsoft YaHei UI",monospace}</style><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(text)}</pre>`, workingDirectory)
}

async function parsedOfficeToPdf(buffer, extension, workingDirectory) {
  const { OfficeParser } = await import('./vendor/officeparser.slim.mjs')
  const ast = await OfficeParser.parseOffice(buffer, { fileType: extension.slice(1), extractAttachments: true, ignoreSlideMasters: true })
  const { value } = await ast.to('html', { includeImages: true, htmlConfig: { containerWidth: '100%' } })
  return htmlToPdf(String(value), workingDirectory)
}

function findLibreOffice() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean)
  const candidates = roots.map((root) => path.join(root, 'LibreOffice', 'program', 'soffice.exe'))
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(directory, process.platform === 'win32' ? 'soffice.exe' : 'soffice'))
  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

async function officeToPdf(inputPath, workingDirectory) {
  const executable = findLibreOffice()
  if (!executable) throw new Error('OFFICE_CONVERTER_UNAVAILABLE')
  const profilePath = path.join(workingDirectory, 'libreoffice-profile')
  fs.mkdirSync(profilePath, { recursive: true })
  await execFileAsync(executable, ['--headless', `-env:UserInstallation=${pathToFileURL(profilePath).href}`, '--convert-to', 'pdf', '--outdir', workingDirectory, inputPath], { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
  const outputPath = fs.readdirSync(workingDirectory).map((name) => path.join(workingDirectory, name)).find((candidate) => path.extname(candidate).toLowerCase() === '.pdf')
  if (!outputPath) throw new Error('DOCUMENT_CONVERSION_FAILED')
  return fs.readFileSync(outputPath)
}

async function convertDocument(payload) {
  const safeName = path.basename(String(payload?.name || 'document'))
  const buffer = Buffer.from(payload?.data || [])
  if (!buffer.length) return { error: 'EMPTY_FILE' }
  if (buffer.length > 256 * 1024 * 1024) return { error: 'FILE_TOO_LARGE' }
  const workingDirectory = path.join(conversionCachePath, randomUUID())
  fs.mkdirSync(workingDirectory, { recursive: true })
  try {
    const extension = path.extname(safeName).toLowerCase()
    const inputPath = path.join(workingDirectory, safeName || `document${extension || '.bin'}`)
    fs.writeFileSync(inputPath, buffer)
    const text = convertibleTextExtensions.has(extension) || String(payload?.type || '').startsWith('text/') ? readableText(buffer) : null
    let pdfBuffer
    if (text !== null) pdfBuffer = await textToPdf(text, safeName, workingDirectory)
    else if (officeParserExtensions.has(extension)) {
      try { pdfBuffer = await parsedOfficeToPdf(buffer, extension, workingDirectory) }
      catch { pdfBuffer = await officeToPdf(inputPath, workingDirectory) }
    }
    else {
      try { pdfBuffer = await officeToPdf(inputPath, workingDirectory) }
      catch (error) {
        const fallbackText = readableText(buffer)
        if (fallbackText !== null) pdfBuffer = await textToPdf(fallbackText, safeName, workingDirectory)
        else throw error
      }
    }
    const baseName = path.basename(safeName, extension) || 'document'
    return { name: `${baseName}.pdf`, type: 'application/pdf', data: new Uint8Array(pdfBuffer) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'DOCUMENT_CONVERSION_FAILED' }
  } finally {
    if (path.resolve(workingDirectory).startsWith(`${path.resolve(conversionCachePath)}${path.sep}`)) fs.rmSync(workingDirectory, { recursive: true, force: true })
  }
}

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
  const manifest = { ...readDataManifest(), ...update, schemaVersion: storageSchemaVersion, appVersion: app.getVersion(), updatedAt: Date.now() }
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

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(value))
  fs.renameSync(temporaryPath, filePath)
}

function readProjectRecord(directory, includeSource = true) {
  const metadataPath = path.join(directory, 'project.json')
  if (!fs.existsSync(metadataPath)) return null
  const stored = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  if (Number(stored.schemaVersion || 0) > storageSchemaVersion) throw new Error('PROJECT_DATA_FROM_NEWER_VERSION')
  const { schemaVersion: _schemaVersion, hasSource: _hasSource, ...record } = stored
  const sourcePath = path.join(directory, 'source.bin')
  return includeSource && fs.existsSync(sourcePath) ? { ...record, fileData: new Uint8Array(fs.readFileSync(sourcePath)) } : record
}

function listProjectRecords(includeSource = true) {
  const records = []
  for (const entry of fs.readdirSync(projectsDataPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const record = readProjectRecord(path.join(projectsDataPath, entry.name), includeSource)
      if (record) records.push(record)
    } catch (error) {
      logStartup(`Skipped unreadable project ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return records.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

function projectSummary(record) {
  return { id: record.id, fileName: record.fileName, fileSize: record.fileSize, fileType: record.fileType, lastModified: record.lastModified, updatedAt: record.updatedAt, conversationCount: Array.isArray(record.conversations) ? record.conversations.length : Number(record.conversationCount || 0) }
}

function listProjectSummaries() {
  const summaries = []
  for (const entry of fs.readdirSync(projectsDataPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(projectsDataPath, entry.name)
    try {
      const summaryPath = path.join(directory, 'summary.json')
      const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : projectSummary(readProjectRecord(directory, false) || {})
      if (!fs.existsSync(summaryPath) && summary.id) writeJsonAtomically(summaryPath, summary)
      if (summary.id) summaries.push(summary)
    } catch (error) {
      logStartup(`Skipped unreadable project summary ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return summaries.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

function saveProjectRecord(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') throw new Error('INVALID_PROJECT_RECORD')
  const directory = projectDataDirectory(payload.id)
  fs.mkdirSync(directory, { recursive: true })
  const { fileData, ...record } = payload
  const sourcePath = path.join(directory, 'source.bin')
  if (fileData != null) {
    const temporarySource = `${sourcePath}.${process.pid}.${randomUUID()}.tmp`
    fs.writeFileSync(temporarySource, Buffer.from(fileData))
    fs.renameSync(temporarySource, sourcePath)
  }
  writeJsonAtomically(path.join(directory, 'project.json'), { schemaVersion: storageSchemaVersion, hasSource: fs.existsSync(sourcePath), ...record })
  writeJsonAtomically(path.join(directory, 'summary.json'), projectSummary(record))
  writeDataManifest()
  return true
}

function deleteProjectRecord(id) {
  fs.rmSync(projectDataDirectory(id), { recursive: true, force: true })
  writeDataManifest()
}

writeDataManifest()

async function maintainCachesOnExit() {
  if (readDataManifest().systemProfileProjectMigrationComplete) await session.defaultSession.clearData({ dataTypes: ['indexedDB'] }).catch(() => undefined)
  // Performance caches are deliberately retained: Chromium enforces the size
  // limits above, while keeping them warm avoids a cold start after every exit.
  fs.rmSync(conversionCachePath, { recursive: true, force: true })
  fs.mkdirSync(conversionCachePath, { recursive: true })
}

ipcMain.handle('reading-assistant:select-skill-folder', () => selectImportFolder('skill'))
ipcMain.handle('reading-assistant:select-language-folder', () => selectImportFolder('language'))
ipcMain.handle('reading-assistant:convert-document', (_event, payload) => convertDocument(payload))
ipcMain.handle('reading-assistant:list-project-memories', () => listProjectRecords(false))
ipcMain.handle('reading-assistant:get-project-memory', (_event, id) => readProjectRecord(projectDataDirectory(id), true))
ipcMain.handle('reading-assistant:save-project-memory', (_event, payload) => saveProjectRecord(payload))
ipcMain.handle('reading-assistant:delete-project-memory', (_event, id) => deleteProjectRecord(id))
ipcMain.handle('reading-assistant:list-project-memory-summaries', () => listProjectSummaries())
ipcMain.handle('reading-assistant:get-project-migration-status', () => Boolean(readDataManifest().systemProfileProjectMigrationComplete))
ipcMain.handle('reading-assistant:complete-project-migration', () => { writeDataManifest({ legacyProjectMigrationComplete: true, systemProfileProjectMigrationComplete: true }); return true })
ipcMain.handle('reading-assistant:open-external', async (_event, value) => {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('Only HTTPS links may be opened externally.')
  await shell.openExternal(url.href)
  return true
})
const getPanelWindow = (sender) => {
  const panelWindow = BrowserWindow.fromWebContents(sender)
  return mainWindow && panelWindow && !panelWindow.isDestroyed() && panelWindow.getParentWindow() === mainWindow ? panelWindow : null
}

function getDockZoneWindow(side) {
  const existing = dockZoneWindows.get(side)
  if (existing && !existing.isDestroyed()) return existing
  const zoneWindow = new BrowserWindow({
    width: dockZoneWidth,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  zoneWindow.setIgnoreMouseEvents(true)
  zoneWindow.setAlwaysOnTop(true, 'screen-saver')
  zoneWindow.raidActive = false
  zoneWindow.raidDark = false
  zoneWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;contain:strict;clip-path:inset(0)}body::before{content:"";position:absolute;inset:6% 0;opacity:.5;filter:blur(9px);background:radial-gradient(ellipse at left center,rgba(55,148,255,.92),rgba(55,148,255,.34) 42%,transparent 74%);transition:opacity .1s}body.right::before{transform:scaleX(-1)}body.dark::before{background:radial-gradient(ellipse at left center,rgba(246,195,55,.9),rgba(246,195,55,.34) 42%,transparent 74%)}body.active::before{opacity:.95;filter:blur(7px)}</style><body class="${side}"></body>`)}`)
  zoneWindow.webContents.on('did-finish-load', () => {
    void zoneWindow.webContents.executeJavaScript(`document.body.classList.toggle('active', ${zoneWindow.raidActive});document.body.classList.toggle('dark', ${zoneWindow.raidDark})`).catch(() => undefined)
  })
  zoneWindow.on('closed', () => dockZoneWindows.delete(side))
  dockZoneWindows.set(side, zoneWindow)
  return zoneWindow
}

function setDockZones(visible, active = null, dark = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!visible) {
    for (const zoneWindow of dockZoneWindows.values()) if (!zoneWindow.isDestroyed()) zoneWindow.hide()
    return
  }
  for (const side of ['left', 'right']) {
    const zoneWindow = getDockZoneWindow(side)
    const bounds = mainWindow.getBounds()
    zoneWindow.setBounds({ x: side === 'left' ? bounds.x : bounds.x + bounds.width - dockZoneWidth, y: bounds.y, width: dockZoneWidth, height: bounds.height }, false)
    zoneWindow.raidActive = active === side
    zoneWindow.raidDark = dark
    void zoneWindow.webContents.executeJavaScript(`document.body.classList.toggle('active', ${zoneWindow.raidActive});document.body.classList.toggle('dark', ${zoneWindow.raidDark})`).catch(() => undefined)
    zoneWindow.showInactive()
  }
}

function setPanelPositionPreservingSize(panelWindow, x, y, lockedBounds) {
  let width = lockedBounds.width
  let height = lockedBounds.height
  for (let attempt = 0; attempt < 3; attempt += 1) {
    panelWindow.setBounds({ x, y, width, height }, false)
    const actual = panelWindow.getBounds()
    const widthError = lockedBounds.width - actual.width
    const heightError = lockedBounds.height - actual.height
    if (widthError === 0 && heightError === 0) break
    width += widthError
    height += heightError
  }
}

ipcMain.on('reading-assistant:move-panel-window', (event, payload) => {
  const x = Math.round(Number(payload?.x))
  const y = Math.round(Number(payload?.y))
  const panelWindow = getPanelWindow(event.sender)
  if (!panelWindow) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const lockedBounds = panelDragBounds.get(panelWindow)
  if (lockedBounds) setPanelPositionPreservingSize(panelWindow, x, y, lockedBounds)
  else panelWindow.setPosition(x, y, false)
})
ipcMain.on('reading-assistant:prepare-panel-drag', (event) => {
  const panelWindow = getPanelWindow(event.sender)
  if (!panelWindow || panelDragBounds.has(panelWindow)) return
  const { width, height } = panelWindow.getBounds()
  panelPreparedBounds.set(panelWindow, { width, height })
})
ipcMain.on('reading-assistant:set-panel-dragging', (event, payload) => {
  const panelWindow = getPanelWindow(event.sender)
  if (!panelWindow) return
  if (payload?.active) {
    const currentBounds = panelWindow.getBounds()
    const lockedBounds = panelPreparedBounds.get(panelWindow) ?? { width: currentBounds.width, height: currentBounds.height }
    panelDragBounds.set(panelWindow, lockedBounds)
    setPanelPositionPreservingSize(panelWindow, currentBounds.x, currentBounds.y, lockedBounds)
    return
  }
  const lockedBounds = panelDragBounds.get(panelWindow)
  if (lockedBounds) {
    const { x, y } = panelWindow.getBounds()
    setPanelPositionPreservingSize(panelWindow, x, y, lockedBounds)
  }
  panelDragBounds.delete(panelWindow)
  if (lockedBounds) panelPreparedBounds.set(panelWindow, lockedBounds)
})
ipcMain.on('reading-assistant:set-dock-zones', (event, payload) => {
  if (!getPanelWindow(event.sender)) return
  const active = payload?.active === 'left' || payload?.active === 'right' ? payload.active : null
  setDockZones(Boolean(payload?.visible), active, Boolean(payload?.dark))
})

async function createWindow() {
  logStartup('Starting local service')
  const started = await startServer(internalPort)
  localServer = started.server
  logStartup(`Local service ready on ${started.port}`)

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 520,
    minHeight: 480,
    show: false,
    title: isDevelopmentInstance ? 'Raid · Test' : 'Raid',
    backgroundColor: '#171a20',
    autoHideMenuBar: true,
    icon: appIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(dirname, 'preload.cjs'),
    },
  })

  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
    logStartup('Main window shown')
  }
  mainWindow.once('ready-to-show', showMainWindow)
  mainWindow.webContents.once('dom-ready', () => logStartup('Reader DOM ready'))
  mainWindow.setMenuBarVisibility(false)
  mainWindow.on('closed', () => {
    for (const zoneWindow of dockZoneWindows.values()) if (!zoneWindow.isDestroyed()) zoneWindow.destroy()
    dockZoneWindows.clear()
    mainWindow = null
  })
  logStartup('Browser window created')
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName.startsWith('reading-assistant-panel-')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: mainWindow,
          modal: false,
          frame: false,
          autoHideMenuBar: true,
          minWidth: 260,
          minHeight: 220,
          backgroundColor: '#252526',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(dirname, 'preload.cjs') },
        },
      }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localOrigin = `http://127.0.0.1:${started.port}`
    if (!url.startsWith(localOrigin)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  await mainWindow.loadURL(`http://127.0.0.1:${started.port}`)
  showMainWindow()
  const importBridgeReady = await mainWindow.webContents.executeJavaScript("Boolean(window.readingAssistant?.selectSkillFolder && window.readingAssistant?.selectLanguageFolder && window.readingAssistant?.movePanelWindow)")
  logStartup(`Folder import bridge ready: ${importBridgeReady}`)
  console.log(`Raid folder import bridge: ${importBridgeReady ? 'ready' : 'unavailable'}`)
  logStartup('Reader interface loaded')
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.whenReady().then(() => {
    logStartup('Electron ready')
    return createWindow()
  }).catch((error) => {
    logStartup(`Startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    console.error(error)
    app.quit()
  })
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  setDockZones(false)
  localServer?.close()
  localServer = null
  if (exitCacheCleanupComplete || exitCacheCleanupStarted) return
  event.preventDefault()
  exitCacheCleanupStarted = true
  void maintainCachesOnExit().catch((error) => logStartup(`Exit cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
    exitCacheCleanupComplete = true
    app.quit()
  })
})
