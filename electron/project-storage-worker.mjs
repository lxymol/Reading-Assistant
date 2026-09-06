import { parentPort, workerData } from 'node:worker_threads'
import { createProjectStorage } from './project-storage.mjs'

const storage = createProjectStorage({ ...workerData, logStartup: (diagnostic) => parentPort.postMessage({ diagnostic }) })
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!Object.hasOwn(storage, method)) throw new Error('UNKNOWN_STORAGE_OPERATION')
    const result = storage[method](...args)
    const transfers = result instanceof Uint8Array ? [result.buffer] : []
    parentPort.postMessage({ id, result }, transfers)
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
