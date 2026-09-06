import type { DocumentParagraph, RuntimeProject, RuntimeProjectFile } from '../types'
import type { RetrievalHit } from './citationService'

export type RetrievalResult = { hits: RetrievalHit[]; context: string; overview: string }
export type RetrievalStrategy = 'focused' | 'document' | 'project'

const facetTerms = [
  'abstract 摘要 overview 概述 introduction 引言 background 背景 objective purpose aim 目的',
  'method methods methodology material materials approach model architecture algorithm implementation training 方法 材料 模型 算法 实现 训练',
  'result results experiment experiments evaluation performance finding findings 结果 实验 评估 性能 发现',
  'discussion limitation limitations conclusion conclusions future work 讨论 局限 结论 展望',
]

const termsFor = (value: string) => {
  const normalized = value.toLocaleLowerCase().normalize('NFKC')
  const words = normalized.match(/[a-z0-9][a-z0-9_-]{1,40}/g) || []
  const cjk = (normalized.match(/\p{Script=Han}+/gu) || []).flatMap((run) => {
    const terms: string[] = []
    for (let size = 2; size <= 3; size += 1) for (let index = 0; index <= run.length - size; index += 1) terms.push(run.slice(index, index + size))
    return terms
  })
  return [...new Set([...words, ...cjk])].slice(0, 180)
}

const frequency = (text: string, term: string) => {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(term, offset)) >= 0) { count += 1; offset += term.length }
  return count
}

const looksLikeHeading = (paragraph: DocumentParagraph) => {
  const text = paragraph.text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 180 || /[.!?。！？]\s*$/.test(text)) return false
  return /^(?:\d+(?:\.\d+)*[.)]?\s+|[ivx]+[.)]\s+)?(?:abstract|introduction|background|related work|methods?|materials?(?: and methods?)?|methodology|experiments?|results?|discussion|limitations?|conclusions?|future work|references|摘要|引言|背景|相关工作|材料与方法|方法|实验|结果|讨论|局限|结论|展望|参考文献)\b/i.test(text)
    || (/^[A-Z\d][A-Z\d\s:&(),/-]{3,80}$/.test(text) && /[A-Z]/.test(text))
}

const readingMap = (files: RuntimeProjectFile[]) => {
  const rows = files.map((file) => {
    const paragraphs = [...file.paragraphs].sort((a, b) => a.order - b.order)
    const pages = paragraphs.map((item) => item.page)
    const headings = paragraphs.filter(looksLikeHeading).slice(0, 16).map((item) => `p.${item.page} ${item.text.replace(/\s+/g, ' ').slice(0, 100)}`)
    const pageRange = pages.length ? `${Math.min(...pages)}–${Math.max(...pages)} 页` : '无页码'
    return `- ${file.name}：${paragraphs.length} 个正文段落，${pageRange}${headings.length ? `；章节：${headings.join('；')}` : ''}`
  })
  return `【全文阅读地图】\n${rows.join('\n')}`
}

type Candidate = RetrievalHit & { normalized: string }

