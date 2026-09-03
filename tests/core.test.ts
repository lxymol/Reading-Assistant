import assert from 'node:assert/strict'
import test from 'node:test'
import { NavigationService } from '../src/services/navigationService.ts'
import { RetrievalService } from '../src/services/retrievalService.ts'
import { createReferences, validateReference } from '../src/services/citationService.ts'
import { createTag, tagsWithoutFile } from '../src/services/tagStore.ts'
import { inlineCitationsToMarkdown, referenceNumberFromHref } from '../src/services/inlineCitation.ts'
import { analyzePageLayout } from '../src/services/layoutAnalyzer.ts'
import type { DocumentParagraph, ReaderLocation, RuntimeProject } from '../src/types.ts'

const paragraph = (fileId: string, order: number, text: string): DocumentParagraph => ({
  id: `${fileId}:p${order}`, projectId: 'project', fileId, page: order + 1,
  region: { left: fileId === 'left' ? .08 : .55, top: .1 + order * .1, width: .35, height: .06 },
  text, textHash: `hash-${fileId}-${order}`, order,
})

const project: RuntimeProject = {
  id: 'project', name: 'Research', activeFileId: 'left', activeConversationId: '', conversations: [],
  projectNotes: '', projectNoteAssets: {}, tags: [], createdAt: 1, updatedAt: 1, hydrated: true,
  files: [
    { id: 'left', projectId: 'project', name: 'method.pdf', kind: 'pdf', type: 'application/pdf', size: 1, lastModified: 1, createdAt: 1, updatedAt: 1, readingState: { page: 1, zoom: 1, scrollTop: 0 }, highlights: [], annotations: [], indexState: { status: 'ready', version: 1 }, paragraphs: [paragraph('left', 0, 'graph neural network message passing method'), paragraph('left', 1, 'training details and optimizer')] },
    { id: 'right', projectId: 'project', name: 'results.pdf', kind: 'pdf', type: 'application/pdf', size: 1, lastModified: 1, createdAt: 1, updatedAt: 1, readingState: { page: 1, zoom: 1, scrollTop: 0 }, highlights: [], annotations: [], indexState: { status: 'ready', version: 1 }, paragraphs: [paragraph('right', 0, 'graph neural network improves benchmark accuracy'), paragraph('right', 1, 'ablation and limitations')] },
  ],
}

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
