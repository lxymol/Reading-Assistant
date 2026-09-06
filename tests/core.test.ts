import assert from 'node:assert/strict'
import test from 'node:test'
import { NavigationService } from '../src/services/navigationService.ts'
import { RetrievalService } from '../src/services/retrievalService.ts'
import { createReferences, validateReference } from '../src/services/citationService.ts'
import { createTag, tagsWithoutFile } from '../src/services/tagStore.ts'
import { inlineCitationsToMarkdown, referenceNumberFromHref } from '../src/services/inlineCitation.ts'
import { analyzePageLayout } from '../src/services/layoutAnalyzer.ts'
import { normalizeAssistantMath } from '../src/services/markdownMath.ts'
import { boundSelectionPreviews } from '../src/services/selectionImageCache.ts'
import { readAiStream, recentSelectionHistory } from '../src/services/aiResponse.ts'
import { repairClippedWordStart } from '../src/services/textSelection.ts'
import type { CapturedSelection, ChatMessage, DocumentParagraph, ReaderLocation, RuntimeProject } from '../src/types.ts'

test('AI stream preserves split UTF-8, CRLF boundaries and a final event without a newline', async () => {
  const bytes = new TextEncoder().encode('\n{"type":"delta","delta":"中文"}\r\n{"type":"done","content":"中文"}')
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() },
  })
  const deltas: string[] = []
  const done = await readAiStream(new Response(body), (event) => { if (event.type === 'delta') deltas.push(event.delta) })
  assert.equal(deltas.join(''), '中文')
  assert.equal(done.content, '中文')
})

test('AI stream reports HTTP errors, server errors and incomplete responses', async () => {
  await assert.rejects(readAiStream(new Response('{"error":"Unavailable"}', { status: 503 }), () => {}), /Unavailable/)
  await assert.rejects(readAiStream(new Response('{"type":"error","error":"Failed"}\n'), () => {}), /Failed/)
  await assert.rejects(readAiStream(new Response('{"type":"delta","delta":"Partial"}\n'), () => {}), /before completion/)
})

test('selection history retains context boundaries and caps prompts', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', label: '选区', content: 'Excerpt', prompt: 'Explain' },
    { id: '2', role: 'assistant', content: 'Explanation' },
    { id: '3', role: 'user', contextMode: 'document', content: 'Whole document' },
    { id: '4', role: 'assistant', content: 'Document answer' },
    { id: '5', role: 'assistant', citationsDisabled: true, content: 'x'.repeat(5000) },
  ]
  const result = recentSelectionHistory(messages)
  assert.equal(result.length, 3)
  assert.equal(result[0].content, 'Explain\n【当时选区】\nExcerpt')
  assert.equal(result[2].content.length, 4000)
})

test('PDF text selection restores a clipped first letter only at a word boundary', () => {
  assert.equal(repairClippedWordStart('ime consuming', 'Time consuming', 1), 'Time consuming')
  assert.equal(repairClippedWordStart('ransformer', 'A Transformer model', 3), 'Transformer')
  assert.equal(repairClippedWordStart('ansformer', 'A Transformer model', 4), 'ansformer')
  assert.equal(repairClippedWordStart('结果', '研究结果', 2), '结果')
  assert.equal(repairClippedWordStart('word', ' word', 1), 'word')
})

const paragraph = (fileId: string, order: number, text: string): DocumentParagraph => ({
  id: `${fileId}:p${order}`, projectId: 'project', fileId, page: order + 1,
  region: { left: fileId === 'left' ? .08 : .55, top: .1 + order * .1, width: .35, height: .06 },
  text, textHash: `hash-${fileId}-${order}`, order,
})

