// Jellyfin keeps two lists that fight: Resume (every half-watched item, several per show, never moves on) and Next Up
// (one per show, skips a show whose next episode is half-watched). Here they become one row:
//   - one card per show or movie
//   - a show shows its in-progress episode if that's the latest thing you did with it, otherwise the next episode after
//     the latest one you finished (a stale half-watched older episode is ignored); nothing new = the show leaves the row
//     and comes back by itself when a new episode arrives (Next Up finds it)
//   - movies only while partway through (or pinned orange)
//   - newest activity first, orange pins in front
//   - "taken off" (plain) stays off until you watch it again
import * as api from './api.js'
import * as watching from './watching.js'

const t = d => (d ? Date.parse(d) : 0) || 0
const FIELDS = 'Tags,PrimaryImageAspectRatio,ProductionYear,OfficialRating,RunTimeTicks,UserData,ParentBackdropImageTags,BackdropImageTags,ImageTags,SeriesPrimaryImage'

async function lastFinished(seriesId) {
    const d = await api.items({ parentId: seriesId, includeItemTypes: 'Episode', filters: 'IsPlayed', sortBy: 'DatePlayed', sortOrder: 'Descending', limit: 1, fields: 'UserData' }).catch(() => null)
    return d?.Items?.[0] ?? null
}

export async function buildContinue(parentId) {
    const [resume, nextUp, pinnedIds, hidden] = await Promise.all([
        api.request('/UserItems/Resume', { query: { userId: api.userId(), parentId, limit: 100, fields: FIELDS, mediaTypes: 'Video' } }).then(d => d.Items).catch(() => []),
        api.request('/Shows/NextUp', { query: { userId: api.userId(), parentId, limit: 100, fields: FIELDS, enableResumable: false, enableRewatching: false } }).then(d => d.Items).catch(() => []),
        parentId ? [] : watching.list().catch(() => []),
        watching.hiddenMap().catch(() => ({})),
    ])
    const byKey = new Map()              // show id or movie id -> { item, when }
    const put = (k, item, when) => { const cur = byKey.get(k); if (!cur || when > cur.when) byKey.set(k, { item, when }) }

    // movies in progress; episodes in progress grouped by show (latest one per show)
    const epResume = new Map()
    for (const it of resume) {
        if (it.Type === 'Episode' && it.SeriesId) {
            const cur = epResume.get(it.SeriesId)
            if (!cur || t(it.UserData?.LastPlayedDate) > t(cur.UserData?.LastPlayedDate)) epResume.set(it.SeriesId, it)
        } else put(it.Id, it, t(it.UserData?.LastPlayedDate))
    }
    // per show: in-progress episode vs next episode after the latest finished one
    const shows = new Set([...epResume.keys(), ...nextUp.map(n => n.SeriesId)])
    await Promise.all([...shows].map(async sid => {
        const inProg = epResume.get(sid)
        const next = nextUp.find(n => n.SeriesId === sid)
        const done = await lastFinished(sid)
        const doneAt = t(done?.UserData?.LastPlayedDate)
        const progAt = t(inProg?.UserData?.LastPlayedDate)
        if (inProg && (!next || progAt >= doneAt)) put(sid, inProg, progAt || doneAt)
        else if (next) put(sid, next, doneAt)
        else if (inProg) put(sid, inProg, progAt)
    }))
    // taken off: stays off until there's newer activity
    for (const [k, v] of byKey) if (hidden[k] && v.when <= hidden[k]) byKey.delete(k)

    const rows = [...byKey.values()].sort((a, b) => b.when - a.when).map(v => v.item)
    // orange pins in front (main Home only)
    if (pinnedIds.length) {
        const pins = await watching.continueItems(new Set()).catch(() => [])
        const keyOf = it => it.Type === 'Episode' ? it.SeriesId : it.Id
        const pinKeys = new Set(pins.map(keyOf))
        return [...pins, ...rows.filter(r => !pinKeys.has(keyOf(r)))]
    }
    return rows
}
