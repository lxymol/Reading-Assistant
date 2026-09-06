const citationTagPattern = /\\?\[\\?\[\s*(?:REF\s*:\s*\d+(?:\s*\|\s*PAGE\s*:\s*\d+)?(?:\s*\|\s*RECT\s*:[^\]\r\n]+)?|PAGE\s*:\s*\d+|SOURCE\s*:\s*\d+\s*\|[^\]\r\n]*)\s*\\?\]\\?\]/gi

export function stripCitationTags(content) {
  return String(content).replace(citationTagPattern, '').replace(/[ \t]+\n/g, '\n').trim()
}

export function groundCitationTags(content, references) {
  const available = new Set(references.map((reference) => reference.number))
  return String(content).replace(citationTagPattern, (tag) => {
    const number = Number(tag.match(/REF\s*:\s*(\d+)/i)?.[1])
    return available.has(number) ? `[[REF:${number}]]` : ''
  }).replace(/[ \t]+\n/g, '\n').trim()
}

export function referencesUsedIn(content, references) {
  const used = new Set([...String(content).matchAll(/\[\[REF:(\d+)\]\]/g)].map((match) => Number(match[1])))
  return references.filter((reference) => used.has(reference.number))
}