const project: RuntimeProject = {
  id: 'project', name: 'Research', activeFileId: 'left', activeConversationId: '', conversations: [],
  tags: [], createdAt: 1, updatedAt: 1, hydrated: true,
  files: [
    { id: 'left', projectId: 'project', name: 'method.pdf', kind: 'pdf', type: 'application/pdf', size: 1, lastModified: 1, createdAt: 1, updatedAt: 1, readingState: { page: 1, zoom: 1, scrollTop: 0 }, highlights: [], annotations: [], indexState: { status: 'ready', version: 1 }, paragraphs: [paragraph('left', 0, 'graph neural network message passing method'), paragraph('left', 1, 'training details and optimizer')] },
    { id: 'right', projectId: 'project', name: 'results.pdf', kind: 'pdf', type: 'application/pdf', size: 1, lastModified: 1, createdAt: 1, updatedAt: 1, readingState: { page: 1, zoom: 1, scrollTop: 0 }, highlights: [], annotations: [], indexState: { status: 'ready', version: 1 }, paragraphs: [paragraph('right', 0, 'graph neural network improves benchmark accuracy'), paragraph('right', 1, 'ablation and limitations')] },
  ],
}

test('streaming math remains a math block and drops standalone separator artifacts', () => {
  assert.equal(normalizeAssistantMath('推导：\n$$\na+b\n|'), '推导：\n$$\na+b\n$$')
  assert.equal(normalizeAssistantMath('```text\n$$ unchanged\n```'), '```text\n$$ unchanged\n```')
  assert.equal(normalizeAssistantMath('\\[x^2\\]'), '\n$$\nx^2\n$$\n')
})

test('selection preview budget removes only old thumbnails, not logical selections', () => {
  const selection = (id: string): CapturedSelection => ({
    id, image: id, images: [{ preview: id, cacheId: `${id}-cache` }], page: 1,
    regions: [{ page: 1, region: { left: 0, top: 0, width: 1, height: 1 } }],
    text: id, textParts: [id], loading: false,
  })
  const bounded = boundSelectionPreviews([selection('old'), selection('middle'), selection('new')], 2)
  assert.equal(bounded.length, 3)
  assert.equal(bounded[0].images[0].preview, '')
  assert.equal(bounded[1].images[0].preview, 'middle')
  assert.equal(bounded[2].images[0].preview, 'new')
  assert.equal(bounded[0].images[0].cacheId, 'old-cache')
})

test('navigation records only explicit jumps and supports cross-file backtracking', async () => {
  const service = new NavigationService()
  let current: ReaderLocation = { projectId: 'project', fileId: 'left', page: 1, scrollTop: 120 }
  const apply = async (location: ReaderLocation) => { current = location; return true }
  await service.navigate({ projectId: 'project', fileId: 'right', page: 2 }, () => current, apply)
  await service.navigate({ projectId: 'project', fileId: 'left', page: 3 }, () => current, apply)
  assert.equal(service.depth, 2)
  await service.back(apply)
  assert.deepEqual(current, { projectId: 'project', fileId: 'right', page: 2 })
  await service.back(apply)
  assert.equal(current.scrollTop, 120)
})

test('project retrieval ranks relevant paragraphs, includes file identity and respects budget', () => {
  const result = new RetrievalService().retrieve(project, 'graph neural network accuracy', { maxCharacters: 600, maxHits: 6 })
  assert.ok(result.hits.length >= 2)
  assert.ok(new Set(result.hits.map((hit) => hit.paragraph.fileId)).size >= 2)
  assert.match(result.context, /method\.pdf/)
  assert.match(result.context, /results\.pdf/)
  assert.ok(result.context.length <= 600)
})

test('current-file retrieval never leaks paragraphs from other project files', () => {
  const result = new RetrievalService().retrieve(project, 'graph neural network accuracy', { fileId: 'left', maxHits: 6 })
  assert.ok(result.hits.length > 0)
  assert.ok(result.hits.every((hit) => hit.paragraph.fileId === 'left'))
  assert.doesNotMatch(result.context, /results\.pdf/)
})

test('document retrieval combines whole-file coverage with query-relevant paragraphs', () => {
  const longProject: RuntimeProject = {
    ...project,
    files: [{ ...project.files[0], paragraphs: Array.from({ length: 60 }, (_, index) => paragraph('left', index, index === 31 ? 'unique catalyst result' : `section ${index} background material`)) }],
  }
  const result = new RetrievalService().retrieve(longProject, 'unique catalyst', { fileId: 'left', strategy: 'document', maxHits: 12 })
  const orders = result.hits.map((hit) => hit.paragraph.order)
  assert.ok(orders.includes(0))
  assert.ok(orders.includes(59))
  assert.ok(orders.includes(31))
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
})

