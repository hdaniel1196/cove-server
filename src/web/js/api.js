// Jellyfin client. Everything goes through /jf on the same origin (nginx proxies to the jellyfin container).
const AUTH = 'cove.auth'
const DEVICE = 'cove.device'
export const VERSION = '0.1.0'
export const BASE = '/jf'

let auth = load()

function load() {
    try { return JSON.parse(localStorage.getItem(AUTH)) } catch { return null }
}
function save(a) {
    auth = a
    try { a ? localStorage.setItem(AUTH, JSON.stringify(a)) : localStorage.removeItem(AUTH) } catch {}
    if (a?.token && a.userId) { const all = loadAccounts(); all[a.userId] = a; saveAccounts(all) }
}
// signed in on this device keeps its session here; switching swaps it in, no password. Sign Out removes it from the device.
const ACCOUNTS = 'cove.accounts'
function loadAccounts() { try { return JSON.parse(localStorage.getItem(ACCOUNTS)) || {} } catch { return {} } }
function saveAccounts(all) { try { localStorage.setItem(ACCOUNTS, JSON.stringify(all)) } catch {} }
if (auth?.token && auth.userId && !loadAccounts()[auth.userId]) { const all = loadAccounts(); all[auth.userId] = auth; saveAccounts(all) }
export const accounts = () => Object.values(loadAccounts()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
export async function switchTo(uid) {
    const a = loadAccounts()[uid]
    if (!a) throw new AuthError('That account isn’t on this device anymore')
    const parts = [`Client="Cove"`, `Device="${deviceName()}"`, `DeviceId="${deviceId()}"`, `Version="${VERSION}"`, `Token="${a.token}"`]
    let r
    try { r = await fetch(`${BASE}/Users/Me`, { headers: { Authorization: 'MediaBrowser ' + parts.join(', ') } }) }
    catch { throw new OfflineError("Can't reach the server") }
    if (r.status === 401 || r.status === 403) { forget(uid); throw new AuthError(`${a.name} needs to sign in again`) }
    try { localStorage.removeItem('folio.auth') } catch {}   // Books session belongs to the old account
    save(a)
}
export function forget(uid) { const all = loadAccounts(); delete all[uid]; saveAccounts(all) }
// "Add Account": go to the sign-in screen but keep everyone already on this device
export function addAccount() {
    try { localStorage.removeItem('folio.auth') } catch {}
    save(null)
    dispatchEvent(new Event('cove:logout'))
}
function deviceId() {
    let id
    try { id = localStorage.getItem(DEVICE) } catch {}
    if (!id) {
        id = 'cove-' + crypto.randomUUID()
        try { localStorage.setItem(DEVICE, id) } catch {}
    }
    return id
}
function deviceName() {
    const ua = navigator.userAgent
    if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad'
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/Macintosh/.test(ua)) return 'Mac'
    if (/Windows/.test(ua)) return 'PC'
    return 'Browser'
}
function authHeader() {
    const parts = [`Client="Cove"`, `Device="${deviceName()}"`, `DeviceId="${deviceId()}"`, `Version="${VERSION}"`]
    if (auth?.token) parts.push(`Token="${auth.token}"`)
    return 'MediaBrowser ' + parts.join(', ')
}

export const authHeaderValue = () => authHeader()
export class OfflineError extends Error {}
export class AuthError extends Error {}

