// Library model: Kavita series -> volumes -> chapters, flattened into "books" (one per chapter).
// The snapshot is cached in IndexedDB so the app opens instantly and works offline.
import { api, OfflineError } from './api.js'
import * as db from './db.js'

const NO_NUMBER = -100000
export const state = {
    books: [],          // see makeBook()
    series: [],         // { id, name, sortName, libraryId, libraryName, libraryType, author, books: [chapterId], wantToRead }
    libraries: [],
    byId: new Map(),    // chapterId -> book
    seriesById: new Map(),
    sagas: [],          // Kavita reading lists: { id, title, summary, books: [chapterId] (in order), series: [seriesId] (in order) }
    downloads: {},      // chapterId -> { size, savedAt, name }
    local: {},          // chapterId -> local progress record
    loadedAt: 0,
    offline: false,
}
const emit = () => dispatchEvent(new Event('folio:library'))
// Kavita sends UTC timestamps without a zone; "0001-01-01" means never
export const utc = s => (s && !s.startsWith('0001') && Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z')) || 0

function makeBook(series, volume, chapter, library) {
    const file = chapter.files?.[0] ?? {}
    const num = volume.minNumber > NO_NUMBER ? volume.minNumber : null
    const title = chapter.titleName || (chapter.title && chapter.title !== String(NO_NUMBER) ? chapter.title : '')
        || (volume.name && volume.name !== String(NO_NUMBER) && !/^\d+(\.\d+)?$/.test(volume.name) ? volume.name : '')
        || (num != null ? `${series.name} ${num}` : series.name)
    return {
        id: chapter.id,
        volumeId: volume.id,
        seriesId: series.id,
        libraryId: series.libraryId,
        libraryName: series.libraryName,
        isComic: library?.type !== 2 || /\.(cbz|cbr|cb7|zip)$/i.test(file.extension || ''),
        isManga: library?.type === 0,   // Kavita "Manga" library: read right to left
        title,
        series: series.name,
        number: num,
        author: (chapter.writers ?? []).map(w => w.name).join(', '),
        pages: chapter.pages,
        pagesRead: chapter.pagesRead,
        lastRead: utc(chapter.lastReadingProgressUtc),
        created: utc(chapter.createdUtc),
        words: chapter.wordCount || 0,
        avgHours: chapter.avgHoursToRead || 0,
        summary: chapter.summary || '',
        releaseYear: chapter.releaseDate && !chapter.releaseDate.startsWith('0001') ? chapter.releaseDate.slice(0, 4) : '',
        isbn: chapter.isbn || '',
        ext: file.extension || '.epub',
        bytes: file.bytes || 0,
        primaryColor: series.primaryColor,
    }
}

async function pool(items, n, fn) {
    const out = new Array(items.length)
    let i = 0
    await Promise.all(Array.from({ length: n }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
    }))
    return out
}

function index(snapshot) {
    Object.assign(state, snapshot)
    state.byId = new Map(state.books.map(b => [b.id, b]))
    state.seriesById = new Map(state.series.map(s => [s.id, s]))
}

export async function init() {
    const [snap, downloads, local] = await Promise.all([
        db.get('kv', 'library'), db.get('kv', 'downloads'), db.entries('progress')])
    state.downloads = downloads ?? {}
    state.local = Object.fromEntries(local)
    if (snap) { index(snap); emit() }
    const fresh = refresh()
    return snap ? undefined : fresh
}

export async function refresh() {
    try {
        const [libraries, series, want, sagas] = await Promise.all([
            api.libraries(), api.allSeries(), api.wantToRead().catch(() => []), loadSagas().catch(() => state.sagas)])
        const libById = new Map(libraries.map(l => [l.id, l]))
        const wantIds = new Set((want ?? []).map(s => s.id))
        const books = []
        const outSeries = []
        await pool(series, 6, async s => {
            const vols = await api.volumes(s.id)
            const lib = libById.get(s.libraryId)
            const ids = []
            for (const v of vols.sort((a, b) => a.minNumber - b.minNumber))
                for (const c of v.chapters.sort((a, b) => a.sortOrder - b.sortOrder)) {
                    const b = makeBook(s, v, c, lib)
                    books.push(b); ids.push(b.id)
                }
            const first = books.find(b => b.id === ids[0])
            outSeries.push({
                id: s.id, name: s.name, sortName: s.sortName || s.name,
                libraryId: s.libraryId, libraryName: s.libraryName, libraryType: lib?.type,
                author: first?.author ?? '', books: ids, wantToRead: wantIds.has(s.id),
                created: Date.parse(s.created) || 0,
            })
        })
        const snapshot = { books, series: outSeries, libraries, sagas, loadedAt: Date.now(), offline: false }
        index(snapshot)
        await db.set('kv', 'library', { books, series: outSeries, libraries, sagas, loadedAt: snapshot.loadedAt })
        emit()
    } catch (e) {
        if (e instanceof OfflineError) { state.offline = true; emit(); return }
        throw e
    }
}

