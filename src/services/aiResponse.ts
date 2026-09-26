import type { ChatMessage, ChatReference } from '../types'

type AiStreamEvent = { type: 'delta'; delta: string } | { type: 'thread'; threadId: string } | { type: 'done'; content: string; references?: ChatReference[]; model?: string; skillName?: string; files?: Array<{ name: string; content: string }> } | { type: 'error'; error: string }
type AiDoneEvent = Extract<AiStreamEvent, { type: 'done' }>

export const readAiStream = async (response: Response, onEvent: (event: AiStreamEvent) => void): Promise<AiDoneEvent> => {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `AI request failed (${response.status})`)
  }
  if (!response.body) throw new Error('AI response stream is unavailable.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneEvent: AiDoneEvent | null = null
  const processLine = (line: string) => {
    if (!line.trim()) return
    let event: AiStreamEvent
    try { event = JSON.parse(line) as AiStreamEvent } catch { throw new Error('AI response contains invalid stream data.') }
    if (!event || typeof event !== 'object') throw new Error('AI response contains invalid stream data.')
    if ((event.type === 'delta' && typeof event.delta !== 'string') || (event.type === 'done' && typeof event.content !== 'string')) throw new Error('AI response contains invalid stream data.')
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'done') doneEvent = event
    onEvent(event)
  }
  let ended = false
  try {
    while (!doneEvent) {
      const next = await reader.read()
      ended = next.done
      buffer += decoder.decode(next.value, { stream: !next.done })
      const lines = buffer.split(/\r?\n/)
      buffer = next.done ? '' : lines.pop() || ''
      for (const line of lines) {
        if (line.length > 16 * 1024 * 1024) throw new Error('AI response event exceeds the memory budget.')
        processLine(line)
        if (doneEvent) break
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error('AI response event exceeds the memory budget.')
      if (next.done) break
    }
    if (!doneEvent) throw new Error('AI response ended before completion.')
    return doneEvent as AiDoneEvent
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export const recentSelectionHistory = (messages: ChatMessage[]) => {
  return messages.slice(-40).map((message) => ({
      role: message.role,
      content: message.role === 'user' && message.prompt && message.prompt !== message.content ? `${message.prompt}\n\n${message.content}` : message.content,
      attachmentIds: message.role === 'user' ? message.attachments?.map((image) => image.id) || [] : [],
    }))
}
