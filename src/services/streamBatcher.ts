// Bound React updates independently of the provider's token/chunk frequency.
// A terminal event or failure flushes pending text synchronously and clears timers.
export function createStreamBatcher(onText: (text: string) => void, intervalMs = 40) {
  let chunks: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!chunks.length) return
    const text = chunks.join('')
    chunks = []
    onText(text)
  }
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    chunks = []
  }
  return {
    push(text: string) {
      if (!text) return
      chunks.push(text)
      if (timer === undefined) timer = setTimeout(flush, intervalMs)
    },
    flush,
    cancel,
  }
}
