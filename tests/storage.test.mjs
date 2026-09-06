import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createProjectStorage } from '../electron/project-storage.mjs'
import { ProjectStorageClient } from '../electron/project-storage-client.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-storage-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = { projectsDataPath: path.join(root, 'projects'), dataManifestPath: path.join(root, 'manifest.json'), appVersion: 'test' }
  fs.mkdirSync(options.projectsDataPath)
  const storage = createProjectStorage(options)
  storage.initialize()
  const record = {
    id: 'project', name: 'Research', updatedAt: 1, activeFileId: 'file',
    conversations: [{ id: 'chat', history: [{ role: 'assistant', content: 'Answer' }] }], tags: [],
    files: [{ id: 'file', projectId: 'project', name: 'paper.pdf', indexState: { status: 'ready' }, paragraphs: [{ text: 'Evidence' }], highlights: [], annotations: [] }],
  }
  const hash = (id) => createHash('sha256').update(id).digest('hex')
  const directory = path.join(options.projectsDataPath, hash(record.id))
  const fileDirectory = path.join(directory, 'files', hash('file'))
  return { options, storage, record, directory, fileDirectory }
}

test('v2 storage round-trips records and binary sources; lightweight reads omit heavy data', (t) => {
  const { storage, record, fileDirectory } = fixture(t)
  storage.saveProjectRecord(record)
  assert.deepEqual(storage.readProjectRecord('project'), record)
  storage.saveProjectFileSource({ projectId: 'project', fileId: 'file', data: new Uint8Array([0, 128, 255]).buffer })
  assert.deepEqual(storage.getProjectFileSource('project', 'file'), new Uint8Array([0, 128, 255]))
  assert.equal(storage.listProjectSummaries()[0].fileCount, 1)
  // A lightweight sidebar load must never open the paragraph index.
  fs.writeFileSync(path.join(fileDirectory, 'index.json'), 'intentionally unreadable')
  const overview = storage.readProjectRecord('project', true)
  assert.deepEqual(overview.files[0].paragraphs, [])
  assert.deepEqual(overview.conversations[0].history, [])
  assert.equal(overview.files[0].indexState.status, 'ready')
})

test('reading-position saves preserve unchanged indexes across cache misses and detect changed contents', (t) => {
  const { storage, options, record, fileDirectory } = fixture(t)
  storage.saveProjectRecord(record)
  const indexPath = path.join(fileDirectory, 'index.json')
  const oldTime = new Date('2001-01-01')
  fs.utimesSync(indexPath, oldTime, oldTime)
  const before = fs.statSync(indexPath).mtimeMs
  const fresh = createProjectStorage(options)
  record.files[0].readingState = { page: 2, zoom: 1.2 }
  fresh.saveProjectRecord(record)
  fresh.saveProjectRecord(record)
  assert.equal(fs.statSync(indexPath).mtimeMs, before)
  record.files[0].paragraphs = [{ text: 'New evidence' }]
  fresh.saveProjectRecord(record)
  assert.deepEqual(fresh.readProjectRecord('project').files[0].paragraphs, record.files[0].paragraphs)
  fs.writeFileSync(indexPath, '{}')
  fresh.saveProjectRecord(record)
  assert.deepEqual(fresh.readProjectRecord('project').files[0].paragraphs, record.files[0].paragraphs)
})

test('invalid files are rejected before any saved data changes and deletes can be followed by recreation', (t) => {
  const { storage, record, directory } = fixture(t)
  storage.saveProjectRecord(record)
  const before = fs.readFileSync(path.join(directory, 'project.json'), 'utf8')
  assert.throws(() => storage.saveProjectRecord({ ...record, files: [...record.files, { id: 'wrong', projectId: 'other' }] }), /INVALID_PROJECT_FILE/)
  assert.equal(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'), before)
  storage.deleteProjectRecord('project')
  assert.equal(storage.readProjectRecord('project'), null)
  storage.saveProjectRecord(record)
  assert.deepEqual(storage.readProjectRecord('project'), record)
})

test('worker preserves write/read/delete order, survives operation errors and drains before closing', async (t) => {
  const { options, storage, record } = fixture(t)
  const client = new ProjectStorageClient(options)
  try {
    const writes = Array.from({ length: 12 }, (_, updatedAt) => client.call('saveProjectRecord', { ...record, updatedAt }))
    const read = client.call('readProjectRecord', 'project')
    await Promise.all(writes)
    assert.equal((await read).updatedAt, 11)
    await assert.rejects(client.call('saveProjectRecord', null), /INVALID_PROJECT_RECORD/)
    await client.call('saveProjectFileSource', { projectId: 'project', fileId: 'file', data: new Uint8Array([7, 9]).buffer })
    assert.deepEqual(await client.call('getProjectFileSource', 'project', 'file'), new Uint8Array([7, 9]))
    const deletion = client.call('deleteProjectRecord', 'project')
    const afterDeletion = client.call('readProjectRecord', 'project')
    await deletion
    assert.equal(await afterDeletion, null)
    const finalWrite = client.call('saveProjectRecord', { ...record, updatedAt: 99 })
    await client.close()
    await finalWrite
    assert.equal(storage.readProjectRecord('project').updatedAt, 99)
    await assert.rejects(client.call('readProjectRecord', 'project'), /closing|exited/)
  } finally { await client.close() }
})
