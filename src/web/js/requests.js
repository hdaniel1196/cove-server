// Requests (the Jellyfin Enhanced idea, ours): search shows what isn't in Cove yet, "Request" sends it to Seerr
// as you, movies in HD or 4K (4K = Radarr "Ultra-HD", for favorites), shows by season, and Requests follows them
// with download progress. Everything goes through cove-api, which holds Seerr's key.
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'

async function get(path) {
    const r = await fetch('/cove-api' + path, { headers: { Authorization: api.authHeaderValue() } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `failed (${r.status})`)
    return d
}
const STATUS_LABEL = { requested: 'Requested', downloading: 'Downloading', 'partly here': 'Partly here', here: 'In Cove' }

export async function seerrSearch(q) {
    try { return (await get('/seerr/search?q=' + encodeURIComponent(q))).results } catch { return [] }
}

// Search page section: things Seerr knows that aren't fully in Cove
export function notInCoveShelf(results, after) {
    const items = results.filter(r => r.status !== 'here' && r.poster)
    if (!items.length) return null
    return h('section.shelf.not-in-library',
        h('div.shelf-head', h('div', h('h2', 'Not in your library yet'), h('div.muted.small', 'From TheMovieDb. Tap one to see what it is, or request it.'))),
        h('div.shelf-row', items.map(r => h('button.card.poster.req-card', { onclick: () => requestSheet(r, after) },
            h('div.art', h('img', { src: r.poster, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
                h('span.req-tag.out' + (STATUS_LABEL[r.status] ? '.on' : ''), STATUS_LABEL[r.status] || 'Not in library')),
            h('div.card-title', r.title),
            h('div.card-sub', [r.year, r.mediaType === 'tv' ? 'Show' : 'Movie'].filter(Boolean).join(' · '))))))
}

export function requestSheet(r, after) {
    const body = h('div.req-sheet')
    const s = sheet(body, { title: r.mediaType === 'tv' ? 'Request a Show' : 'Request a Movie', className: 'menu', wide: true })
    const head = h('div.req-head',
        r.poster ? h('img.req-poster', { src: r.poster, alt: '', referrerpolicy: 'no-referrer' }) : null,
        h('div',
            h('h3', r.title), h('div.muted', [r.year, r.rating ? `★ ${r.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')),
            r.overview ? h('p.req-over', r.overview) : null))
    const go = async (payload, btn) => {
        btn.disabled = true; btn.textContent = 'Sending…'
        try {
            const x = await api.helper('/seerr/request', { mediaType: r.mediaType, tmdbId: r.tmdbId, ...payload })
            toast(x.status === 'waiting for approval' ? `Requested. It’s waiting for an OK from ${api.ownerName()}.` : 'Requested. It’ll show up in Cove once it’s downloaded.', 3500)
            s.close(); after?.()
        } catch (e) { toast('Couldn’t request it: ' + e.message, 4000); btn.disabled = false; btn.textContent = 'Request' }
    }
    if (r.mediaType === 'movie') {
        let q = 'hd'
        const opt = (v, label, note) => h('button.req-opt' + (v === q ? '.on' : ''), { onclick: () => { q = v; draw() } },
            h('div.req-opt-name', label), h('div.muted.small', note))
        const opts = h('div.req-opts')
        const btn = h('button.pill.white.block', { onclick: () => go({ quality: q }, btn) }, 'Request')
        const draw = () => opts.replaceChildren(opt('hd', 'HD 1080p', 'Good quality, smaller file. Most movies.'), opt('4k', '4K', 'Ultra-HD, for favorites. Big file.'))
        draw()
        body.replaceChildren(head, h('div.menu-label', 'Quality'), opts, btn)
    } else {
        body.replaceChildren(head, h('div.loading-page', h('div.spinner')))
        get('/seerr/tv?id=' + r.tmdbId).then(({ seasons }) => {
            const picked = new Set(seasons.filter(x => x.status !== 'here' && x.status !== 'requested' && x.status !== 'downloading').map(x => x.n))
            const list = h('div.req-seasons')
            const btn = h('button.pill.white.block', { onclick: () => {
                if (!picked.size) return toast('Pick at least one season')
                const all = seasons.filter(x => x.status !== 'here').every(x => picked.has(x.n))
                go({ seasons: all ? 'all' : [...picked] }, btn)
            } }, 'Request')
            const draw = () => list.replaceChildren(...seasons.map(x => {
                const locked = ['here', 'requested', 'downloading'].includes(x.status)
                return h('button.req-season' + (picked.has(x.n) ? '.on' : '') + (locked ? '.locked' : ''), {
                    disabled: locked, onclick: () => { picked.has(x.n) ? picked.delete(x.n) : picked.add(x.n); draw() } },
                    h('span.saga-check' + (picked.has(x.n) || x.status === 'here' ? '.on' : ''), icon('check')),
                    h('span', x.name || `Season ${x.n}`), h('span.muted.small', locked ? STATUS_LABEL[x.status] : `${x.episodes ?? '?'} episodes`))
            }))
            draw()
            body.replaceChildren(head, h('div.menu-label', 'Seasons'), list, btn)
        }).catch(e => body.replaceChildren(head, h('div.empty', 'Couldn’t load seasons: ' + e.message)))
    }
}

// Requests page: your requests with live download progress
export async function requestsPage(main) {
    if (!api.atLeast('member')) return main.replaceChildren(h('div.empty', 'Requests aren’t on for this account.'))
    const list = h('div.req-list', h('div.loading-page', h('div.spinner')))
    const pending = h('div')
    main.replaceChildren(
        h('header.page-head.row', h('h1', 'Requests'), h('a.pill.glass', { href: '#/search' }, icon('search'), ' Find something')),
        pending,
        h('p.muted.page-sub', 'What you asked for, and how far along it is. This page updates on its own.'),
        list)
    // owner + admins: requests from members waiting for an OK
    const drawPending = async () => {
        if (!api.atLeast('admin')) return
        let reqs = []
        try { reqs = (await get('/seerr/pending')).requests } catch { return }
        if (!reqs.length) return pending.replaceChildren()
        pending.replaceChildren(h('section.req-pending', h('h2', `Waiting for your OK (${reqs.length})`),
            h('div.req-list', reqs.map(r => h('div.req-row',
                r.poster ? h('img.req-thumb', { src: r.poster, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div.req-thumb'),
                h('div.req-info',
                    h('div.ep-title', r.title || 'Unknown'),
                    h('div.ep-num', [r.by, r.mediaType === 'tv' ? (r.seasons.length ? 'Seasons ' + r.seasons.join(', ') : 'Show') : 'Movie', r.is4k ? '4K' : null].filter(Boolean).join(' · ')),
                    h('div.tag-row',
                        h('button.pill.white.small', { onclick: () => decide(r.id, true) }, icon('check'), ' Approve'),
                        h('button.pill.glass.small', { onclick: () => decide(r.id, false) }, 'Decline'))))))))
    }
    const decide = async (id, approve) => {
        try { await api.helper('/seerr/decide', { id, approve }); toast(approve ? 'Approved. It’ll download now.' : 'Declined'); drawPending(); draw() }
        catch (e) { toast('Couldn’t do that: ' + e.message) }
    }
    drawPending()
    const draw = async () => {
        if (!list.isConnected) return clearInterval(t)
        let reqs
        try { reqs = (await get('/seerr/requests')).requests } catch (e) { return list.replaceChildren(h('div.empty', e.message)) }
        if (!reqs.length) return list.replaceChildren(h('div.empty', 'No requests yet. Search for a movie or show that isn’t in Cove.'))
        list.replaceChildren(...reqs.map(reqRow))
    }
    const t = setInterval(draw, 15000)
    draw()
}
function reqRow(r) {
    const line = r.status === 'here' ? 'In Cove' : r.request === 'declined' ? 'Declined' : r.request === 'failed' ? 'Failed'
        : r.progress.length ? 'Downloading' : r.request === 'waiting for approval' ? 'Waiting for approval' : r.status === 'partly here' ? 'Partly here' : 'Searching'
    return h('div.req-row',
        r.poster ? h('img.req-thumb', { src: r.poster, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div.req-thumb'),
        h('div.req-info',
            h('div.ep-title', r.title || 'Unknown'),
            h('div.ep-num', [r.mediaType === 'tv' ? (r.seasons.length ? 'Seasons ' + r.seasons.join(', ') : 'Show') : 'Movie', r.is4k ? '4K' : null,
                r.added ? new Date(r.added).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null].filter(Boolean).join(' · ')),
            h('div.req-state.' + line.toLowerCase().replace(/\s+/g, '-'), line),
            ...r.progress.slice(0, 3).map(p => h('div.req-prog',
                h('div.saga-prog', h('div', { style: { width: p.pct + '%' } })),
                h('span.muted.small', `${p.pct}%${p.eta ? ' · done ' + new Date(p.eta).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}`)))))
}

// Home: requests still on their way
export async function homeRequestsShelf() {
    let reqs = []
    try { reqs = (await get('/seerr/requests')).requests } catch { return null }
    const live = reqs.filter(r => r.status !== 'here' && !['declined', 'failed'].includes(r.request)).slice(0, 12)
    if (!live.length) return null
    return h('section.shelf',
        h('div.shelf-head', h('h2', 'On the Way'), h('a.more', { href: '#/requests' }, 'See All', icon('chevron'))),
        h('div.shelf-row', live.map(r => h('a.card.poster', { href: '#/requests' },
            h('div.art', r.poster ? h('img', { src: r.poster, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div.noart', r.title),
                r.progress[0] ? h('div.prog', h('div', { style: { width: r.progress[0].pct + '%' } })) : h('span.req-tag', r.request === 'waiting for approval' ? 'Waiting' : 'Searching')),
            h('div.card-title', r.title || ''),
            h('div.card-sub', r.progress[0] ? `${r.progress[0].pct}% downloaded` : r.is4k ? '4K' : '')))))
}
