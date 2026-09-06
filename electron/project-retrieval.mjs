const facetTerms = [
  'abstract 摘要 overview 概述 introduction 引言 background 背景 objective purpose aim 目的',
  'method methods methodology material materials approach model architecture algorithm implementation training 方法 材料 模型 算法 实现 训练',
  'result results experiment experiments evaluation performance finding findings 结果 实验 评估 性能 发现',
  'discussion limitation limitations conclusion conclusions future work 讨论 局限 结论 展望',
]

const termsFor = (value) => {
  const normalized = String(value || '').toLocaleLowerCase().normalize('NFKC')
  const words = normalized.match(/[a-z0-9][a-z0-9_-]{1,40}/g) || []
  const cjk = (normalized.match(/\p{Script=Han}+/gu) || []).flatMap((run) => {
    const terms = []
    for (let size = 2; size <= 3; size += 1) for (let index = 0; index <= run.length - size; index += 1) terms.push(run.slice(index, index + size))
    return terms
  })
  return [...new Set([...words, ...cjk])].slice(0, 180)
}

const scoreText = (text, terms) => {
  if (!terms.length) return 0
  const normalized = String(text || '').toLocaleLowerCase().normalize('NFKC')
  let score = 0
  for (const term of terms) {
    let offset = 0
    while ((offset = normalized.indexOf(term, offset)) >= 0) { score += term.length; offset += term.length }
  }
  return score / Math.max(1, Math.sqrt(normalized.length / 180))
}

const looksLikeHeading = (paragraph) => {
  const text = String(paragraph?.text || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 180 || /[.!?。！？]\s*$/.test(text)) return false
  return /^(?:\d+(?:\.\d+)*[.)]?\s+|[ivx]+[.)]\s+)?(?:abstract|introduction|background|related work|methods?|materials?(?: and methods?)?|methodology|experiments?|results?|discussion|limitations?|conclusions?|future work|references|摘要|引言|背景|相关工作|材料与方法|方法|实验|结果|讨论|局限|结论|展望|参考文献)\b/i.test(text)
    || (/^[A-Z\d][A-Z\d\s:&(),/-]{3,80}$/.test(text) && /[A-Z]/.test(text))
}

const representativeIndexes = (length, count) => {
  const actual = Math.min(length, count)
  return Array.from({ length: actual }, (_, index) => Math.round(index * (length - 1) / Math.max(1, actual - 1)))
}

// Indexes are visited one file at a time. Only a bounded evidence set and a
// compact map of every paper cross the worker/renderer boundary.
export function retrieveProjectContext(files, query, options = {}) {
  const maxHits = options.maxHits ?? 64
  const maxCharacters = options.maxCharacters ?? 80000
  const terms = termsFor(query)
  const fileCount = Math.max(1, options.fileCount ?? 1)
  const perFile = Math.max(2, Math.floor(maxHits * .65 / fileCount))
  const maps = []
  const guaranteed = []
  const relevant = []

  for (const file of files) {
    const paragraphs = Array.isArray(file.paragraphs) ? file.paragraphs : []
    const pages = paragraphs.map((item) => Number(item.page)).filter(Number.isFinite)
    const headings = paragraphs.filter(looksLikeHeading).slice(0, 14)
    maps.push(`- ${file.name}：${paragraphs.length} 个正文段落，${pages.length ? `${Math.min(...pages)}–${Math.max(...pages)} 页` : '无页码'}${headings.length ? `；章节：${headings.map((item) => `p.${item.page} ${String(item.text).replace(/\s+/g, ' ').slice(0, 90)}`).join('；')}` : ''}`)

    const local = []
    const localSeen = new Set()
    const addLocal = (paragraph, score = 0) => {
      if (!paragraph?.id || localSeen.has(paragraph.id) || local.length >= perFile) return
      localSeen.add(paragraph.id); local.push({ paragraph, fileName: file.name, score })
    }
    for (const heading of headings) {
      addLocal(heading, .1)
      addLocal(paragraphs.find((item) => item.order === heading.order + 1), .1)
      if (local.length >= Math.max(2, Math.floor(perFile / 2))) break
    }
    for (const facet of facetTerms) {
      const facetTokens = termsFor(facet)
      const match = paragraphs.map((paragraph) => ({ paragraph, score: scoreText(paragraph.text, facetTokens) })).sort((a, b) => b.score - a.score)[0]
      if (match?.score) addLocal(match.paragraph, match.score)
    }
    for (const index of representativeIndexes(paragraphs.length, perFile)) addLocal(paragraphs[index])
    guaranteed.push(...local)

    for (const paragraph of paragraphs) {
      const score = scoreText(paragraph.text, terms)
      if (score > 0) relevant.push({ paragraph, fileName: file.name, score })
    }
    if (relevant.length > maxHits * 6) {
      relevant.sort((a, b) => b.score - a.score || a.paragraph.order - b.paragraph.order)
      relevant.length = maxHits * 3
    }
  }

  relevant.sort((a, b) => b.score - a.score || a.paragraph.order - b.paragraph.order)
  const selected = []
  const seen = new Set()
  for (const hit of [...guaranteed, ...relevant]) {
    if (selected.length >= maxHits || seen.has(hit.paragraph.id)) continue
    seen.add(hit.paragraph.id); selected.push(hit)
  }

  const overview = `【全文阅读地图】\n${maps.join('\n')}`
  let used = overview.length + 2
  const blocks = []
  for (const hit of selected) {
    const heading = `[来源文件：${hit.fileName}｜第 ${hit.paragraph.page} 页｜段落 ${hit.paragraph.id}]`
    const remaining = maxCharacters - used - heading.length - 2
    if (remaining < 120) break
    const text = String(hit.paragraph.text || '').slice(0, Math.min(remaining, 1800))
    blocks.push(`${heading}\n${text}`)
    used += heading.length + text.length + 2
  }
  return { context: `${overview}\n\n【按任务提取的正文证据】\n${blocks.join('\n\n')}`, hitCount: blocks.length }
}