// ---- sagas (Kavita reading lists) -------------------------------------------------------------
async function loadSagas() {
    const lists = await api.readingLists()
    return pool(lists ?? [], 4, async l => {
        const items = (await api.readingListItems(l.id)).sort((a, b) => a.order - b.order)
        return {
            id: l.id, title: l.title, summary: l.summary || '',
            books: items.map(i => i.chapterId),
            series: [...new Set(items.map(i => i.seriesId))],
        }
    })
}

export async function refreshSagas() {
    state.sagas = await loadSagas()
    const snap = await db.get('kv', 'library')
    if (snap) await db.set('kv', 'library', { ...snap, sagas: state.sagas })
    emit()
}

export const sagaBooks = saga => saga.books.map(id => state.byId.get(id)).filter(Boolean)
export const sagaNext = saga => sagaBooks(saga).find(b => !isFinished(b))
export const sagasOfBook = id => state.sagas.filter(s => s.books.includes(id))
export const sagasOfSeries = id => state.sagas.filter(s => s.series.includes(id))

// What to read after this book: next in its saga if it's in one, else next in its series
export function nextAfter(book) {
    for (const s of sagasOfBook(book.id)) {
        const bs = sagaBooks(s)
        const next = bs.slice(bs.findIndex(b => b.id === book.id) + 1).find(b => !isFinished(b))
        if (next) return { book: next, saga: s }
    }
    const sb = seriesBooks(book.seriesId)
    const next = sb.slice(sb.findIndex(b => b.id === book.id) + 1).find(b => !isFinished(b))
    return next ? { book: next } : null
}

// Create or replace a saga: Kavita adds whole series in the order given.
export async function saveSaga({ id, title, summary = '', series }, { reorder }) {
    let listId = id
    if (id && reorder) { await api.deleteReadingList(id); listId = null }
    if (!listId) {
        const rl = await api.createReadingList(title)
        listId = rl.id
        for (const sid of series) await api.addSeriesToList(listId, sid)
    }
    await api.updateReadingList(listId, title, summary)
    await refreshSagas()
    return listId
}

export async function deleteSaga(id) {
    await api.deleteReadingList(id)
    await refreshSagas()
}

// ---- progress helpers -------------------------------------------------------------------------
// fraction 0..1 for display. Local record wins if it's newer than Kavita's (or Kavita is behind).
export function progressOf(book) {
    const l = state.local[book.id]
    const remote = book.pages ? Math.min(1, book.pagesRead / book.pages) : 0
    if (book.pages && book.pagesRead >= book.pages) return 1
    if (l && (l.updatedAt >= book.lastRead - 2000 || l.pageNum === book.pagesRead)) return l.finished ? 1 : (l.fraction ?? remote)
    return remote
}
export const isFinished = b => (b.pages && b.pagesRead >= b.pages) || !!state.local[b.id]?.finished
export const isStarted = b => !isFinished(b) && (b.pagesRead > 0 || (state.local[b.id]?.fraction ?? 0) > 0)
export const lastActivity = b => Math.max(b.lastRead || 0, state.local[b.id]?.updatedAt || 0)

export function hoursLeft(book) {
    const p = progressOf(book)
    return book.avgHours ? book.avgHours * (1 - p) : 0
}

export function seriesBooks(seriesId) {
    return (state.seriesById.get(seriesId)?.books ?? []).map(id => state.byId.get(id)).filter(Boolean)
}

// Next book to read in a series: first unfinished one
export function nextInSeries(seriesId) {
    return seriesBooks(seriesId).find(b => !isFinished(b))
}

export async function setLocal(chapterId, rec) {
    state.local[chapterId] = rec
    await db.set('progress', chapterId, rec)
}

// ---- downloads --------------------------------------------------------------------------------
export const isDownloaded = id => !!state.downloads[id]

export async function getFile(book, { save = false } = {}) {
    const stored = await db.get('files', book.id)
    if (stored) return new File([stored.blob], stored.name, { type: stored.blob.type })
    const { blob, name } = await api.download(book.id)
    if (save) await storeFile(book.id, blob, name)
    return new File([blob], name, { type: blob.type })
}

async function storeFile(id, blob, name) {
    await db.set('files', id, { blob, name, size: blob.size, savedAt: Date.now() })
    state.downloads[id] = { size: blob.size, savedAt: Date.now(), name }
    await db.set('kv', 'downloads', state.downloads)
    navigator.storage?.persist?.()
    emit()
}

export async function download(book) {
    if (isDownloaded(book.id)) return
    const { blob, name } = await api.download(book.id)
    await storeFile(book.id, blob, name)
    cacheCover(book)
}

export async function removeDownload(id) {
    await db.del('files', id)
    delete state.downloads[id]
    await db.set('kv', 'downloads', state.downloads)
    emit()
}

async function cacheCover(book) {
    try {
        const { coverUrl } = await import('./api.js')
        const c = await caches.open('folio-covers')
        const url = coverUrl(book.id)
        if (!(await c.match(url))) await c.add(url)
    } catch {}
}

export function search(q) {
    q = q.trim().toLowerCase()
    if (!q) return []
    const words = q.split(/\s+/)
    return state.books.filter(b => {
        const hay = `${b.title} ${b.series} ${b.author}`.toLowerCase()
        return words.every(w => hay.includes(w))
    })
}
