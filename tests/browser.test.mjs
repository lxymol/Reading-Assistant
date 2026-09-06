import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Run with Node and a Chromium browser; uses only a disposable profile.
const browserPath = process.env.RAID_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-browser-test-'))
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let server, browser, socket
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let launchError
  browser.on('error', error => { launchError = error })
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; !fs.existsSync(portFile); i++) {
    if (launchError) throw launchError
    if (i >= 100) throw new Error('Browser startup timed out')
    await pause(100)
  }
  const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)
  socket = new WebSocket('ws://127.0.0.1:' + port + endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let nextId = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  }
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')) }, 20000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await call('Target.createTarget', { url: server.resolvedUrls.local[0] })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  await call('Runtime.enable', {}, sessionId)
  const result = await call('Runtime.evaluate', { expression: `(async () => {
    const check = (value, message) => { if (!value) throw new Error(message) }
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw new Error('UI did not become ready')
    }
    await waitFor(() => document.querySelector('.empty-reader'))
    check(document.querySelector('.workspace'), 'Workspace missing')
    const { ProjectRepository } = await import('/src/services/projectRepository.ts')
    const repository = new ProjectRepository()
    const project = { id: 'browser-test', name: 'Test', files: [{ id: 'source', projectId: 'browser-test', name: 'test.txt', paragraphs: [] }], conversations: [], tags: [], updatedAt: 1 }
    const originalTransaction = IDBDatabase.prototype.transaction
    let committed = false
    IDBDatabase.prototype.transaction = function(...args) {
      const transaction = originalTransaction.apply(this, args)
      if (args[1] === 'readwrite') transaction.addEventListener('complete', () => { committed = true })
      return transaction
    }
    try { await repository.save(project) } finally { IDBDatabase.prototype.transaction = originalTransaction }
    check(committed, 'Save resolved before transaction committed')
    await repository.saveSource(project.id, 'source', new File(['Source text'], 'test.txt', { type: 'text/plain' }))
    check((await repository.get(project.id)).name === 'Test', 'Project round-trip failed')
    check(await (await repository.getSource(project.id, 'source', 'text/plain')).text() === 'Source text', 'Source round-trip failed')

    let opens = 0
    const originalOpen = indexedDB.open.bind(indexedDB)
    indexedDB.open = (...args) => { opens++; return originalOpen(...args) }
    try { await Promise.all([repository.get(project.id), repository.list(), repository.get(project.id)]) }
    finally { indexedDB.open = originalOpen }
    check(opens === 0, 'Database connection was not reused')

    // Abort after the write request succeeds; save must reject and roll back.
    IDBDatabase.prototype.transaction = function(...args) {
      const transaction = originalTransaction.apply(this, args)
      if (args[1] === 'readwrite') {
        const originalStore = transaction.objectStore.bind(transaction)
        transaction.objectStore = (name) => {
          const store = originalStore(name)
          const put = store.put.bind(store)
          store.put = (...values) => { const request = put(...values); request.addEventListener('success', () => transaction.abort()); return request }
          return store
        }
      }
      return transaction
    }
    let rejected = false
    try { await repository.save({ ...project, name: 'Must roll back' }) } catch { rejected = true }
    finally { IDBDatabase.prototype.transaction = originalTransaction }
    check(rejected, 'Aborted write did not reject')
    check((await repository.get(project.id)).name === 'Test', 'Aborted write changed data')
    await repository.deleteProject(project.id)
    check(await repository.get(project.id) === null, 'Project deletion failed')
    check(await repository.getSource(project.id, 'source', 'text/plain') === null, 'Source deletion failed')

    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), value => value.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'conversation-test.png', { type: 'image/png' }))
    const input = document.querySelector('.empty-library-add input')
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => document.querySelector('.library-file'))
    check(!document.querySelector('.file-chat-count'), 'Import created an empty conversation')
    document.querySelector('button[title="对话"]').click()
    await waitFor(() => document.querySelector('button[title="新对话"]'))
    document.querySelector('button[title="新对话"]').click()
    check(!document.querySelector('.file-chat-count'), 'New conversation draft was persisted before sending')

    const originalFetch = window.fetch
    window.fetch = async (url, options) => String(url).endsWith('/api/ai')
      ? new Response('{"type":"done","content":"Done"}\\n', { status: 200 })
      : originalFetch(url, options)
    const prompt = document.querySelector('.prompt-box textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Hello')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    document.querySelector('.prompt-box button').click()
    await waitFor(() => document.querySelector('.file-chat-count')?.textContent === '1')
    window.fetch = originalFetch
    return { ui: 'workspace and lazy conversation creation passed', storage: 'round-trip, commit, rollback, connection reuse, cascade deletion passed' }
  })()`, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  console.log(JSON.stringify(result.result.value))
  const screenshot = await call('Page.captureScreenshot', {}, sessionId)
  fs.writeFileSync('node_modules/.tmp/browser-smoke.png', Buffer.from(screenshot.data, 'base64'))
  await call('Browser.close')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  socket?.close()
  browser?.kill()
  await server?.close()
  await pause(500)
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
  catch { console.warn('Temporary browser profile is still locked: ' + profile) }
}
