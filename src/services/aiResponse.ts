import type { ChatMessage, ChatReference } from '../types'

type AiStreamEvent = { type: 'delta'; delta: string } | { type: 'done'; content: string; references?: ChatReference[]; model?: string; skillName?: string } | { type: 'error'; error: string }
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
    try { event = JSON.parse(line) as AiStreamEvent } catch { return }
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'done') doneEvent = event
    onEvent(event)
  }
  while (true) {
    const next = await reader.read()
    buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done })
    const lines = buffer.split(/\r?\n/)
    buffer = next.done ? '' : lines.pop() || ''
    for (const line of lines) processLine(line)
    if (next.done) break
  }
  if (buffer) processLine(buffer)
  if (!doneEvent) throw new Error('AI response ended before completion.')
  return doneEvent as AiDoneEvent
}

export const recentSelectionHistory = (messages: ChatMessage[]) => {
  let inferredMode: ChatMessage['contextMode']
  return messages.map((message) => {
    if (message.role === 'user') {
      inferredMode = message.contextMode
        || (/选区|selected/i.test(message.label || '') ? 'selection' : /项目|project/i.test(message.label || '') ? 'project' : /全文|document/i.test(message.label || '') ? 'document' : undefined)
    }
    const contextMode = message.contextMode || (message.citationsDisabled ? 'selection' : inferredMode)
    return { message, contextMode }
  }).filter(({ message, contextMode }) => contextMode === 'selection' && message.content.length <= 12000)
    .slice(-4)
    .map(({ message }) => ({
      role: message.role,
      content: (message.role === 'user' && message.prompt ? `${message.prompt}\n【当时选区】\n${message.content}` : message.content).slice(0, 4000),
    }))
}