export class RetrievalService {
  retrieve(project: RuntimeProject, query: string, options: { maxCharacters?: number; maxHits?: number; representative?: boolean; fileId?: string; strategy?: RetrievalStrategy; coverageRatio?: number } = {}): RetrievalResult {
    const sourceFiles = options.fileId ? project.files.filter((file) => file.id === options.fileId) : project.files
    const documents: Candidate[] = sourceFiles.flatMap((file) => file.paragraphs.map((paragraph) => ({ paragraph, fileName: file.name, normalized: paragraph.text.toLocaleLowerCase().normalize('NFKC'), score: 0 })))
    const overview = readingMap(sourceFiles)
    if (!documents.length) return { hits: [], context: '', overview }
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
      return { ...item, score }
    }).sort((a, b) => b.score - a.score || a.paragraph.order - b.paragraph.order)

    const strategy = options.strategy || (options.fileId ? 'document' : 'project')
    const maxHits = options.maxHits ?? (strategy === 'focused' ? 18 : strategy === 'document' ? 48 : 64)
    const selected: RetrievalHit[] = []
    const seen = new Set<string>()
    const fileCounts = new Map<string, number>()
    const add = (hit: RetrievalHit) => {
      if (seen.has(hit.paragraph.id) || selected.length >= maxHits) return
      seen.add(hit.paragraph.id); selected.push(hit)
      fileCounts.set(hit.paragraph.fileId, (fileCounts.get(hit.paragraph.fileId) || 0) + 1)
    }
    const addParagraph = (file: RuntimeProjectFile | undefined, paragraph?: DocumentParagraph, score = 0) => {
      if (file && paragraph) add({ paragraph, fileName: file.name, score })
    }
    const addRepresentative = (file: RuntimeProjectFile, count: number) => {
      const candidates = [...file.paragraphs].sort((a, b) => a.order - b.order)
      const actual = Math.min(count, candidates.length)
      for (let index = 0; index < actual; index += 1) addParagraph(file, candidates[Math.round(index * (candidates.length - 1) / Math.max(1, actual - 1))])
    }
    const addHeadingsAndNeighbors = (file: RuntimeProjectFile, limit: number) => {
      let added = 0
      for (const paragraph of file.paragraphs) {
        if (added >= limit || !looksLikeHeading(paragraph)) continue
        addParagraph(file, paragraph, .1)
        addParagraph(file, file.paragraphs.find((item) => item.order === paragraph.order + 1), .1)
        added += 2
      }
    }
    const addFacetEvidence = (file: RuntimeProjectFile, limit: number) => {
      for (const facet of facetTerms) {
        const facetTokens = termsFor(facet)
        const match = file.paragraphs.map((paragraph) => ({ paragraph, score: facetTokens.reduce((sum, term) => sum + (paragraph.text.toLocaleLowerCase().includes(term) ? term.length : 0), 0) }))
          .sort((a, b) => b.score - a.score || a.paragraph.order - b.paragraph.order)[0]
        if (match?.score) addParagraph(file, match.paragraph, match.score)
        if ((fileCounts.get(file.id) || 0) >= limit) break
      }
    }
    const addRelevant = (limit: number, perFileLimit: number) => {
      for (const hit of scored) {
        if (selected.length >= limit || (terms.length && hit.score <= 0)) break
        if ((fileCounts.get(hit.paragraph.fileId) || 0) >= perFileLimit) continue
        add(hit)
        const file = sourceFiles.find((item) => item.id === hit.paragraph.fileId)
        addParagraph(file, file?.paragraphs.find((item) => item.order === hit.paragraph.order + 1), hit.score * .72)
      }
    }

    const maxCharacters = options.maxCharacters ?? (strategy === 'project' ? 80000 : 60000)
    const fullLength = documents.reduce((sum, item) => sum + item.paragraph.text.length + item.fileName.length + 48, 0)
    if (strategy === 'document' && documents.length <= maxHits && fullLength <= maxCharacters - overview.length) {
      documents.sort((a, b) => a.paragraph.order - b.paragraph.order).forEach(add)
    } else if (strategy === 'document') {
      addRelevant(Math.round(maxHits * .35), maxHits)
      sourceFiles.forEach((file) => { addHeadingsAndNeighbors(file, Math.round(maxHits * .35)); addFacetEvidence(file, maxHits); addRepresentative(file, Math.round(maxHits * .45)) })
      for (const hit of scored) add(hit)
      selected.sort((a, b) => a.paragraph.order - b.paragraph.order)
    } else if (strategy === 'project') {
      const perFile = Math.max(2, Math.floor(maxHits * .65 / Math.max(1, sourceFiles.length)))
      sourceFiles.forEach((file) => { addHeadingsAndNeighbors(file, Math.max(2, Math.floor(perFile / 2))); addFacetEvidence(file, perFile); addRepresentative(file, perFile) })
      addRelevant(maxHits, Math.max(4, Math.ceil(maxHits * .18)))
      for (const hit of scored) add(hit)
    } else {
      addRelevant(maxHits, Math.max(3, Math.ceil(maxHits / 2)))
      if (!selected.length || options.representative) sourceFiles.forEach((file) => addRepresentative(file, 3))
    }

    let used = overview.length + 2
    const included: RetrievalHit[] = []
    const blocks: string[] = []
    for (const hit of selected) {
      const heading = `[来源文件：${hit.fileName}｜第 ${hit.paragraph.page} 页｜段落 ${hit.paragraph.id}]`
      const remaining = maxCharacters - used - heading.length - 2
      if (remaining < 120) break
      const text = hit.paragraph.text.slice(0, Math.min(remaining, 1800))
      blocks.push(`${heading}\n${text}`); included.push(hit); used += heading.length + text.length + 2
    }
    const context = `${overview}\n\n【按任务提取的正文证据】\n${blocks.join('\n\n')}`
    return { hits: included, context, overview }
  }
}

export const retrievalService = new RetrievalService()
