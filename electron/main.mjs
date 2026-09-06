import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createProjectStorage } from './project-storage.mjs'
import { ProjectStorageClient } from './project-storage-client.mjs'
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
const selectionCachePath = path.join(cacheDataPath, 'Selections')
const dataManifestPath = path.join(raidDataPath, 'manifest.json')
const storageSchemaVersion = 2
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
for (const directory of [raidDataPath, runtimeDataPath, durableDataPath, projectsDataPath, cacheDataPath, sessionDataPath, crashDataPath, conversionCachePath, selectionCachePath]) fs.mkdirSync(directory, { recursive: true })
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
if (hasSingleInstanceLock) {
  // Selection screenshots are session-only. Remove leftovers after an unclean exit,
  // but never let a rejected second instance erase the active instance's cache.
  fs.rmSync(selectionCachePath, { recursive: true, force: true })
  fs.mkdirSync(selectionCachePath, { recursive: true })
}
const contextMenuKey = 'HKCU\\Software\\Classes\\*\\shell\\Raid'
const pendingOpenPaths = []
const repositoryUrl = 'https://github.com/lxymol/Reading-Assistant'
const latestReleaseApiUrl = 'https://api.github.com/repos/lxymol/Reading-Assistant/releases/latest'
let updateCheckCache = null

