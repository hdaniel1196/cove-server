// Full series lists (Hardcover/Goodreads data via Chaptarr, served by folio-api) matched to the
// Kavita library, plus "Get this book" requests.
import { currentUser, folioApi, OfflineError } from './api.js'
import * as lib from './library.js'
import * as db from './db.js'

let data = null          // { updatedAt, authors: [{ name, id, series: [{ title, books: [...] }] }] }
let requests = []        // [{ bookId, title, author, requestedAt, state, progress }]
const memo = new Map()   // kavita seriesId -> match
const emit = () => dispatchEvent(new Event('folio:library'))

addEventListener('folio:library', () => memo.clear())

export const isAdmin =() => (currentUser()?.roles ?? []).includes('Admin')
const call = (path, { method = 'GET', body } = {}) => folioApi(path, { method, body })

export async function init() {
    data = (await db.get('kv', 'seriesInfo')) ?? null
    memo.clear()
    refresh()
}

export async function refresh() {
    try {
        const fresh = await call('series')
        if (fresh?.updatedAt !== data?.updatedAt) {
            data = fresh
            memo.clear()
            await db.set('kv', 'seriesInfo', data)
            emit()
        }
        await refreshRequests()
    } catch (e) { if (!(e instanceof OfflineError)) console.warn('series info', e) }
}

export async function refreshRequests() {
    try {
        const prev = JSON.stringify(requests)
        requests = await call('requests')
        if (JSON.stringify(requests) !== prev) emit()
    } catch {}
    clearTimeout(refreshRequests.t)
    if (requests.some(r => r.state === 'searching' || r.state === 'downloading'))
        refreshRequests.t = setTimeout(refreshRequests, 30_000)
    // a finished download shows up in Kavita after the intake job; refresh the library once
    const done = requests.filter(r => r.state === 'downloaded' && !lib.state.books.some(b => normTitle(b.title) === normTitle(r.title)))
    if (done.length && Date.now() - (refreshRequests.libAt ?? 0) > 5 * 60_000) { refreshRequests.libAt = Date.now(); lib.refresh() }
}

export const requestFor = chaptarrId => requests.find(r => r.bookId === chaptarrId)
export const allRequests = () => requests

export async function getBook(entry) {
    const r = await call('get', { method: 'POST', body: { bookId: entry.id } })
    requests = [{ bookId: entry.id, ...r, state: 'searching' }, ...requests.filter(x => x.bookId !== entry.id)]
    emit()
    setTimeout(refreshRequests, 20_000)
    return r
}

export async function syncAuthors() {
    const authors = [...new Set(lib.state.books.flatMap(b => (b.author || '').split(', ')).filter(a => a && a !== 'Various'))]
    return call('sync', { method: 'POST', body: { authors } })
}
export const syncStatus = () => call('sync')

