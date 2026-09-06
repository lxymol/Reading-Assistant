const wordCharacter = /[\p{L}\p{N}_]/u

/** Repairs Chromium/PDF.js selections that begin one character into a word. */
export function repairClippedWordStart(selectedText: string, containerText: string, startOffset: number) {
  if (!selectedText || startOffset < 1 || startOffset > containerText.length) return selectedText
  const first = selectedText.trimStart().at(0) || ''
  const previous = containerText.at(startOffset - 1) || ''
  const beforePrevious = containerText.at(startOffset - 2) || ''
  if (!wordCharacter.test(first) || !wordCharacter.test(previous)) return selectedText
  if (startOffset > 1 && wordCharacter.test(beforePrevious)) return selectedText
  return `${previous}${selectedText}`
}
