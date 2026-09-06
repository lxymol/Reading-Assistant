import { Worker } from 'node:worker_threads'

export class ProjectStorageClient {
  #worker
  #pending = new Map()
  #nextId = 0
  #failure = null
  #closing = null

  constructor(options, log = () => {}) {
    this.#worker = new Worker(new URL('./project-storage-worker.mjs', import.meta.url), { workerData: options })
    this.#worker.on('message', ({ id, result, error, diagnostic }) => {
      if (diagnostic) { log(diagnostic); return }
      const request = this.#pending.get(id)
      if (!request) return
      this.#pending.delete(id)
      if (error) request.reject(new Error(error))
      else request.resolve(result)
    })
    const fail = (error) => {
      this.#failure = error
      for (const request of this.#pending.values()) request.reject(error)
      this.#pending.clear()
    }
    this.#worker.on('error', fail)
    this.#worker.on('exit', (code) => fail(new Error(`Storage worker exited (${code})`)))
  }

  call(method, ...args) {
    if (this.#failure || this.#closing) return Promise.reject(this.#failure || new Error('Storage is closing'))
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId
      this.#pending.set(id, { resolve, reject })
      try { this.#worker.postMessage({ id, method, args }) }
      catch (error) { this.#pending.delete(id); reject(error) }
    })
  }

  close() {
    // The barrier runs after every previously accepted write.
    this.#closing ??= this.call('flush').finally(() => this.#worker.terminate())
    return this.#closing
  }
}
