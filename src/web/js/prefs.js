// Cove's own per-person settings, one record per store: sagas (saga progress), watching (orange pins, hidden items),
// home (row order), subs (subtitle style), play (playback choices).
// Since Nov 20, 2026 they live in cove-api (/cove-api/prefs?store=), not inside one server, so they stay the same when
// store copies it over from Jellyfin's display preferences (client "cove", id "cove-<store>"), and every write also
// updates that Jellyfin copy for now, so older Apple app builds keep seeing the same values.
import * as api from './api.js'

const IDS = { sagas: 'cove-sagas', watching: 'cove-watching', home: 'cove-home', subs: 'cove-subs', play: 'cove-play' }
// keys Jellyfin's own web app puts in every display-prefs record; not ours
const JF_KEYS = new Set(['chromecastVersion', 'skipForwardLength', 'skipBackLength', 'enableNextVideoInfoOverlay', 'tvhome', 'dashboardTheme'])

async function cove(method, store, prefs) {
    const r = await fetch(`/cove-api/prefs?store=${store}`, {
        method, headers: { Authorization: api.authHeaderValue(), 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ prefs }) : undefined })
    if (!r.ok) throw new Error(`prefs ${r.status}`)
    return r.json()
}
async function jfRead(store) {
    try { return await api.request(`/DisplayPreferences/${IDS[store]}`, { query: { userId: api.userId(), client: 'cove' } }) } catch { return null }
}
async function jfWrite(store, prefs) {
    const p = (await jfRead(store)) || {}
    const keep = Object.fromEntries(Object.entries(p.CustomPrefs || {}).filter(([k]) => JF_KEYS.has(k)))
    const body = { SortBy: 'SortName', SortOrder: 'Ascending', RememberIndexing: false, PrimaryImageHeight: 0, PrimaryImageWidth: 0,
        ScrollDirection: 'Horizontal', ShowBackdrop: false, RememberSorting: false, ShowSidebar: false, ...p, Id: IDS[store], Client: 'cove', CustomPrefs: { ...keep, ...prefs } }
    await api.request(`/DisplayPreferences/${IDS[store]}`, { method: 'POST', query: { userId: api.userId(), client: 'cove' }, body })
}
const ours = o => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !JF_KEYS.has(k)))

async function read(store) {
    try {
        const r = await cove('GET', store)
        if (r.found) return r.prefs
        // first time: bring the Jellyfin copy over
        const jf = ours((await jfRead(store))?.CustomPrefs)
        if (Object.keys(jf).length) await cove('POST', store, jf).catch(() => {})
        return jf
    } catch {
        return ours((await jfRead(store))?.CustomPrefs)   // cove-api down: still works from the Jellyfin copy
    }
}
export async function get(store) {
    return (await read(store)) || {}
}
export async function update(store, fn) {
    const prefs = { ...((await read(store)) || {}) }
    fn(prefs)
    await cove('POST', store, prefs)
    jfWrite(store, prefs).catch(() => {})   // mirror for older app builds
    return prefs
}