export const isLoggedIn = () => !!auth?.token
export const me = () => auth
export const token = () => auth?.token ?? ''
export const userId = () => auth?.userId ?? ''
export const isAdmin = () => !!auth?.admin
export const role = () => auth?.role || (auth?.admin ? 'admin' : 'member')
// which parts of Cove this person can use (owner/admins switch them per person, Nov 20, 2026)
export const parts = () => ({ reel: true, folio: !!auth?.books, vinyl: false, ...(auth?.parts || {}) })
export const ownerName = () => auth?.owner || 'the owner'
let infoCache = null
try { infoCache = JSON.parse(localStorage.getItem('cove.serverinfo')) } catch {}
export const cachedServerInfo = () => infoCache || {}
export async function serverInfo() {
    try {
        const r = await fetch('/cove-api/server-info')
        if (r.ok) { infoCache = await r.json(); try { localStorage.setItem('cove.serverinfo', JSON.stringify(infoCache)) } catch {} }
    } catch {}
    return cachedServerInfo()
}
serverInfo()
let hostCache = null
export async function hostInfo() {
    if (hostCache) return hostCache
    try { const r = await fetch('/cove-api/admin/host', { headers: { Authorization: authHeader() } }); hostCache = r.ok ? await r.json() : {} } catch { hostCache = {} }
    return hostCache
}
export const hasBooks = () => !!auth?.books
const LEVEL = { kid: 0, teen: 1, member: 2, admin: 3, owner: 4 }
export const atLeast = r => (LEVEL[role()] ?? 2) >= LEVEL[r]   // e.g. atLeast('member') = can request
// refresh name + role after sign-in (e.g. the account was renamed)
export async function refreshMe() {
    try {
        const r = await fetch('/cove-api/me', { headers: { Authorization: authHeader() } })
        if (!r.ok) return
        const d = await r.json()
        if (!auth) return
        const changed = !!auth.books !== !!d.books || (d.role && d.role !== auth.role) || JSON.stringify(auth.parts || null) !== JSON.stringify(d.parts || null)
        save({ ...auth, name: d.name || auth.name, role: d.role || auth.role, books: !!d.books, parts: d.parts, owner: d.owner })
        if (changed) dispatchEvent(new Event('cove:me'))
    } catch {}
}

