// Retain a lazy snapshot getter, not a new copy of every project on each render.
// Continuous edits still checkpoint at maxWait, rather than starving the debounce.
export function createAutosaveScheduler<T>(write: (value: T) => Promise<unknown>, onError: (error: unknown) => void, delay = 700, maxWait = 3000) {
  let pending: { key: string; snapshot: () => T | null } | null = null
  let debounce: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined

  const flush = async () => {
    clearTimeout(debounce)
    clearTimeout(deadline)
    debounce = deadline = undefined
    const current = pending
    pending = null
    if (!current) return
    try {
      const value = current.snapshot()
      if (value) await write(value)
    } catch (error) { onError(error) }
  }

  return {
    schedule(key: string, snapshot: () => T | null) {
      if (pending && pending.key !== key) void flush()
      pending = { key, snapshot }
      clearTimeout(debounce)
      debounce = setTimeout(() => { void flush() }, delay)
      deadline ??= setTimeout(() => { void flush() }, maxWait)
    },
    cancel(key: string) {
      if (pending?.key !== key) return
      pending = null
      clearTimeout(debounce)
      clearTimeout(deadline)
      debounce = deadline = undefined
    },
    flush,
  }
}
