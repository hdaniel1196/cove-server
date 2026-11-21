// Tiny IndexedDB wrapper. Stores:
//   kv        misc cached data (library snapshot, reading speed, ...)
//   files     downloaded books: chapterId -> { blob, name, size, savedAt }
//   progress  local reading position: chapterId -> { cfi, index, fraction, pageNum, updatedAt, synced, ... }
const STORES = ['kv', 'files', 'progress']
let dbPromise

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('folio', 1)
        req.onupgradeneeded = () => {
            for (const s of STORES)
                if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

async function run(store, mode, fn) {
    const db = await (dbPromise ??= openDB())
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const out = fn(t.objectStore(store))
        t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
    })
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key))
export const set = (store, key, value) => run(store, 'readwrite', s => s.put(value, key))
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key))
export const keys = store => run(store, 'readonly', s => s.getAllKeys())
export const clear = store => run(store, 'readwrite', s => s.clear())

export async function entries(store) {
    const db = await (dbPromise ??= openDB())
    return new Promise((resolve, reject) => {
        const out = []
        const t = db.transaction(store, 'readonly')
        const req = t.objectStore(store).openCursor()
        req.onsuccess = () => {
            const c = req.result
            if (c) { out.push([c.key, c.value]); c.continue() }
        }
        t.oncomplete = () => resolve(out)
        t.onerror = () => reject(t.error)
    })
}