// ------------------------------------------------------------------ matching
const STOP = /^(the|a|an)\s+/
export const normTitle = t => (t || '').toLowerCase().replace(/[’']/g, '').replace(STOP, '').replace(/[^a-z0-9]+/g, ' ').trim()
const normName = n => (n || '').toLowerCase().replace(/[^a-z]/g, '')
// equal, one a longer version of the other, or equal before a subtitle ("Eon" = "Eon: Dragoneye Reborn")
const mainPart = t => t.split(/\s*[:(]\s*|\s+-\s+/)[0]
function sameTitle(rawA, rawB) {
    const a = normTitle(rawA), b = normTitle(rawB)
    return a === b || (Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a)))
        || normTitle(mainPart(rawA)) === normTitle(mainPart(rawB))
}
const words = s => new Set(normTitle(s).split(' ').filter(w => w.length >= 4 && !/^(series|trilogy|chronicles|saga|cycle)$/.test(w)))

// The Hardcover series that best matches a Kavita series, with each entry linked to an owned book
export function seriesInfo(seriesId) {
    if (!data) return null
    if (memo.has(seriesId)) return memo.get(seriesId)
    const owned = lib.seriesBooks(seriesId)
    const authors = new Set(owned.flatMap(b => (b.author || '').split(', ')).map(normName))
    const cands = data.authors.filter(a => authors.has(normName(a.name))).flatMap(a => a.series)
    const ownedNorm = owned.map(b => [b, b.title])
    const kName = words(lib.state.seriesById.get(seriesId)?.name ?? '')
    const need = Math.max(1, Math.ceil(owned.length * 0.5))   // at least half of what's in Kavita must match
    let best = null
    for (const s of cands) {
        const main = s.books.filter(e => /^\d+$/.test(e.pos))
        if (!main.length) continue
        const hits = new Set()
        for (const e of main) {
            for (const [b, bt] of ownedNorm) if (sameTitle(e.title, bt)) hits.add(b.id)
        }
        const overlap = hits.size
        if (overlap < need) continue
        // Jaccard: the tightest list wins (The Tawny Man beats the 16-book Realm of the Elderlings);
        // small bonus when the series names share a word (Fitz and the Fool over its Finnish twin)
        const shared = [...words(s.title)].some(w => kName.has(w))
        const score = overlap / (main.length + owned.length - overlap) + (shared ? 0.05 : 0)
        if (!best || score > best.score) best = { s, score, overlap }
    }
    if (!best) { memo.set(seriesId, null); return null }
    const allOwned = lib.state.books.map(b => [b, b.title])
    const used = new Set()
    let entries = best.s.books.map(e => {
        const book = (ownedNorm.find(([b, bt]) => !used.has(b.id) && sameTitle(e.title, bt))
            ?? allOwned.find(([b, bt]) => !used.has(b.id) && sameTitle(e.title, bt)))?.[0] ?? null
        if (book) used.add(book.id)
        return { ...e, main: /^\d+$/.test(e.pos), owned: book }
    })
    // titles that didn't line up (a foreign edition name): pair by number within the series
    for (const e of entries) {
        if (e.owned || !e.main) continue
        const b = owned.find(b => !used.has(b.id) && b.number != null && String(b.number) === e.pos)
        if (b) { e.owned = b; used.add(b.id) }
    }
    // umbrella list (a whole saga) standing in for one series: keep only the stretch this series covers
    const here = entries.filter(e => e.owned?.seriesId === seriesId).map(e => +e.pos)
    const umbrella = entries.some(e => e.main && e.owned && e.owned.seriesId !== seriesId)
    if (umbrella && here.length) {
        const lo = Math.min(...here), hi = Math.max(...here)
        entries = entries.filter(e => +e.pos >= Math.floor(lo) && +e.pos <= hi)
    }
    const main = entries.filter(e => e.main)
    const info = {
        released: main.filter(e => e.owned || !isUpcoming(e)),
        sameName: [...words(best.s.title)].some(w => kName.has(w)),
        title: best.s.title,
        umbrella,
        entries, main, extras: entries.filter(e => !e.main),
        missing: main.filter(e => !e.owned),
        upcoming: e => !e.owned && isUpcoming(e),
        numbering: main.filter(e => e.owned && e.owned.seriesId === seriesId && e.owned.number != null && String(e.owned.number) !== e.pos),
        rating: avg(main.map(e => e.rating).filter(Boolean)),
    }
    memo.set(seriesId, info)
    return info
}
// not out yet: release date in the future, or no date and almost no ratings (The Winds of Winter)
export function isUpcoming(e) {
    if (e.date) return Date.parse(e.date + 'T12:00:00') > Date.now()
    if (e.year) return +e.year > new Date().getFullYear()
    return (e.votes ?? 0) <= 25
}
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

export function bookInfo(book) {
    const info = seriesInfo(book.seriesId)
    return info?.entries.find(e => e.owned?.id === book.id) ?? null
}

// series you've started or finished whose next book isn't in the library yet
export function missingNext() {
    if (!data) return []
    const out = []
    for (const s of lib.state.series) {
        const owned = lib.seriesBooks(s.id)
        if (!owned.some(b => lib.isFinished(b) || lib.isStarted(b))) continue
        if (owned.some(b => !lib.isFinished(b))) continue   // still has unread books in the library
        const info = seriesInfo(s.id)
        const next = info?.main.find(e => !e.owned && !info.upcoming(e))
        if (next) out.push({ entry: next, series: s, info })
    }
    return out
}

export const fmtVotes = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n ?? 0)
