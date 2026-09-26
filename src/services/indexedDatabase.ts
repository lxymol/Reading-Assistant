// Resolve writes only after commit, and reopen connections closed by upgrades.
export function createIndexedDatabase(name: string, stores: Record<string, IDBObjectStoreParameters | undefined>) {
  let connection: Promise<IDBDatabase> | null = null
  const open = () => connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      for (const [store, options] of Object.entries(stores)) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, options)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      const reset = () => { connection = null }
      database.onversionchange = () => { database.close(); reset() }
      database.onclose = reset
      resolve(database)
    }
    request.onerror = () => { connection = null; reject(request.error || new Error('无法打开本地数据库。')) }
  })

  async function transaction<T>(storeNames: string | string[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction, result: (value: T) => void) => void) {
    const database = await open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeNames, mode)
      let result: T
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('本地数据库事务失败。'))
      try { operation(transaction, (value) => { result = value }) }
      catch (error) { transaction.abort(); reject(error) }
    })
  }

  const request = <T>(store: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) =>
    transaction<T>(store, mode, (transaction, result) => {
      const request = operation(transaction.objectStore(store))
      request.onsuccess = () => result(request.result)
    })

  return { transaction, request }
}
