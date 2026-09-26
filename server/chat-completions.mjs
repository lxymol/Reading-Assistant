import { createAnswerFilter } from './chat-input.mjs'

export async function streamChatCompletions({ apiKey, baseUrl, model, messages, signal, onDelta }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data?.error?.message || `AI 服务返回 ${response.status}`)
  }
  if (!response.body) throw new Error('AI 服务没有返回可读取的数据流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let completed = false
  let ended = false
  const filterAnswer = createAnswerFilter()
  const processLine = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload) return
    if (payload === '[DONE]') { completed = true; return }
    let event
    try { event = JSON.parse(payload) } catch { throw new Error('AI 服务返回了无效的流数据') }
    if (event?.error) throw new Error(event.error.message || String(event.error))
    const reason = event?.choices?.[0]?.finish_reason
    if (reason === 'length') throw new Error('AI 输出达到模型长度限制，请缩小问题范围后重试')
    if (reason === 'content_filter') throw new Error('AI 服务中止了回答')
    if (reason) completed = true
    const delta = event?.choices?.[0]?.delta?.content
    const text = typeof delta === 'string' ? delta : Array.isArray(delta) ? delta.map((part) => part?.text || '').join('') : ''
    const answer = filterAnswer(text)
    if (answer) { content += answer; onDelta(answer) }
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read()
      ended = done
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = done ? '' : lines.pop() || ''
      for (const line of lines) {
        if (line.length > 1024 * 1024) throw new Error('AI 流数据超过单条消息内存预算')
        processLine(line)
        if (completed) break
      }
      if (buffer.length > 1024 * 1024) throw new Error('AI 流数据超过单条消息内存预算')
      if (done) break
    }
    if (!completed) throw new Error('AI 连接在回答完成前中断，请重试')
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const tail = filterAnswer('', true)
  if (tail) { content += tail; onDelta(tail) }
  if (!content.trim()) throw new Error('AI 服务未返回内容')
  return content
}