// Sign in with an email (or account name) through cove-api, which finds the Jellyfin account; if the helper is down,
// fall back to signing in with the account name directly.
export async function login(who, password) {
    try {
        const h = await fetch('/cove-api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
            body: JSON.stringify({ login: who, password }) })
        if (h.status === 401) throw new AuthError('Wrong email or password')
        if (h.status === 429) { const d = await h.json().catch(() => ({})); throw new AuthError(d.error || 'Too many wrong tries. Wait a minute and try again.') }
        if (h.ok) { const d = await h.json(); const a = saveResult(d); a.role = d.CoveRole; a.books = !!d.CoveBooks; a.parts = d.CoveParts; save(a); return a }
    } catch (e) { if (e instanceof AuthError) throw e }
    return loginDirect(who, password)
}
async function loginDirect(username, password) {
    let r
    try {
        r = await fetch(`${BASE}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
            body: JSON.stringify({ Username: username, Pw: password }),
        })
    } catch { throw new OfflineError("Can't reach the server") }
    if (r.status === 401 || r.status === 400) throw new AuthError('Wrong name or password')
    if (!r.ok) throw new AuthError(`Sign-in failed (${r.status})`)
    return saveResult(await r.json())
}

function saveResult(d) {
    save({
        token: d.AccessToken, userId: d.User.Id, name: d.User.Name,
        admin: !!d.User.Policy?.IsAdministrator, imageTag: d.User.PrimaryImageTag ?? null,
        subs: d.User.Configuration?.SubtitleMode === 'Always' ? 'always' : null,
    })
    return auth
}

// Sign in with a code (Jellyfin Quick Connect): this device shows a code, a signed-in device approves it.
async function anon(path, opts = {}) {
    let r
    try { r = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: authHeader(), ...(opts.headers || {}) } }) }
    catch { throw new OfflineError("Can't reach the server") }
    if (!r.ok) throw new AuthError(`Code sign-in failed (${r.status})`)
    return r.json()
}
export const codeStart = () => anon('/QuickConnect/Initiate', { method: 'POST' })
export const codeCheck = secret => anon('/QuickConnect/Connect?secret=' + encodeURIComponent(secret))
export async function codeFinish(secret) {
    return saveResult(await anon('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: JSON.stringify({ Secret: secret }) }))
}
export const approveCode = code => request('/QuickConnect/Authorize', { method: 'POST', query: { code, userId: userId() } })

export async function logout() {
    try { localStorage.removeItem('folio.auth') } catch {}   // Books session goes with it
    try { await fetch(`${BASE}/Sessions/Logout`, { method: 'POST', headers: { Authorization: authHeader() } }) } catch {}
    if (auth?.userId) forget(auth.userId)
    save(null)
    dispatchEvent(new Event('cove:logout'))
}

export async function request(path, { method = 'GET', body, query, raw = false, rawBody, contentType } = {}) {
    if (!auth) throw new AuthError('Not signed in')
    const headers = { Authorization: authHeader() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (rawBody !== undefined) headers['Content-Type'] = contentType || 'application/octet-stream'
    let url = BASE + path
    if (query) {
        const q = new URLSearchParams()
        for (const [k, v] of Object.entries(query)) if (v != null && v !== '') q.set(k, Array.isArray(v) ? v.join(',') : v)
        url += (url.includes('?') ? '&' : '?') + q
    }
    let r
    try {
        r = await fetch(url, { method, headers, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) })
    } catch { throw new OfflineError("Can't reach the server") }
    if (r.status === 401) {
        save(null)
        dispatchEvent(new Event('cove:logout'))
        throw new AuthError('Signed out')
    }
    if (!r.ok) throw new Error(`${method} ${path} failed (${r.status})`)
    if (raw) return r
    if (r.status === 204) return null
    const t = await r.text()
    return t ? JSON.parse(t) : null
}

// ------------------------------------------------------------------ library calls
const FIELDS = 'Overview,PrimaryImageAspectRatio,ProductionYear,OfficialRating,RunTimeTicks,Genres,ChildCount,RecursiveItemCount,UserData,SeriesPrimaryImage,ParentBackdropImageTags,BackdropImageTags,ImageTags,Tags,Taglines,CommunityRating,CriticRating,People,Studios,MediaSources,MediaStreams,EndDate,Status,ProviderIds,AirDays,AirTime,RemoteTrailers'
const CARD_FIELDS = 'Tags,PrimaryImageAspectRatio,ProductionYear,OfficialRating,RunTimeTicks,UserData,ParentBackdropImageTags,BackdropImageTags,ImageTags,SeriesPrimaryImage'

export const views = () => request(`/UserViews`, { query: { userId: userId() } }).then(d => d.Items)
export const item = id => request(`/Items/${id}`, { query: { userId: userId(), fields: FIELDS } })
export const resume = parentId => request(`/UserItems/Resume`, {
    query: { userId: userId(), parentId, limit: 16, fields: CARD_FIELDS, mediaTypes: 'Video', enableImageTypes: 'Primary,Backdrop,Thumb' },
}).then(d => d.Items)
export const nextUp = (seriesId, parentId) => request(`/Shows/NextUp`, {
    query: { userId: userId(), limit: seriesId ? 1 : 16, fields: CARD_FIELDS, seriesId, parentId, enableResumable: false, enableRewatching: false },
}).then(d => d.Items)
export const latest = parentId => request(`/Items/Latest`, {
    query: { userId: userId(), parentId, limit: 18, fields: CARD_FIELDS, groupItems: true },
})
export const items = query => request(`/Items`, {
    query: { userId: userId(), recursive: true, fields: CARD_FIELDS, ...query },
})
export const seasons = seriesId => request(`/Shows/${seriesId}/Seasons`, { query: { userId: userId(), fields: CARD_FIELDS } }).then(d => d.Items)
export const episodes = (seriesId, seasonId) => request(`/Shows/${seriesId}/Episodes`, {
    query: { userId: userId(), seasonId, fields: 'Overview,RunTimeTicks,UserData,ImageTags,PrimaryImageAspectRatio,PremiereDate,Tags' },
}).then(d => d.Items)
export const adjacent = (seriesId, id) => request(`/Shows/${seriesId}/Episodes`, {
    query: { userId: userId(), adjacentTo: id, fields: 'Overview,RunTimeTicks,UserData,ImageTags' },
}).then(d => d.Items)
export const similar = id => request(`/Items/${id}/Similar`, { query: { userId: userId(), limit: 16, fields: CARD_FIELDS } }).then(d => d.Items)
export const segments = id => request(`/MediaSegments/${id}`).then(d => d.Items ?? []).catch(() => [])
export const setPlayed = (id, played) => request(`/UserPlayedItems/${id}`, { method: played ? 'POST' : 'DELETE', query: { userId: userId() } })
// forget the resume spot (takes it off Continue Watching) without touching watched / play count
export const clearResume = id => request(`/UserItems/${id}/UserData`, { method: 'POST', query: { userId: userId() }, body: { PlaybackPositionTicks: 0 } })
// change your own password (Jellyfin checks the current one)
export async function changePassword(current, next) {
    const r = await fetch(`${BASE}/Users/${userId()}/Password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
        body: JSON.stringify({ CurrentPw: current, NewPw: next }) }).catch(() => { throw new OfflineError("Can't reach the server") })
    if (r.status === 403 || r.status === 401) throw new AuthError('Your current password isn’t right')
    if (!r.ok) throw new Error(`Couldn’t change it (${r.status})`)
}
export const setFavorite = (id, fav) => request(`/UserFavoriteItems/${id}`, { method: fav ? 'POST' : 'DELETE', query: { userId: userId() } })
export const search = term => request(`/Items`, {
    query: { userId: userId(), recursive: true, searchTerm: term, includeItemTypes: 'Movie,Series,Episode', limit: 40, fields: CARD_FIELDS },
}).then(d => d.Items)

