import type { RuntimeProject } from '../types'
import type { RetrievalHit } from './citationService'

export type RetrievalResult = { hits: RetrievalHit[]; context: string }
export type RetrievalStrategy = 'focused' | 'document' | 'project'

const termsFor = (value: string) => {
  const normalized = value.toLocaleLowerCase().normalize('NFKC')
  const words = normalized.match(/[a-z0-9][a-z0-9_-]{1,40}/g) || []
  const cjk = (normalized.match(/\p{Script=Han}+/gu) || []).flatMap((run) => {
    const terms: string[] = []
    for (let size = 2; size <= 3; size += 1) for (let index = 0; index <= run.length - size; index += 1) terms.push(run.slice(index, index + size))
    return terms
  })
  return [...new Set([...words, ...cjk])].slice(0, 160)
}

const frequency = (text: string, term: string) => {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(term, offset)) >= 0) { count += 1; offset += term.length }
  return count
}

export class RetrievalService {
  retrieve(project: RuntimeProject, query: string, options: { maxCharacters?: number; maxHits?: number; representative?: boolean; fileId?: string; strategy?: RetrievalStrategy; coverageRatio?: number } = {}): RetrievalResult {
    const sourceFiles = options.fileId ? project.files.filter((file) => file.id === options.fileId) : project.files
    const documents = sourceFiles.flatMap((file) => file.paragraphs.map((paragraph) => ({ paragraph, fileName: file.name, normalized: paragraph.text.toLocaleLowerCase().normalize('NFKC') })))
    if (!documents.length) return { hits: [], context: '' }
    const terms = termsFor(query)
    const averageLength = documents.reduce((sum, item) => sum + item.paragraph.text.length, 0) / documents.length
    const documentFrequency = new Map(terms.map((term) => [term, documents.filter((item) => item.normalized.includes(term)).length]))
    const scored = documents.map((item) => {
      const lengthRatio = item.paragraph.text.length / Math.max(1, averageLength)
      const score = terms.reduce((total, term) => {
        const tf = frequency(item.normalized, term)
        if (!tf) return total
        const df = documentFrequency.get(term) || 0
        const idf = Math.log(1 + (documents.length - df + .5) / (df + .5))
        return total + idf * (tf * 2.2) / (tf + 1.2 * (.25 + .75 * lengthRatio))
      }, 0)
      return { paragraph: item.paragraph, fileName: item.fileName, score }
    }).sort((a, b) => b.score - a.score || a.paragraph.order - b.paragraph.order)

    const strategy = options.strategy || (options.fileId ? 'document' : 'project')
    const maxHits = options.maxHits ?? (strategy === 'focused' ? 18 : 24)
    const selected: RetrievalHit[] = []
    const seen = new Set<string>()
    const fileCounts = new Map<string, number>()
    const add = (hit: RetrievalHit) => {
      if (seen.has(hit.paragraph.id) || selected.length >= maxHits) return
      seen.add(hit.paragraph.id); selected.push(hit)
      fileCounts.set(hit.paragraph.fileId, (fileCounts.get(hit.paragraph.fileId) || 0) + 1)
    }

    const addRepresentative = (file: RuntimeProject['files'][number], count: number) => {
      const candidates = [...file.paragraphs].sort((a, b) => a.order - b.order)
      const actual = Math.min(count, candidates.length)
      for (let index = 0; index < actual; index += 1) {
        const paragraph = candidates[Math.round(index * (candidates.length - 1) / Math.max(1, actual - 1))]
        if (paragraph) add({ paragraph, fileName: file.name, score: 0 })
      }
    }
    const addRelevant = (limit: number, perFileLimit: number) => {
      for (const hit of scored) {
        if (selected.length >= limit || (terms.length && hit.score <= 0)) break
        if ((fileCounts.get(hit.paragraph.fileId) || 0) >= perFileLimit) continue
        add(hit)
        if (selected.length >= limit) break
        const file = project.files.find((item) => item.id === hit.paragraph.fileId)
        const neighbor = file?.paragraphs.find((item) => item.order === hit.paragraph.order + 1)
        if (neighbor) add({ paragraph: neighbor, fileName: hit.fileName, score: hit.score * .72 })
      }
    }

    if (strategy === 'document') {
      const coverageRatio = Math.min(.9, Math.max(.35, options.coverageRatio ?? (options.representative ? .75 : .6)))
      const coverageCount = Math.max(1, Math.round(maxHits * coverageRatio))
      sourceFiles.forEach((file) => addRepresentative(file, coverageCount))
      addRelevant(maxHits, maxHits)
      for (const hit of scored) add(hit)
      selected.sort((a, b) => a.paragraph.order - b.paragraph.order)
    } else if (strategy === 'project') {
      const coverageRatio = Math.min(.8, Math.max(.25, options.coverageRatio ?? .35))
      const representativeSlots = Math.min(maxHits, Math.max(Math.min(sourceFiles.length, maxHits), Math.round(maxHits * coverageRatio)))
      const relevantLimit = Math.max(0, maxHits - representativeSlots)
      addRelevant(relevantLimit, Math.max(3, Math.ceil(maxHits * .34)))
      const baseCount = Math.floor(representativeSlots / Math.max(1, sourceFiles.length))
      const extraCount = representativeSlots % Math.max(1, sourceFiles.length)
      sourceFiles.forEach((file, index) => addRepresentative(file, baseCount + (index < extraCount ? 1 : 0)))
      for (let order = 0; selected.length < maxHits; order += 1) {
        let found = false
        for (const file of sourceFiles) {
          const paragraph = file.paragraphs.find((item) => item.order === order)
          if (!paragraph) continue
          found = true; add({ paragraph, fileName: file.name, score: 0 })
        }
        if (!found) break
      }
    } else {
      addRelevant(maxHits, Math.max(3, Math.ceil(maxHits / 2)))
      if (!selected.length || options.representative) sourceFiles.forEach((file) => addRepresentative(file, 3))
    }

    const maxCharacters = options.maxCharacters ?? 36000
    let used = 0
    const included: RetrievalHit[] = []
    const blocks: string[] = []
    for (const hit of selected) {
      const heading = `[来源文件：${hit.fileName}｜第 ${hit.paragraph.page} 页｜段落 ${hit.paragraph.id}]`
      const remaining = maxCharacters - used - heading.length - 2
      if (remaining < 120) break
      const text = hit.paragraph.text.slice(0, Math.min(remaining, 1400))
      blocks.push(`${heading}\n${text}`); included.push(hit); used += heading.length + text.length + 2
    }
    return { hits: included, context: blocks.join('\n\n') }
  }
}

export const retrievalService = new RetrievalService()