function compareVersions(left, right) {
  const parts = (value) => String(value || '').trim().replace(/^v/i, '').split(/[+-]/, 1)[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const leftParts = parts(left)
  const rightParts = parts(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

async function checkForUpdates(force = false) {
  const currentVersion = app.getVersion()
  const base = { currentVersion, author: 'xyLee', repositoryUrl }
  if (!force && updateCheckCache && Date.now() - updateCheckCache.checkedAt < 15 * 60 * 1000) return updateCheckCache
  try {
    const response = await net.fetch(latestReleaseApiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Raid/${currentVersion}` },
    })
    if (!response.ok) throw new Error(`GitHub ${response.status}`)
    const release = await response.json()
    const latestVersion = String(release?.tag_name || '').trim().replace(/^v/i, '')
    if (!/^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(latestVersion)) throw new Error('Invalid release version')
    const releaseUrl = typeof release?.html_url === 'string' && release.html_url.startsWith(`${repositoryUrl}/releases/`) ? release.html_url : `${repositoryUrl}/releases/latest`
    updateCheckCache = { ...base, latestVersion, releaseUrl, updateAvailable: compareVersions(latestVersion, currentVersion) > 0, checkedAt: Date.now() }
  } catch {
    updateCheckCache = { ...base, releaseUrl: `${repositoryUrl}/releases/latest`, updateAvailable: false, checkedAt: Date.now(), error: 'UPDATE_CHECK_FAILED' }
  }
  return updateCheckCache
}

function candidateOpenPaths(argv) {
  return argv.filter((value) => typeof value === 'string' && !value.startsWith('-')).map((value) => path.resolve(value)).filter((value) => fs.existsSync(value) && fs.statSync(value).isFile())
}
pendingOpenPaths.push(...candidateOpenPaths(process.argv.slice(1)))

function openFilePayload(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const type = extension === '.pdf' ? 'application/pdf' : ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif'].includes(extension) ? `image/${extension === '.jpg' ? 'jpeg' : extension.slice(1)}` : 'application/octet-stream'
  const stats = fs.statSync(filePath)
  return { name: path.basename(filePath), type, lastModified: stats.mtimeMs, data: new Uint8Array(fs.readFileSync(filePath)) }
}

async function quickOpenEnabled() {
  if (process.platform !== 'win32') return false
  try { await execFileAsync('reg.exe', ['QUERY', contextMenuKey]); return true } catch { return false }
}

async function setQuickOpenEnabled(enabled) {
  if (process.platform !== 'win32') return false
  if (!enabled) {
    try { await execFileAsync('reg.exe', ['DELETE', contextMenuKey, '/f']) } catch { /* Already disabled. */ }
    return false
  }
  await execFileAsync('reg.exe', ['ADD', contextMenuKey, '/ve', '/d', '使用 Raid 打开', '/f'])
  const command = app.isPackaged ? `"${process.execPath}" "%1"` : `"${process.execPath}" "${applicationDirectory}" "%1"`
  await execFileAsync('reg.exe', ['ADD', `${contextMenuKey}\\command`, '/ve', '/d', command, '/f'])
  return true
}

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

const storageOptions = { projectsDataPath, dataManifestPath, storageSchemaVersion, appVersion: app.getVersion() }
createProjectStorage(storageOptions).initialize()
const projectStorage = new ProjectStorageClient(storageOptions, logStartup)

async function maintainCachesOnExit() {
  await projectStorage.close()
  await session.defaultSession.clearData({ dataTypes: ['indexedDB'] }).catch(() => undefined)
  // Performance caches are deliberately retained: Chromium enforces the size
  // limits above, while keeping them warm avoids a cold start after every exit.
  fs.rmSync(conversionCachePath, { recursive: true, force: true })
  fs.mkdirSync(conversionCachePath, { recursive: true })
  fs.rmSync(selectionCachePath, { recursive: true, force: true })
  fs.mkdirSync(selectionCachePath, { recursive: true })
}

const selectionCacheFile = (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Error('INVALID_SELECTION_CACHE_ID')
  return path.join(selectionCachePath, `${id}.jpg`)
}

async function storeSelectionImage(payload) {
  if (!payload || payload.data == null || payload.mime !== 'image/jpeg') throw new Error('INVALID_SELECTION_IMAGE')
  const data = Buffer.from(payload.data)
  if (!data.length || data.length > 64 * 1024 * 1024) throw new Error('INVALID_SELECTION_IMAGE_SIZE')
  const id = randomUUID()
  await fs.promises.writeFile(selectionCacheFile(id), data)
  return { id, byteLength: data.length }
}

async function readSelectionImage(id) {
  const filePath = selectionCacheFile(id)
  try { return { data: new Uint8Array(await fs.promises.readFile(filePath)), mime: 'image/jpeg' } } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function deleteSelectionImages(ids) {
  if (!Array.isArray(ids)) return false
  await Promise.all(Array.from(new Set(ids)).map(async (id) => {
    try { await fs.promises.rm(selectionCacheFile(id), { force: true }) } catch { /* Ignore stale or invalid cache references. */ }
  }))
  return true
}

ipcMain.handle('reading-assistant:select-skill-folder', () => selectImportFolder('skill'))
ipcMain.handle('reading-assistant:select-language-folder', () => selectImportFolder('language'))
ipcMain.handle('reading-assistant:convert-document', (_event, payload) => convertDocument(payload))
ipcMain.handle('reading-assistant:list-projects', () => projectStorage.call('listProjectSummaries'))
ipcMain.handle('reading-assistant:get-project', (_event, id, lightweight, indexFileId) => projectStorage.call('readProjectRecord', id, lightweight, indexFileId))
ipcMain.handle('reading-assistant:retrieve-project-context', (_event, id, query, options) => projectStorage.call('retrieveStoredProjectContext', id, query, options))
ipcMain.handle('reading-assistant:save-project', (_event, payload) => projectStorage.call('saveProjectRecord', payload))
ipcMain.handle('reading-assistant:get-project-file-source', (_event, projectId, fileId) => projectStorage.call('getProjectFileSource', projectId, fileId))
ipcMain.handle('reading-assistant:save-project-file-source', (_event, payload) => projectStorage.call('saveProjectFileSource', payload))
ipcMain.handle('reading-assistant:delete-project', (_event, id) => projectStorage.call('deleteProjectRecord', id))
ipcMain.handle('reading-assistant:delete-project-file', (_event, projectId, fileId) => projectStorage.call('deleteProjectFile', projectId, fileId))
ipcMain.handle('reading-assistant:open-external', async (_event, value) => {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('Only HTTPS links may be opened externally.')
  await shell.openExternal(url.href)
  return true
})
ipcMain.handle('reading-assistant:get-quick-open-enabled', () => quickOpenEnabled())
ipcMain.handle('reading-assistant:set-quick-open-enabled', (_event, enabled) => setQuickOpenEnabled(Boolean(enabled)))
ipcMain.handle('reading-assistant:check-for-updates', (_event, force) => checkForUpdates(Boolean(force)))
ipcMain.handle('reading-assistant:store-selection-image', (_event, payload) => storeSelectionImage(payload))
ipcMain.handle('reading-assistant:read-selection-image', (_event, id) => readSelectionImage(id))
ipcMain.handle('reading-assistant:delete-selection-images', (_event, ids) => deleteSelectionImages(ids))
ipcMain.handle('reading-assistant:take-pending-open-files', () => pendingOpenPaths.splice(0).flatMap((filePath) => { try { return [openFilePayload(filePath)] } catch { return [] } }))
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
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  const trustedSender = senderWindow && mainWindow && !senderWindow.isDestroyed()
    && (senderWindow === mainWindow || senderWindow.getParentWindow() === mainWindow)
  if (!trustedSender) return
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
  app.on('second-instance', (_event, argv) => {
    const paths = candidateOpenPaths(argv.slice(1))
    for (const filePath of paths) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('reading-assistant:open-file', openFilePayload(filePath)) } catch { pendingOpenPaths.push(filePath) }
      } else pendingOpenPaths.push(filePath)
    }
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
  if (exitCacheCleanupComplete) return
  event.preventDefault()
  if (exitCacheCleanupStarted) return
  exitCacheCleanupStarted = true
  void maintainCachesOnExit().catch((error) => logStartup(`Exit cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
    exitCacheCleanupComplete = true
    app.quit()
  })
})
