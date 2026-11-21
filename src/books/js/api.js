// Kavita API client. Everything goes through /api on the same origin (nginx proxies to Kavita).
const AUTH = 'folio.auth'
let auth = load()
let refreshing = null

function load() {
    try { return JSON.parse(localStorage.getItem(AUTH)) } catch { return null }
}
function save(a) {
    auth = a
    try { a ? localStorage.setItem(AUTH, JSON.stringify(a)) : localStorage.removeItem(AUTH) } catch {}
}

export class OfflineError extends Error {}
export class AuthError extends Error {}

export const isLoggedIn = () => !!auth?.token
export const currentUser = () => auth

export async function login(username, password) {
    let r
    try {
        r = await fetch('/api/Account/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, apiKey: '' }),
        })
    } catch { throw new OfflineError("Can't reach Kavita") }
    if (!r.ok) {
        let msg = ''
        try { msg = (await r.text()).replace(/^"|"$/g, '') } catch {}
        throw new AuthError(r.status === 401 ? (msg || 'Wrong username or password') : `Sign-in failed (${r.status}) ${msg}`)
    }
    const u = await r.json()
    save({
        token: u.token, refreshToken: u.refreshToken, apiKey: u.apiKey,
        username: u.username, id: u.id, roles: u.roles ?? [],
    })
    return auth
}

export function logout() {
    save(null)
    dispatchEvent(new Event('folio:logout'))
}

async function refresh() {
    refreshing ??= (async () => {
        try {
            const r = await fetch('/api/Account/refresh-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: auth.token, refreshToken: auth.refreshToken }),
            })
            if (!r.ok) return false
            const t = await r.json()
            if (!t?.token) return false
            save({ ...auth, token: t.token, refreshToken: t.refreshToken })
            return true
        } catch { throw new OfflineError("Can't reach Kavita") }
        finally { setTimeout(() => refreshing = null, 0) }
    })()
    return refreshing
}

async function request(path, { method = 'GET', body, raw = false, retry = true, base = '/api/' } = {}) {
    if (!auth) throw new AuthError('Not signed in')
    const headers = { Authorization: `Bearer ${auth.token}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let r
    try {
        r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch { throw new OfflineError("Can't reach Kavita") }
    if (r.status === 401 && retry) {
        if (await refresh()) return request(path, { method, body, raw, retry: false, base })
        logout()
        throw new AuthError('Signed out')
    }
    if (!r.ok) {
        let msg = ''
        try { msg = (await r.json()).error ?? '' } catch {}
        throw new Error(msg || `${method} ${path}: ${r.status}`)
    }
    if (raw) return r
    const text = await r.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
}

const ALL = { statements: [], combination: 1, limitTo: 0, sortOptions: { sortField: 1, isAscending: true } }

export const api = {
    libraries: () => request('Library/libraries'),
    allSeries: () => request('Series/all-v2?PageNumber=1&PageSize=0', { method: 'POST', body: ALL }),
    volumes: seriesId => request(`Series/volumes?seriesId=${seriesId}`),
    seriesMetadata: seriesId => request(`Series/metadata?seriesId=${seriesId}`),
    wantToRead: () => request('want-to-read/v2?PageNumber=1&PageSize=0', { method: 'POST', body: ALL }),
    setWantToRead: (seriesId, on) => request(`want-to-read/${on ? 'add' : 'remove'}-series`,
        { method: 'POST', body: { seriesIds: [seriesId] } }),
    getProgress: chapterId => request(`Reader/get-progress?chapterId=${chapterId}`),
    saveProgress: p => request('Reader/progress', { method: 'POST', body: p }),
    markVolumeRead: (seriesId, volumeId) => request('Reader/mark-volume-read', { method: 'POST', body: { seriesId, volumeId } }),
    markVolumeUnread: (seriesId, volumeId) => request('Reader/mark-volume-unread', { method: 'POST', body: { seriesId, volumeId } }),
    // Sagas = Kavita reading lists (ordered books across series)
    readingLists: () => request('ReadingList/lists?includePromoted=true&sortByLastModified=false&PageNumber=1&PageSize=0', { method: 'POST', body: {} }),
    readingListItems: id => request(`ReadingList/items?readingListId=${id}`),
    createReadingList: title => request('ReadingList/create', { method: 'POST', body: { title } }),
    addSeriesToList: (readingListId, seriesId) => request('ReadingList/update-by-series', { method: 'POST', body: { readingListId, seriesId } }),
    deleteReadingList: id => request(`ReadingList?readingListId=${id}`, { method: 'DELETE' }),
    updateReadingList: (readingListId, title, summary = '') => request('ReadingList/update', { method: 'POST', body: {
        readingListId, title, summary, promoted: false, coverImageLocked: false,
        startingMonth: 0, startingYear: 0, endingMonth: 0, endingYear: 0 } }),
    async download(chapterId) {
        const r = await request(`Download/chapter?chapterId=${chapterId}`, { raw: true })
        const cd = r.headers.get('Content-Disposition') || ''
        const name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1] || '')
            || (cd.match(/filename="?([^";]+)/i) || [])[1] || `book-${chapterId}.epub`
        return { blob: await r.blob(), name }
    },
}

// Folio's own helper service (series lists, "Get this book"); same Kavita login
export const folioApi = (path, opts = {}) => request(path, { ...opts, base: '/folio-api/' })

const key = () => encodeURIComponent(auth?.apiKey ?? '')
export const coverUrl = chapterId => `/api/Image/chapter-cover?chapterId=${chapterId}&apiKey=${key()}`
export const seriesCoverUrl = seriesId => `/api/Image/series-cover?seriesId=${seriesId}&apiKey=${key()}`