test('document retrieval reads every paragraph when the complete paper fits the context budget', () => {
  const result = new RetrievalService().retrieve(project, 'summarize the paper', { fileId: 'left', strategy: 'document', maxHits: 20, maxCharacters: 5000 })
  assert.deepEqual(result.hits.map((hit) => hit.paragraph.order), [0, 1])
  assert.match(result.context, /全文阅读地图/)
  assert.match(result.context, /training details and optimizer/)
})

test('large-document reading map and evidence cover methods, results and limitations beyond the abstract', () => {
  const section = (order: number, text: string) => paragraph('left', order, text)
  const paragraphs = [
    section(0, 'ABSTRACT'), section(1, 'short abstract only'), section(2, '1 INTRODUCTION'), section(3, 'background'),
    section(4, '2 METHODS'), section(5, 'method architecture and training procedure'), section(6, '3 RESULTS'),
    section(7, 'experiment results improve accuracy'), section(8, '4 LIMITATIONS'), section(9, 'limitations include a small cohort'),
  ]
  const longProject = { ...project, files: [{ ...project.files[0], paragraphs }] }
  const result = new RetrievalService().retrieve(longProject, 'summarize', { fileId: 'left', strategy: 'document', maxHits: 9, maxCharacters: 9000 })
  const text = result.hits.map((hit) => hit.paragraph.text).join('\n')
  assert.match(result.overview, /METHODS/)
  assert.match(text, /training procedure/)
  assert.match(text, /improve accuracy/)
  assert.match(text, /small cohort/)
})

test('project retrieval keeps representative evidence from different files', () => {
  const result = new RetrievalService().retrieve(project, 'optimizer', { strategy: 'project', maxHits: 4 })
  assert.deepEqual(new Set(result.hits.map((hit) => hit.paragraph.fileId)), new Set(['left', 'right']))
})

test('structured citations validate paragraph identity instead of inferring from labels', () => {
  const hits = new RetrievalService().retrieve(project, 'benchmark accuracy').hits
  const references = createReferences(project, hits, 3)
  assert.ok(references.length > 0)
  assert.ok(validateReference(project, references[0]))
  assert.equal(validateReference(project, { ...references[0], textHash: 'changed' }), null)
})

test('file deletion cascade helper removes only that file tags', () => {
  const first = createTag('project', 'left', 1, { left: .1, top: .2, width: .02, height: .02 }, 'method')
  const second = createTag('project', 'right', 2, { left: .6, top: .3, width: .02, height: .02 }, 'result')
  assert.deepEqual(tagsWithoutFile([first, second], 'left').map((tag) => tag.id), [second.id])
})

test('PDF indexer preserves title then left-to-right multi-column reading order with stable IDs', () => {
  const item = (text: string, left: number, baseline: number, width: number) => ({ text, left, top: baseline - 10, right: left + width, bottom: baseline + 2, baseline, height: 10 })
  const words = [item('Title', 50, 60, 500), item('Left first', 50, 110, 180), item('Left second', 50, 130, 180), item('Right first', 330, 110, 180), item('Right second', 330, 130, 180)]
  const first = analyzePageLayout(words, 600, 800)
  const second = analyzePageLayout(words, 600, 800)
  assert.equal(first[0].text, 'Title')
  assert.match(first[1].text, /^Left/)
  assert.match(first.at(-1)?.text || '', /^Right/)
  assert.deepEqual(first.map((paragraph) => paragraph.textHash), second.map((paragraph) => paragraph.textHash))
  assert.ok(first[1].region.left < first.at(-1)!.region.left)
})

test('inline citations keep only valid structured reference numbers at sentence positions', () => {
  const references = [{ id: 'r1', number: 1 }, { id: 'r2', number: 2 }] as never
  assert.equal(inlineCitationsToMarkdown('第一句。[[REF:2]] 第二句。[[REF:9]]', references), '第一句。[2](#raid-reference-2) 第二句。')
  assert.equal(referenceNumberFromHref('#raid-reference-2'), 2)
  assert.equal(referenceNumberFromHref('#other-2'), null)
})
