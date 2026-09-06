import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createProjectStorage } from '../electron/project-storage.mjs'
import { ProjectStorageClient } from '../electron/project-storage-client.mjs'
import { groundCitationTags, stripCitationTags } from '../server/citations.mjs'

test('combination answers remove all internal source tags while document answers retain valid references', () => {
  const answer = '结论。[[REF:1]] [[PAGE:2]] [[SOURCE:3|paper.pdf]]'
  assert.equal(stripCitationTags(answer), '结论。')
  assert.equal(groundCitationTags(answer, [{ number: 1 }]), '结论。[[REF:1]]')
})

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

test('selective reads load one index and partial saves preserve unloaded indexes', (t) => {
  const { storage, record } = fixture(t)
  const second = { ...record.files[0], id: 'second', name: 'second.pdf', paragraphs: [{ text: 'Second evidence' }] }
  storage.saveProjectRecord({ ...record, files: [...record.files, second] })
  const selective = storage.readProjectRecord('project', false, 'file')
  assert.equal(selective.files[0].indexLoaded, true)
  assert.equal(selective.files[1].indexLoaded, false)
  assert.deepEqual(selective.files[1].paragraphs, [])
  selective.files[1].readingState = { page: 8, zoom: 1 }
  storage.saveProjectRecord(selective)
  const restored = storage.readProjectRecord('project')
  assert.deepEqual(restored.files[1].paragraphs, second.paragraphs)
  assert.deepEqual(restored.files[1].readingState, { page: 8, zoom: 1 })
})

test('stored combination retrieval returns bounded context from multiple files', (t) => {
  const { storage, record } = fixture(t)
  const second = { ...record.files[0], id: 'second', name: 'second.pdf', paragraphs: [{ id: 'p2', page: 2, order: 0, text: 'graph benchmark result' }] }
  const first = { ...record.files[0], paragraphs: [{ id: 'p1', page: 1, order: 0, text: 'graph method evidence' }] }
  storage.saveProjectRecord({ ...record, files: [first, second] })
  const result = storage.retrieveStoredProjectContext('project', 'graph benchmark', { maxHits: 4, maxCharacters: 1000 })
  assert.equal(result.hitCount, 2)
  assert.match(result.context, /paper\.pdf/)
  assert.match(result.context, /second\.pdf/)
  assert.ok(result.context.length <= 1000)
})

test('stored combination retrieval maps every paper and reserves evidence beyond opening paragraphs', (t) => {
  const { storage, record } = fixture(t)
  const files = Array.from({ length: 10 }, (_, fileIndex) => ({
    ...record.files[0], id: `file-${fileIndex}`, name: `paper-${fileIndex}.pdf`,
    paragraphs: [
      { id: `${fileIndex}-abstract`, fileId: `file-${fileIndex}`, page: 1, order: 0, text: 'ABSTRACT' },
      { id: `${fileIndex}-method`, fileId: `file-${fileIndex}`, page: 4, order: 1, text: `METHODS approach ${fileIndex}` },
      { id: `${fileIndex}-result`, fileId: `file-${fileIndex}`, page: 8, order: 2, text: `RESULTS benchmark signal ${fileIndex}` },
      { id: `${fileIndex}-limit`, fileId: `file-${fileIndex}`, page: 10, order: 3, text: `LIMITATIONS cohort ${fileIndex}` },
    ],
  }))
  storage.saveProjectRecord({ ...record, files })
  const result = storage.retrieveStoredProjectContext('project', 'benchmark signal', { maxHits: 64, maxCharacters: 30000 })
  for (let index = 0; index < files.length; index += 1) assert.match(result.context, new RegExp(`paper-${index}\\.pdf`))
  assert.match(result.context, /METHODS approach 9/)
  assert.match(result.context, /RESULTS benchmark signal 9/)
  assert.match(result.context, /LIMITATIONS cohort 9/)
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
