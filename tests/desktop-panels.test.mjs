import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const filename = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(filename), '..')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(message)
}

if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron')
  // Electron waits for the entry module to finish before emitting ready.
  void (async () => {
    const created = new Promise((resolve) => app.once('browser-window-created', (_event, window) => resolve(window)))
    await import('../electron/main.mjs')
    try {
      const main = await created
      await waitFor(() => main.webContents.executeJavaScript("Boolean(document.querySelector('.panel-projects'))"), 'Main interface did not load')
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await main.webContents.executeJavaScript(`localStorage.setItem('reading-assistant-panel-layouts', JSON.stringify({ projects: { open: true, dock: 'float', x: 250, y: 150, width: 340, height: 560 } }))`)
        main.webContents.reload()
        let panel
        await waitFor(async () => {
          panel = BrowserWindow.getAllWindows().find((window) => window !== main && !window.isDestroyed() && window.webContents.getURL() === 'about:blank')
          return panel && await panel.webContents.executeJavaScript("Boolean(document.querySelector('.workspace-panel-header') && window.readingAssistant?.movePanelWindow)")
        }, 'Floating panel did not load')
        assert.equal(panel.getParentWindow(), null, 'Panel must remain independent of the main window')
        await panel.webContents.executeJavaScript("document.querySelector('button[title=\"置顶\"]').click()")
        await waitFor(() => panel.isAlwaysOnTop(), 'Pin did not keep the floating window on top')
        await waitFor(() => panel.webContents.executeJavaScript("Boolean(document.querySelector('button[title=\"取消置顶\"]'))"), 'Pin state did not update')
        await panel.webContents.executeJavaScript("document.querySelector('button[title=\"取消置顶\"]').click()")
        await waitFor(() => !panel.isAlwaysOnTop(), 'Unpin did not restore normal window stacking')
        await delay(400)
        const before = panel.getBounds()
        // Windows can report a different Chromium origin because of invisible frame borders.
        const origin = await panel.webContents.executeJavaScript('({x: screenX, y: screenY})')
        await panel.webContents.executeJavaScript(`(() => {
          const header = document.querySelector('.workspace-panel-header')
          // Synthetic pointers have no native capture ID; retain all real React handlers and IPC.
          header.setPointerCapture = () => {}
          header.hasPointerCapture = () => false
          window.testPanelPointer = (type, dx = 0, dy = 0) => header.dispatchEvent(new PointerEvent(type, {
            bubbles: true, button: 0, pointerId: 1,
            screenX: ${before.x + 80} + dx, screenY: ${before.y + 20} + dy, clientX: 80, clientY: 20,
          }))
          window.testPanelPointer('pointerdown')
        })()`)
        for (const [dx, dy] of [[35, 20], [90, 55], [140, 80]]) {
          await panel.webContents.executeJavaScript(`window.testPanelPointer('pointermove', ${dx}, ${dy})`)
          await waitFor(() => {
            const bounds = panel.getBounds()
            return bounds.x === origin.x + dx && bounds.y === origin.y + dy
          }, 'Floating panel did not move before releasing the pointer')
          const bounds = panel.getBounds()
          assert.equal(bounds.width, before.width, 'Dragging changed panel width')
          assert.equal(bounds.height, before.height, 'Dragging changed panel height')
        }
        await waitFor(() => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith('data:text/html')).length === 2, 'Dock-zone windows did not load')
        const zones = BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith('data:text/html'))
        assert.ok(zones.every((zone) => zone.getParentWindow() === main && !zone.isAlwaysOnTop()), 'Dock hints must belong to the reader without global topmost flags')
        assert.equal(zones.length, 2, 'Floating-panel drag did not activate dock zones')
        await panel.webContents.executeJavaScript("window.testPanelPointer('pointerup', 140, 80)")
        await waitFor(() => zones.every((window) => !window.isVisible()), 'Dock zones stayed visible after dragging')
        await waitFor(async () => {
          const saved = await main.webContents.executeJavaScript("JSON.parse(localStorage.getItem('reading-assistant-panel-layouts')).projects")
          const reported = await panel.webContents.executeJavaScript('({x: screenX, y: screenY})')
          return (saved.x === origin.x + 140 || saved.x === reported.x)
            && saved.y === origin.y + 80
        }, 'Final floating-panel position was not saved')
        await panel.webContents.executeJavaScript("document.querySelector('button[title=\"停靠到左侧\"]').click()")
        await waitFor(() => panel.isDestroyed(), 'Docking left did not close the native panel')
        await waitFor(() => main.webContents.executeJavaScript("Boolean(document.querySelector('.panel-projects.dock-left'))"), 'Panel did not reappear in the main window')
        assert.equal(main.isMinimized(), false, 'Closing a floating panel minimized the main window')
        assert.equal(BrowserWindow.getAllWindows().length, 3, 'Native panels accumulated after docking')
      }
      // An unrelated window must not gain panel privileges just because it has the preload.
      const unrelated = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, 'electron', 'preload.cjs') } })
      await unrelated.loadURL('about:blank')
      const before = unrelated.getBounds()
      await unrelated.webContents.executeJavaScript("window.readingAssistant.movePanelWindow('projects', 20, 20); window.readingAssistant.setDockZones(true, 'left'); window.readingAssistant.setPanelOnTop(true)")
      await delay(150)
      assert.equal(unrelated.isAlwaysOnTop(), false, 'An unregistered window gained pin privileges')
      assert.deepEqual(unrelated.getBounds(), before, 'An unregistered window was allowed to use panel IPC')
      assert.equal(BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith('data:text/html')).every((window) => !window.isVisible()), true, 'An unregistered window activated dock zones')
      const generated = await main.webContents.executeJavaScript(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        const data = await blob.arrayBuffer()
        const stored = await window.readingAssistant.storeGeneratedImage({ data, thumbnail: data })
        const image = await window.readingAssistant.readSelectionImage(stored.id)
        const thumb = await window.readingAssistant.readSelectionImage(stored.id, true)
        await window.readingAssistant.deleteStoredSelectionImages([stored.id])
        const removed = await window.readingAssistant.readSelectionImage(stored.id)
        return { mime: image.mime, bytes: image.data.length, thumbnail: thumb.data.length, removed }
      })()`)
      assert.equal(generated.mime, 'image/png')
      assert.ok(generated.bytes > 0 && generated.thumbnail > 0)
      assert.equal(generated.removed, null)
      unrelated.destroy()
      await main.webContents.executeJavaScript("window.open('', 'reading-assistant-panel-cleanup', 'popup=yes,width=340,height=560'); void 0")
      const remainingPanel = BrowserWindow.getAllWindows().find((window) => window !== main && window.webContents.getURL() === 'about:blank')
      assert.ok(remainingPanel, 'Cleanup test panel did not open')
      main.destroy()
      assert.equal(remainingPanel.isDestroyed(), true, 'Closing the main window left a floating panel alive')
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'Native windows remained after closing the reader')
      console.log('RAID_PANEL_PASS live-drag size-preservation dock-zones persistence repeated-docking sender-validation main-close-cleanup')
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally { app.quit() }
  })()
} else {
  const { default: electronPath } = await import('electron')
  const temporaryRoot = path.join(root, 'node_modules', '.tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  const directory = mkdtempSync(path.join(temporaryRoot, 'raid-panels-'))
  const environment = { ...process.env, RAID_MEMORY_SMOKE_DIR: path.join(directory, 'profile') }
  delete environment.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [filename, '--panel-smoke'], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timeout = setTimeout(() => child.kill(), 40_000)
    child.stdout.on('data', (data) => { output += data; process.stdout.write(data) })
    child.stderr.on('data', (data) => process.stderr.write(data))
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    clearTimeout(timeout)
    assert.equal(code, 0, 'Desktop panel regression failed')
    assert.ok(output.includes('RAID_PANEL_PASS'), 'Desktop panel regression did not complete')
  } finally {
    const resolved = path.resolve(directory)
    assert.ok(resolved.startsWith(`${path.resolve(temporaryRoot)}${path.sep}`), 'Unsafe panel-test cleanup target')
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
