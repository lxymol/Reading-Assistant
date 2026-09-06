const displayDelimiterCount = (line: string) => Array.from(line.matchAll(/(^|[^\\])\$\$/g)).length

function stabilizeDisplayMath(markdown: string) {
  const lines = markdown.split('\n')
  const output: string[] = []
  let fencedCode = false
  let displayMath = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fencedCode = !fencedCode
      output.push(line)
      continue
    }
    const delimiters = fencedCode ? 0 : displayDelimiterCount(line)
    if (displayMath && delimiters === 0 && /^\s*\|\s*$/.test(line)) continue
    output.push(line)
    if (delimiters % 2) displayMath = !displayMath
  }
  if (displayMath && !fencedCode) output.push('$$')
  return output.join('\n')
}

export function normalizeAssistantMath(markdown: string) {
  const normalized = markdown
    .replace(/```(?:latex|tex)(?![\w-])[^\S\r\n]*\r?\n([\s\S]*?)```/gi, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
    .replace(/\\\((.*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`)
  return stabilizeDisplayMath(normalized)
}
