export function buildChatInput({ action, instruction, selectedText, documentText, responseLanguage, fastInlineTranslation }) {
  if (fastInlineTranslation) return `翻译为${responseLanguage}，只输出译文，保留公式、数字和段落结构。\n\n${selectedText}`
  const tasks = { translate: `翻译为${responseLanguage}。`, explain: '解释这些内容。', insight: '分析这些内容的关键洞见。', summarize: '总结这些内容。' }
  const question = String(instruction || '').trim() || tasks[action] || '请分析所附材料。'
  return [question, selectedText ? `\n<selected_text>\n${selectedText}\n</selected_text>` : '', documentText ? `\n<attached_documents>\n${documentText}\n</attached_documents>` : ''].filter(Boolean).join('\n')
}

// Some compatible APIs put a leading reasoning block into content rather than
// reasoning_content. Hold only a possible tag suffix while streaming it away.
export function createAnswerFilter() {
  let pending = ''
  let closing = ''
  let answerStarted = false
  const openings = ['<think>', '<analysis>', '<reasoning>']
  return (chunk, done = false) => {
    pending += chunk
    if (answerStarted) { const result = pending; pending = ''; return result }
    while (true) {
      if (closing) {
        const end = pending.indexOf(closing)
        if (end < 0) { pending = done ? '' : pending.slice(-(closing.length - 1)); return '' }
        pending = pending.slice(end + closing.length)
        closing = ''
      }
      pending = pending.trimStart()
      const opening = openings.find((tag) => pending.startsWith(tag))
      if (opening) { closing = opening.replace('<', '</'); pending = pending.slice(opening.length); continue }
      if (!pending || (!done && openings.some((tag) => tag.startsWith(pending)))) return ''
      answerStarted = true
      const result = pending
      pending = ''
      return result
    }
  }
}
