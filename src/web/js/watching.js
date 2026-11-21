// resume spot. Stored per user in Jellyfin display preferences ("cove-watching", client "cove"), so it follows you
// to every device. A movie drops off once it's watched; a show stays until it has no next episode.
import * as api from './api.js'

import * as store from './prefs.js'

const ids = c => (c.items || '').split(',').filter(Boolean)
const hiddenOf = c => Object.fromEntries((c.hidden || '').split(',').filter(Boolean).map(x => { const [k, v] = x.split(':'); return [k, +v] }))
const hiddenStr = m => Object.entries(m).slice(-300).map(([k, v]) => `${k}:${v}`).join(',')

export async function list() { return ids(await store.get('watching')) }
// taken off Continue Watching (plain): id -> time; it stays off until there's newer activity
export async function hiddenMap() { return hiddenOf(await store.get('watching')) }
export async function hide(id, on = true) {
    await store.update('watching', c => { const m = hiddenOf(c); if (on) m[id] = Date.now(); else delete m[id]; c.hidden = hiddenStr(m) })
}
export async function isWatching(id) { return (await list()).includes(id) }
export async function setWatching(id, on) {
    await store.update('watching', c => {
        const l = ids(c).filter(x => x !== id)
        if (on) { l.unshift(id); const m = hiddenOf(c); delete m[id]; c.hidden = hiddenStr(m) }   // newest first; pinning un-hides
        c.items = l.slice(0, 60).join(',')
    })
}

// cards for Continue Watching: a movie as itself, a show as its next episode (or its first one)
export async function continueItems(skipIds = new Set()) {
    const pinned = await list()
    const out = [], drop = []
    for (const id of pinned) {
        try {
            const it = await api.item(id)
            if (skipIds.has(it.Id)) continue          // already in Continue Watching (a resume spot)
            if (it.Type === 'Series') {
                let ep = (await api.nextUp(it.Id))[0]
                if (!ep) {
                    const eps = await api.episodes(it.Id)
                    if (eps.every(e => e.UserData?.Played)) { drop.push(id); continue }
                    ep = eps.find(e => !e.UserData?.Played)
                }
                if (ep && !skipIds.has(ep.Id)) out.push(ep)
            } else {
                if (it.UserData?.Played) { drop.push(id); continue }
                if (!skipIds.has(it.Id)) out.push(it)
            }
        } catch { /* gone from the library */ drop.push(id) }
    }
    if (drop.length) store.update('watching', c => { c.items = (c.items || '').split(',').filter(x => x && !drop.includes(x)).join(',') }).catch(() => {})
    return out
}
