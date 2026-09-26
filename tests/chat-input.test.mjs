import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { streamChatCompletions } from '../server/chat-completions.mjs'
import { buildChatInput, createAnswerFilter } from '../server/chat-input.mjs'
import { createAttachmentHandler } from '../server/attachment-tools.mjs'

test('Normal questions preserve the actual prompt and complete supplied text', () => {
  assert.equal(buildChatInput({ action: 'custom', instruction: 'What is 2 + 2?' }), 'What is 2 + 2?')
  const selectedText = 'x'.repeat(100000) + 'LAST-PARAGRAPH'
  const prompt = buildChatInput({ action: 'custom', instruction: 'What does the last paragraph mean?', selectedText })
  assert.ok(prompt.includes(selectedText))
  assert.ok(!prompt.includes('论文阅读助教'))
  assert.ok(!prompt.includes('必须基于材料'))
})

test('Leading reasoning tags are hidden even when tags split across stream chunks', () => {
  const filter = createAnswerFilter()
  const source = '<think>Private reasoning</think>\n<analysis>More process</analysis>Answer 中文'
  let output = ''
  for (const character of source) output += filter(character)
  output += filter('', true)
  assert.equal(output, 'Answer 中文')
  const plain = createAnswerFilter()
  assert.equal(plain('Use `<think>` as literal text.'), 'Use `<think>` as literal text.')
  const unfinished = createAnswerFilter()
  assert.equal(unfinished('<think>incomplete') + unfinished('', true), '')
})

test('Attachment tools read the whole file in bounded UTF-8 chunks and reject arbitrary paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-attachment-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const content = '中文🙂 '.repeat(20000) + 'UNIQUE-FINAL-MARKER'
  const filename = path.join(directory, 'source.txt')
  fs.writeFileSync(filename, content)
  const handler = createAttachmentHandler([{ id: 'paper', name: 'paper.txt', path: filename, byteLength: Buffer.byteLength(content) }], directory, true)
  let offset = 0
  let reconstructed = ''
  while (true) {
    const result = await handler('read_attachment', { id: 'paper', offset, limit: 1601 })
    reconstructed += result.text
    assert.ok(result.nextOffset > offset)
    offset = result.nextOffset
    if (result.eof) break
  }
  assert.equal(reconstructed, content)
  const result = await handler('search_attachments', { query: 'UNIQUE-FINAL-MARKER' })
  assert.equal(result.hits.length, 1)
  assert.ok(result.hits[0].offset > 200000)
  await assert.rejects(handler('read_attachment', { id: filename }), /arbitrary file paths/)
  await assert.rejects(handler('create_text_file', { name: '../outside.txt', content: 'bad' }), /plain filename/)
  await assert.rejects(handler('create_text_file', { name: 'CON.txt', content: 'bad' }), /plain filename/)
  await handler('create_text_file', { name: 'notes.md', content: '# Note' })
  assert.equal(fs.readFileSync(path.join(directory, 'notes.md'), 'utf8'), '# Note')
})


test('API streams release resources and reject interrupted, malformed and failed answers', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  for (const [ending, expectedError] of [
    ['data: [DONE]', null],
    ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', null],
    ['', /完成前中断/],
    ['data: {"error":{"message":"quota exhausted"}}', /quota exhausted/],
    ['data: {"choices":[{"finish_reason":"length"}]}', /长度限制/],
    ['data: not-json', /无效/],
  ]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' + ending + '\n\n'))
        controller.close()
      },
    })
    globalThis.fetch = async () => new Response(body)
    let streamed = ''
    const request = streamChatCompletions({ apiKey: '', baseUrl: '', model: '', messages: [], onDelta: (text) => { streamed += text } })
    if (expectedError) await assert.rejects(request, expectedError)
    else assert.equal(await request, 'Answer')
    assert.equal(streamed, 'Answer')
    assert.equal(body.locked, false)
  }
})