// ------------------------------------------------------------------ images
export function img(item, type = 'Primary', { w, h: ht, q = 90 } = {}) {
    let id = item.Id, tag = item.ImageTags?.[type]
    if (type === 'Backdrop') {
        if (item.BackdropImageTags?.length) tag = item.BackdropImageTags[0]
        else if (item.ParentBackdropImageTags?.length) { id = item.ParentBackdropItemId; tag = item.ParentBackdropImageTags[0] }
        else return null
    } else if (!tag && type === 'Primary' && item.SeriesPrimaryImageTag) { id = item.SeriesId; tag = item.SeriesPrimaryImageTag }
    if (!tag) return null
    const q2 = new URLSearchParams({ tag, quality: q })
    if (w) q2.set('maxWidth', w)
    if (ht) q2.set('maxHeight', ht)
    return `${BASE}/Items/${id}/Images/${type}?${q2}`
}
export async function refreshPicture() {
    try { const u = await request('/Users/Me'); if (auth) save({ ...auth, imageTag: u.PrimaryImageTag ?? null }) } catch {}
}
export function userImg() {
    if (!auth?.imageTag) return null
    return `${BASE}/Users/${auth.userId}/Images/Primary?tag=${auth.imageTag}&maxWidth=120`
}

// ------------------------------------------------------------------ image editing (admins)
export const itemImages = id => request(`/Items/${id}/Images`)
export const remoteImages = (id, type, allLanguages = false) => request(`/Items/${id}/RemoteImages`, { query: { type, includeAllLanguages: allLanguages, limit: 80 } })
export const remoteProviders = id => request(`/Items/${id}/RemoteImages/Providers`)
export const downloadImage = (id, type, imageUrl) => request(`/Items/${id}/RemoteImages/Download`, { method: 'POST', query: { type, imageUrl } })
export const deleteImage = (id, type, index) => request(`/Items/${id}/Images/${type}` + (index != null ? `/${index}` : ''), { method: 'DELETE' })
// Jellyfin takes the picture as base64 text with the image's own content type
export async function uploadImage(id, type, file) {
    const b64 = await new Promise((ok, fail) => {
        const r = new FileReader()
        r.onload = () => ok(String(r.result).split(',')[1])
        r.onerror = () => fail(new Error('Could not read the file'))
        r.readAsDataURL(file)
    })
    return request(`/Items/${id}/Images/${type}`, { method: 'POST', rawBody: b64, contentType: file.type || 'image/jpeg' })
}
export const imageUrl = (id, type, index, w = 600) =>
    `${BASE}/Items/${id}/Images/${type}${index != null ? '/' + index : ''}?maxWidth=${w}&quality=90&v=${Date.now()}`

// Cove's helper: pictures go through Emby so both servers read the same file next to the media
export async function helper(path, body) {
    let r
    try { r = await fetch('/cove-api' + path, { method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    catch { throw new OfflineError("Can't reach the server") }
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `helper failed (${r.status})`)
    return d
}
export const fileToBase64 = file => new Promise((ok, fail) => {
    const rd = new FileReader()
    rd.onload = () => ok(String(rd.result).split(',')[1])
    rd.onerror = () => fail(new Error('Could not read the file'))
    rd.readAsDataURL(file)
})

export const accountSubs = () => auth?.subs ?? null
// subtitle default per account on this device (switching accounts on a shared TV keeps each one's choice); old device-wide value as a fallback
export const subsKey = () => 'cove.subs.' + (auth?.userId || '')
export function subsMode() {
    try { return localStorage.getItem(subsKey()) || auth?.subs || localStorage.getItem('cove.subs') || 'smart' } catch { return 'smart' }
}
export function setSubsMode(v) { try { localStorage.setItem(subsKey(), v) } catch {} }
