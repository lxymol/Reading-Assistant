const displayDelimiterCount = (line: string) => Array.from(line.matchAll(/(^|[^\\])\$\$/g)).length

const formulaCode = (value: string) => /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|lim|overline|underline|bar|hat|vec|tilde|begin)\b|[A-Za-z0-9)}\]](?:_|\^)\{?[A-Za-z0-9\\]/.test(value)

function normalizeMathEnvironments(markdown: string) {
  return markdown
    .replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/gi, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
    .replace(/\\begin\{(align|alignat|gather|multline)\*?\}([\s\S]*?)\\end\{\1\*?\}/gi, (_match, environment: string, formula: string) => {
      const innerEnvironment = /^gather/i.test(environment) ? 'gathered' : 'aligned'
      return `\n$$\n\\begin{${innerEnvironment}}\n${formula.trim()}\n\\end{${innerEnvironment}}\n$$\n`
    })
}

function wrapBareMath(markdown: string) {
  const protectedParts = /(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g
  return markdown.split(protectedParts).map((part, index) => {
    if (index % 2) return part
    const accentsWrapped = wrapBalancedAccents(part)
    return accentsWrapped.replace(/(\\(?:d?frac|tfrac)\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt(?:\[[^\]\n]+\])?\{[^{}\n]+\}|\b[A-Za-z](?:[_^](?:\{[^{}\n]+\}|[A-Za-z0-9]))+(?=$|[\s,.;:，。；：、)]))/g, '$$$1$$')
  }).join('')
}

function wrapBalancedAccents(text: string) {
  const command = /\\(?:overline|underline|bar|hat|vec|tilde)\s*\{/g
  let output = ''
  let cursor = 0
  for (let match = command.exec(text); match; match = command.exec(text)) {
    let depth = 0
    let end = match.index
    const braceStart = text.indexOf('{', match.index)
    for (let index = braceStart; index < text.length; index += 1) {
      if (text[index] === '{' && text[index - 1] !== '\\') depth += 1
      if (text[index] === '}' && text[index - 1] !== '\\') depth -= 1
      if (depth === 0) { end = index + 1; break }
    }
    if (end <= match.index) continue
    while (/[_^]/.test(text[end] || '')) {
      end += 1
      if (text[end] === '{') {
        let modifierDepth = 0
        for (; end < text.length; end += 1) {
          if (text[end] === '{' && text[end - 1] !== '\\') modifierDepth += 1
          if (text[end] === '}' && text[end - 1] !== '\\') modifierDepth -= 1
          if (modifierDepth === 0) { end += 1; break }
        }
      } else if (text[end]) end += 1
    }
    output += `${text.slice(cursor, match.index)}$${text.slice(match.index, end)}$`
    cursor = end
    command.lastIndex = end
  }
  return output + text.slice(cursor)
}

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
  const mathFences = markdown.replace(/```(?:math|latex|tex)(?![\w-])[^\S\r\n]*\r?\n([\s\S]*?)```/gi, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
  const normalized = mathFences.split(/(```[\s\S]*?```)/g).map((part, index) => index % 2 ? part : normalizeMathEnvironments(part)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
    .replace(/\\\((.*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`)
    .replace(/`([^`\n]+)`/g, (match, formula: string) => formulaCode(formula) ? `$${formula.trim()}$` : match)).join('')
  return stabilizeDisplayMath(wrapBareMath(normalized))
}
