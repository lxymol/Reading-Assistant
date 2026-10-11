import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../server/index.mjs'
import { ProjectStorageClient } from '../electron/project-storage-client.mjs'

test('AI route sends ordinary multimodal prompts and complete multi-file attachments through the worker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-ai-route-'))
  const storage = new ProjectStorageClient({ projectsDataPath: path.join(root, 'projects'), dataManifestPath: path.join(root, 'manifest.json'), appVersion: 'test' })
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const content of ['<thi', 'nk>Hidden process', '</think>\n', 'Final answer']) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const { server, port } = await startServer(0, { documentStorage: storage, selectionImageReader: async () => ({ data: Buffer.from('old image'), mime: 'image/jpeg' }) })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
    await storage.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const aiConfig = { provider: 'api', apiKey: 'test-key', model: 'test-model', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }
  const send = async (payload) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'custom', aiConfig, ...payload }) })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return text.trim().split('\n').map((line) => JSON.parse(line))
  }
  const image = 'data:image/png;base64,AA=='
  const events = await send({ instruction: 'What does this mean?', selectedText: 'Selected text', selectionImages: [image], history: [{ role: 'user', content: 'Earlier question', attachmentIds: ['earlier'] }, { role: 'assistant', content: 'Earlier answer' }], skills: [{ id: 's', name: 'Unused skill', command: 'unused', instructions: 'Force a different answer.' }] })
  assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.delta).join(''), 'Final answer')
  assert.equal(events.at(-1).content, 'Final answer')
  const request = requests[0]
  assert.equal(request.messages.at(-1).content[1].image_url.url, image)
  assert.equal(request.messages[1].content, 'Earlier question', 'Historical images must never be resubmitted')
  assert.equal(request.messages.at(-1).content[0].text, 'What does this mean?\n\n<selected_text>\nSelected text\n</selected_text>')
  assert.equal('temperature' in request, false)
  assert.equal(requests.length, 1, 'An unrequested skill changed the ordinary conversation')

  const files = ['first', 'second'].map((id) => ({ id, projectId: 'project', name: `${id}.txt`, kind: 'text', annotations: [], paragraphs: [], indexState: { status: 'ready' } }))
  await storage.call('saveProjectRecord', { id: 'project', files, conversations: [], updatedAt: 1 })
  for (const file of files) await storage.call('saveProjectFileSource', { projectId: 'project', fileId: file.id, data: Buffer.from('Body '.repeat(20000) + `FINAL-${file.id}`) })
  await send({ contextMode: 'combination', instruction: 'Compare the last section of both files.', documentSource: { projectId: 'project', fileIds: ['first', 'second'] } })
  const fullInput = requests.at(-1).messages.at(-1).content
  assert.ok(fullInput.includes('FINAL-first'))
  assert.ok(fullInput.includes('FINAL-second'))
  assert.ok(fullInput.length > 200000, 'The combination was truncated to an excerpt')

  await storage.call('saveProjectFileSource', { projectId: 'project', fileId: 'first', data: Buffer.from('x'.repeat(310000)) })
  const response = await fetch(`http://127.0.0.1:${port}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'custom', aiConfig, contextMode: 'document', instruction: 'Summarize.', documentSource: { projectId: 'project', fileIds: ['first'] } }) })
  assert.equal(response.status, 502)
  assert.match((await response.json()).error, /未截断/)
  assert.equal(requests.length, 2, 'Oversized full text must not be silently truncated and submitted')
  await send({ instruction: 'Explain the earlier image again.', history: [{ role: 'user', content: 'Earlier figure', attachmentIds: ['stored'] }], aiConfig: { ...aiConfig, visionEnabled: true, visionModel: 'vision-model' } })
  assert.equal(requests.at(-1).model, 'test-model', 'Text follow-ups must not use the vision model for historical images')
  assert.equal(requests.at(-1).messages[1].content, 'Earlier figure')

})
