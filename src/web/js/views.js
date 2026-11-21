// Pages: Home, Library, Item (movie / series), Search, Settings. Apple TV app style.
import * as api from './api.js'
import { h, icon, toast, toastAction, runtime, epNum, epTitle, sheet } from './ui.js'
import { subLabel } from './player.js'
import { continueSagasCards } from './sagas.js'
import * as watching from './watching.js'
import { buildContinue } from './continue.js'
import * as store from './prefs.js'
import { tagChips, tagEditor, tagPage as tagPageImpl, libraryTagRow, episodeTagBar, hiddenFor, tagHref } from './tags.js'
import { seerrSearch, notInCoveShelf, homeRequestsShelf } from './requests.js'
import * as passkey from './passkey.js'
import * as play from './playprefs.js'
import { jellyfinUserGroup, pictureRow } from './jfuser.js'
import { pinGate, pinRow, hasPins } from './pin.js'
import { keysSheet } from './keys.js'

const LIB_ICON = { movies: 'film', tvshows: 'tv' }
export let libs = []
export let liveView = null   // Jellyfin adds a "livetv" view for people with Live TV
export async function loadLibs() {
    const all = await api.views()
    liveView = all.find(v => v.CollectionType === 'livetv') || null
    libs = all.filter(v => ['movies', 'tvshows'].includes(v.CollectionType))
    return libs
}
const go = hash => () => { location.hash = hash }
const playHash = (id, fromStart, pick = {}) => {
    const q = new URLSearchParams()
    if (fromStart) q.set('start', '0')
    if (pick.audio != null) q.set('audio', pick.audio)
    if (pick.sub != null) q.set('sub', pick.sub)
    const qs = q.toString()
    return `#/play/${id}${qs ? '?' + qs : ''}`
}

// ------------------------------------------------------------------ cards
function progressOf(it) {
    const p = it.UserData?.PlayedPercentage
    return p && p > 0 && p < 100 ? p : 0
}
function poster(it) {
    // a new episode shows its show's poster (not the episode's still squeezed into a poster frame); a new season keeps
    const showPoster = it.SeriesId && it.SeriesPrimaryImageTag
        ? `${api.BASE}/Items/${it.SeriesId}/Images/Primary?tag=${it.SeriesPrimaryImageTag}&maxWidth=360&quality=90` : null
    const src = it.Type === 'Episode' ? (showPoster ?? api.img(it, 'Primary', { w: 360 }))
        : it.Type === 'Season' ? (api.img(it, 'Primary', { w: 360 }) ?? showPoster) : api.img(it, 'Primary', { w: 360 })
    const part = it.Type === 'Episode' || it.Type === 'Season'   // a new season/episode shows as its show
    const target = part && it.SeriesId ? `#/item/${it.SeriesId}` : `#/item/${it.Id}`
    return h('a.card.poster', { href: target, title: it.Name },
        h('div.art', src ? h('img', { src, alt: '', loading: 'lazy' }) : h('div.noart', it.Name),
            it.UserData?.Played ? h('span.badge-check', icon('check')) : null,
            !it.UserData?.Played && it.UserData?.UnplayedItemCount ? h('span.badge-count', it.UserData.UnplayedItemCount) : null),
        h('div.card-title', part ? it.SeriesName : it.Name),
        h('div.card-sub', it.Type === 'Season' ? `New: ${it.Name}` : it.ProductionYear ?? ''))
}
function wide(it, { sub, check, collection } = {}) {
    const src = (it.Type === 'Episode' ? api.img(it, 'Primary', { w: 640 }) : null)
        ?? api.img(it, 'Thumb', { w: 640 }) ?? api.img(it, 'Backdrop', { w: 640 }) ?? api.img(it, 'Primary', { w: 640 })
    const p = progressOf(it)
    const title = it.Type === 'Episode' ? it.SeriesName : it.Name
    const subtitle = sub ?? (it.Type === 'Episode' ? [epNum(it), epTitle(it)].filter(Boolean).join(' \u00b7 ') : it.ProductionYear ?? '')
    const page = it.Type === 'Episode' && it.SeriesId ? `#/item/${it.SeriesId}` : `#/item/${it.Id}`
    const card = h('div.card.wide',
        h('div.art-wrap',
            h('a.art', { href: playHash(it.Id), 'aria-label': `Play ${title}` }, src ? h('img', { src, alt: '', loading: 'lazy' }) : h('div.noart', title),
                h('span.play-over', icon('play')),
                p ? h('div.prog', h('div', { style: { width: p + '%' } })) : null),
            check ? quickWatched(it, () => card, collection) : null),
        h('a.card-link', { href: page },
            h('div.card-title', title),
            h('div.card-sub', subtitle)))
    // callers sometimes point the picture somewhere else (sagas): keep card.href working for that
    Object.defineProperty(card, 'href', { set(v) { card.querySelector('a.art').href = v }, get() { return card.querySelector('a.art').href } })
    return card
}
// Tap again: PLAIN = take it off Continue Watching without marking it watched. Tap again: back to ORANGE = keep it
// (the "oops" state). Saves 1.2 s after the last tap; nothing happens if you end on orange.
function quickWatched(it, getCard, collection) {
    let state = 1, timer = null                                   // 0 plain, 1 orange, 2 green
    const b = h('button.quick-check.watching', { 'aria-label': 'Currently watching. Tap to mark watched' }, icon('check'))
    const draw = () => {
        b.classList.toggle('on', state === 2); b.classList.toggle('watching', state === 1); b.classList.toggle('off', state === 0)
        b.setAttribute('aria-label', ['Take off Continue Watching', 'Currently watching', 'Mark watched'][state])
    }
    const leave = msg => { const card = getCard(); card.classList.add('leaving'); setTimeout(() => card.remove(), 320); toast(msg) }
    b.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation()
        state = state === 1 ? 2 : state === 2 ? 0 : 1
        draw()
        clearTimeout(timer)
        if (state === 1) { toast('Kept in Continue Watching'); return }
        timer = setTimeout(async () => {
            const name = it.Type === 'Episode' ? `${it.SeriesName} ${epNum(it)}` : it.Name
            try {
                if (state === 2) {
                    await api.setPlayed(it.Id, true)
                    if (it.Type === 'Movie') await watching.setWatching(it.Id, false)
                    leave(`Marked watched: ${name}`)
                } else {
                    await api.clearResume(it.Id)
                    await watching.setWatching(it.Id, false)
                    if (it.SeriesId) await watching.setWatching(it.SeriesId, false)
                    await watching.hide(it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id)
                    if (collection) await watching.hide(collection)
                    leave(`Taken off Continue Watching: ${name}`)
                }
            } catch { state = 1; draw(); toast('Couldn’t save that') }
        }, 1200)
    })
    draw()
    return b
}
function shelf(title, cards, more, size) {
    if (!cards.length) return null
    return h('section.shelf' + (size ? '.' + size : ''),
        h('div.shelf-head', h('h2', title), more ? h('a.more', { href: more }, 'See All', icon('chevron')) : null),
        h('div.shelf-row', cards))
}
const loading = () => h('div.loading-page', h('div.spinner'))
const errorBox = e => h('div.empty', h('p', 'Couldn’t load this.'), h('p.muted.small', e.message || String(e)))

// ------------------------------------------------------------------ home
export async function home(main) {
    main.replaceChildren(loading())
    try {
        const [res, up, bar, ...latest] = await Promise.all([api.resume(), api.nextUp(),
            api.items({ includeItemTypes: 'Movie,Series', imageTypes: 'Logo', sortBy: 'Random', filters: 'IsUnplayed', limit: 8, fields: 'Overview,Genres,RunTimeTicks,OfficialRating,ProductionYear,ImageTags,BackdropImageTags,UserData,CommunityRating' }).then(d => d.Items).catch(() => []),
            ...libs.map(l => api.latest(l.Id))])
        const cont = await buildContinue().catch(() => res)   // one card per show/movie, next episode when there is one
        const sagaShelf = shelf('Continue Your Sagas', await continueSagasCards((it, sg, sub) => {
            const c = wide(it, { sub }); c.href = `#/play/${it.Id}?saga=${sg.Id}`; return c }), '#/sagas')
        const [contColl, browseColl] = await homeCollections().catch(() => [null, null])
        const slides = bar.filter(i => i.BackdropImageTags?.length)
        const rows = [
            ['continue', 'Continue Watching', shelf('Continue Watching', cont.map(i => wide(i, { check: true })), null, 'big')],
            ['sagas', 'Continue Your Sagas', sagaShelf],
            ['collections-continue', 'Continue Collections', contColl],
            ['ontheway', 'On the Way (your requests)', api.atLeast('member') ? await homeRequestsShelf().catch(() => null) : null],
            ['mymedia', 'My Media', await myMediaShelf()],
            ...libs.map((l, k) => [`new-${l.Id}`, `New in ${l.Name}`, shelf(`New in ${l.Name}`, latest[k].map(poster), `#/lib/${l.Id}/all`)]),
            ['collections', 'Collections', browseColl],
        ]
        const layout = await homeLayout()
        const order = [...layout.order.filter(id => rows.some(r => r[0] === id)), ...rows.map(r => r[0]).filter(id => !layout.order.includes(id))]
        main.replaceChildren(...[
            h('a.home-gear', { href: '#/settings', 'aria-label': 'Settings' }, icon('gear')),
            slides.length ? mediaBar(slides) : h('header.page-head', h('h1', 'Home')),
            ...order.filter(id => !layout.hidden.includes(id)).map(id => rows.find(r => r[0] === id)[2]),
            h('div.edit-home', h('button.pill.glass.edit-home-btn', { onclick: () => editHome(rows.map(r => [r[0], r[1]]), order, layout.hidden, () => home(main)) }, icon('rows'), ' Edit Home'))].filter(Boolean))
        if (location.hash.includes('edit=1')) { history.replaceState(null, '', '#/home'); main.querySelector('.edit-home-btn')?.click() }
    } catch (e) { main.replaceChildren(errorBox(e)) }
}
// Home layout: row order + hidden rows, per user (follows you to every device)
async function homeLayout() {
    const c = await store.get('home').catch(() => ({}))
    return { order: (c.order || '').split(',').filter(Boolean), hidden: (c.hidden || '').split(',').filter(Boolean) }
}
function editHome(rows, order, hidden, after) {
    let ord = [...order], hid = new Set(hidden)
    const list = h('div.edit-list')
    const name = id => rows.find(r => r[0] === id)?.[1] || id
    const draw = () => list.replaceChildren(...ord.map((id, i) => h('div.edit-row' + (hid.has(id) ? '.off' : ''),
        h('button.ie-btn', { 'aria-label': hid.has(id) ? `Show ${name(id)}` : `Hide ${name(id)}`, onclick: () => { hid.has(id) ? hid.delete(id) : hid.add(id); draw() } },
            hid.has(id) ? h('span.icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3.2 3.7M6.2 7.6C4.2 9.2 3 12 3 12s4 6 9 6c1.5 0 2.9-.4 4.1-1"/></svg>' })
                : h('span.icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/></svg>' })),
        h('span.edit-name', name(id)),
        h('button.ie-btn', { 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [ord[i - 1], ord[i]] = [ord[i], ord[i - 1]]; draw() } }, h('span.icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 6-6 6 6"/></svg>' })),
        h('button.ie-btn', { 'aria-label': 'Move down', disabled: i === ord.length - 1, onclick: () => { [ord[i + 1], ord[i]] = [ord[i], ord[i + 1]]; draw() } }, h('span.icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 10 6 6 6-6"/></svg>' })))))
    draw()
    const s = sheet([h('div.form-pad', h('p.muted.small', 'Move rows up or down, tap the eye to hide one. The banner always stays on top.'), list,
        h('div.tag-row',
            h('button.pill.glass', { onclick: () => { ord = rows.map(r => r[0]); hid = new Set(); draw() } }, 'Reset'),
            h('button.pill.white', { onclick: async () => {
                try { await store.update('home', c => { c.order = ord.join(','); c.hidden = [...hid].join(',') }); s.close(); toast('Home saved'); after() }
                catch { toast('Couldn’t save that') }
            } }, 'Save')))], { title: 'Edit Home', className: 'menu' })
}
// Rotating banner (the Media Bar idea): crossfading backdrops with the logo, a line of info and Play
function mediaBar(items) {
    let k = 0, timer
    // phones crash when 8 full-size backdrops sit in memory: load each one only when it's about to show,
    // drop it again after, and use a phone-sized picture on small screens
    const bw = innerWidth < 700 ? 900 : innerWidth < 1400 ? 1440 : 1920
    const url = it => api.img(it, 'Backdrop', { w: bw, q: 80 })
    const bgs = items.map((it, i) => h('div.mb-bg' + (i ? '' : '.on'), { style: i ? {} : { backgroundImage: `url("${url(it)}")` } }))
    const body = h('div.mb-body')
    const dots = h('div.mb-dots', items.map((_, i) => h('button' + (i ? '' : '.on'), { 'aria-label': `Show ${i + 1}`, onclick: () => show(i, true) })))
    const draw = () => {
        const it = items[k]
        const logo = it.ImageTags?.Logo ? api.img(it, 'Logo', { w: 640 }) : null
        body.replaceChildren(h('div.mb-slide',
            logo ? h('img.hero-logo', { src: logo, alt: it.Name }) : h('h1.hero-title', it.Name),
            h('div.hero-meta', [it.ProductionYear, it.OfficialRating, it.Type === 'Series' ? 'Series' : runtime(it.RunTimeTicks), (it.Genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' \u00b7 ')),
            it.Overview ? h('p.mb-over', it.Overview) : null,
            h('div.hero-btns',
                h('a.pill.white', { href: it.Type === 'Series' ? `#/item/${it.Id}` : playHash(it.Id) }, icon('play'), it.Type === 'Series' ? ' Watch' : ' Play'),
                h('a.pill.glass', { href: `#/item/${it.Id}` }, 'Details'),
                surpriseBtn())))
    }
    const show = (i, user) => {
        const prev = k
        bgs[k].classList.remove('on'); dots.children[k].classList.remove('on')
        k = (i + items.length) % items.length
        bgs[k].style.backgroundImage = `url("${url(items[k])}")`
        bgs[k].classList.add('on'); dots.children[k].classList.add('on')
        setTimeout(() => { if (prev !== k && !bgs[prev].classList.contains('on')) bgs[prev].style.backgroundImage = '' }, 1400)
        draw()
        if (user) restart()
    }
    const restart = () => { clearInterval(timer); timer = setInterval(() => { if (!el.isConnected) return clearInterval(timer); if (!document.hidden && !el.matches(':hover')) show(k + 1) }, 9000) }
    const el = h('header.hero.mediabar', h('div.mb-bgs', bgs), body, items.length > 1 ? dots : null)
    draw(); restart()
    return el
}
// My Media tiles: a clean backdrop from inside each section (Jellyfin's own library pictures have the name printed on
async function tileArt(query) {
    const d = await api.items({ ...query, sortBy: 'Random', limit: 1, imageTypes: 'Backdrop', fields: 'BackdropImageTags' }).catch(() => null)
    const it = d?.Items?.[0]
    return it ? api.img(it, 'Backdrop', { w: 640, q: 80 }) : null
}
async function myMediaShelf() {
    const sagaArt = (async () => {
        const s = await import('./sagas.js')
        const list = await s.listSagas().catch(() => [])
        if (!list.length) return null
        const items = await api.request(`/Playlists/${list[0].Id}/Items`, { query: { userId: api.userId(), limit: 1, fields: 'BackdropImageTags,ParentBackdropImageTags' } }).then(d => d.Items).catch(() => [])
        return items[0] ? api.img(items[0], 'Backdrop', { w: 640, q: 80 }) : null
    })()
    const [arts, sArt, cArt] = await Promise.all([
        Promise.all(libs.map(l => tileArt({ parentId: l.Id, includeItemTypes: l.CollectionType === 'movies' ? 'Movie' : 'Series' }))),
        sagaArt,
        tileArt({ includeItemTypes: 'BoxSet' }),
    ])
    return shelf('My Media', [...libs.map((l, i) => libTile(l.Name, `#/lib/${l.Id}`, arts[i])), libTile('Sagas', '#/sagas', sArt), libTile('Collections', '#/collections', cArt), api.atLeast('member') ? libTile('Requests', '#/requests', null) : null].filter(Boolean))
}
function libTile(name, href, img) {
    return h('a.card.tile', { href },
        h('div.art', img ? h('img', { src: img, alt: '', loading: 'lazy' }) : h('div.noart', ''), h('span.tile-label', name)))
}
// "Surprise me": a random unwatched movie or show (from one library, or everything)
function surpriseBtn(parentId, withText) {
    return h('button.pill.glass' + (withText ? '' : '.round'), { 'aria-label': 'Surprise me', title: 'Surprise me', onclick: async () => {
        try {
            const d = await api.items({ parentId, includeItemTypes: 'Movie,Series', sortBy: 'Random', filters: 'IsUnplayed', limit: 1 })
            if (d.Items[0]) location.hash = `#/item/${d.Items[0].Id}`
            else toast('You\u2019ve watched everything here')
        } catch { toast('Couldn\u2019t pick one') }
    } }, icon('dice'), withText ? ' Surprise me' : null)
}

// ------------------------------------------------------------------ big grids, in pages
export function fillGrid(grid, items, card, step = 60) {
    let n = 0
    const more = h('div.grid-more')
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) add() }, { rootMargin: '1200px 0px' })
    const add = () => {
        const next = items.slice(n, n + step).map(card)
        n += next.length
        more.before(...next)
        if (n >= items.length) { io.disconnect(); more.remove() }
    }
    grid.replaceChildren(more)
    add()
    if (n < items.length) io.observe(more)
}

// ------------------------------------------------------------------ library
const SORTS = [['DateCreated', 'Recently Added', 'Descending'], ['SortName', 'Title', 'Ascending'], ['ProductionYear,SortName', 'Year', 'Descending']]
function sectionTabs(lib, on) {
    return h('div.section-tabs', h('div.seg',
        h('a' + (on === 'home' ? '.on' : ''), { href: `#/lib/${lib.Id}` }, 'Home'),
        h('a' + (on === 'all' ? '.on' : ''), { href: `#/lib/${lib.Id}/all` }, 'Library')))
}
export async function section(main, id, view) {
    const lib = libs.find(l => l.Id === id)
    if (!lib) return main.replaceChildren(h('div.empty', 'Library not found'))
    if (view === 'all') return library(main, id)
    main.replaceChildren(loading())
    const isTv = lib.CollectionType === 'tvshows'
    const type = isTv ? 'Series' : 'Movie'
    try {
        const [res, up, latest, favs, picks, bar] = await Promise.all([
            api.resume(id).catch(() => []),
            isTv ? api.nextUp(null, id).catch(() => []) : [],
            api.latest(id).catch(() => []),
            api.items({ parentId: id, includeItemTypes: type, filters: 'IsFavorite', sortBy: 'SortName', limit: 30 }).then(d => d.Items).catch(() => []),
            api.items({ parentId: id, includeItemTypes: type, filters: 'IsUnplayed', sortBy: 'Random', limit: 18 }).then(d => d.Items).catch(() => []),
            api.items({ parentId: id, includeItemTypes: type, imageTypes: 'Logo', sortBy: 'Random', filters: 'IsUnplayed', limit: 6,
                fields: 'Overview,Genres,RunTimeTicks,OfficialRating,ProductionYear,ImageTags,BackdropImageTags,UserData' }).then(d => d.Items).catch(() => []),
        ])
        const cont = await buildContinue(id).catch(() => res)
        let contColl = null
        if (!isTv) { try { [contColl] = await homeCollections() } catch {} }
        const slides = bar.filter(i => i.BackdropImageTags?.length)
        main.replaceChildren(...[
            slides.length ? mediaBar(slides) : h('header.page-head', h('h1', lib.Name)),
            sectionTabs(lib, 'home'),
            shelf('Continue Watching', cont.map(i => wide(i, { check: true })), null, 'big'),
            contColl,
            shelf('Recently Added', latest.map(poster), `#/lib/${id}/all`),
            shelf('Your Favorites', favs.map(poster)),
            shelf('Something You Haven\u2019t Seen', picks.map(poster))].filter(Boolean))
    } catch (e) { main.replaceChildren(errorBox(e)) }
}
export async function library(main, id) {
    const lib = libs.find(l => l.Id === id)
    if (!lib) return main.replaceChildren(h('div.empty', 'Library not found'))
    let sort = +(localStorage.getItem('cove.sort.' + id) ?? 0), unwatched = localStorage.getItem('cove.unw.' + id) === '1'
    let tag = localStorage.getItem('cove.tag.' + id) || null
    const tagRow = h('div.lib-tag-wrap')
    const grid = h('div.grid')
    const controls = h('div.seg-row')
    const draw = async () => {
        controls.replaceChildren(
            h('div.seg', SORTS.map(([, label], k) => h('button' + (k === sort ? '.on' : ''), {
                onclick: () => { sort = k; localStorage.setItem('cove.sort.' + id, k); draw() } }, label))),
            h('button.toggle' + (unwatched ? '.on' : ''), { onclick: () => { unwatched = !unwatched; localStorage.setItem('cove.unw.' + id, unwatched ? '1' : '0'); draw() } }, 'Unwatched'))
        libraryTagRow(id, tag, t => { tag = t; t ? localStorage.setItem('cove.tag.' + id, t) : localStorage.removeItem('cove.tag.' + id); draw() })
            .then(r => tagRow.replaceChildren(...(r ? [r] : []))).catch(() => {})
        grid.replaceChildren(loading())
        try {
            const [by, , order] = SORTS[sort]
            const d = await api.items({
                parentId: id, includeItemTypes: lib.CollectionType === 'movies' ? 'Movie' : 'Series',
                sortBy: by, sortOrder: order, filters: unwatched ? 'IsUnplayed' : undefined, tags: tag || undefined, limit: 2000,
            })
            // draw 60 at a time and add more as you scroll: a full grid of hundreds of posters crashed Safari on iPhone
            fillGrid(grid, d.Items, poster)
            if (!d.Items.length) grid.replaceChildren(h('div.empty', 'Nothing here'))
        } catch (e) { grid.replaceChildren(errorBox(e)) }
    }
    main.replaceChildren(h('header.page-head.row', h('h1', lib.Name), surpriseBtn(id, true)), sectionTabs(lib, 'all'), controls, tagRow, grid)
    draw()
}


// ------------------------------------------------------------------ collections (TMDb Box Sets plugin)
let boxsets = null
async function allBoxSets() {
    boxsets ??= api.items({ includeItemTypes: 'BoxSet', fields: 'ChildCount,ProviderIds,ImageTags,BackdropImageTags,UserData', sortBy: 'SortName', limit: 1000 })
        .then(d => d.Items).catch(() => [])
    return boxsets
}
const inOrder = items => items.sort((a, b) => (a.PremiereDate || a.ProductionYear || '').toString().localeCompare((b.PremiereDate || b.ProductionYear || '').toString()))
async function boxSetMovies(id) {
    const d = await api.items({ parentId: id, includeItemTypes: 'Movie', fields: 'PremiereDate,ProductionYear,UserData,ImageTags,RunTimeTicks,OfficialRating' })
    return inOrder(d.Items)
}
// Movie page: the rest of its collection, in release order
async function collectionShelf(it) {
    const cid = it.ProviderIds?.TmdbCollection
    if (!cid) return null
    const bs = (await allBoxSets()).find(b => b.ProviderIds?.Tmdb === cid)
    if (!bs) return null
    const movies = await boxSetMovies(bs.Id)
    if (movies.length < 2) return null
    const cards = movies.map(m => { const c = poster(m); if (m.Id === it.Id) c.classList.add('current'); return c })
    return shelf(`Part of the ${bs.Name.replace(/ Collection$/, '')} Collection`, cards, `#/item/${bs.Id}`)
}
// Home: the next movie in collections you've started, then collections to browse
async function homeCollections() {
    const all = (await allBoxSets()).filter(b => (b.ChildCount || 0) >= 2)
    const started = all.filter(b => { const u = b.UserData?.UnplayedItemCount; return u != null && u > 0 && u < b.ChildCount }).slice(0, 12)
    const hidden = await watching.hiddenMap().catch(() => ({}))
    const next = []
    await Promise.all(started.map(async b => {
        try {
            const movies = await boxSetMovies(b.Id)
            const m = movies.find(x => !x.UserData?.Played)
            if (!m) return
            // a movie you took off Continue Watching stays off here until THAT movie gets watched; a collection you took off
            // stays off until you watch something in it (marking another one watched while cleaning up doesn't count:
            // Deadpool came back after Deadpool & Wolverine was marked watched, Nov 18)
            const last = Math.max(0, ...movies.map(x => Date.parse(x.UserData?.LastPlayedDate || '') || 0))
            const mLast = Date.parse(m.UserData?.LastPlayedDate || '') || 0
            if (hidden[m.Id] && hidden[m.Id] >= mLast) return
            if (hidden[b.Id] && hidden[b.Id] >= last) return
            next.push({ last, card: wide(m, { sub: `Next in ${b.Name.replace(/ Collection$/, '')}`, check: true, collection: b.Id }) })
        } catch {}
    }))
    next.sort((x, y) => y.last - x.last)
    const browse = all.slice().sort(() => Math.random() - .5).slice(0, 18).map(b => {
        const c = poster(b); c.querySelector('.card-sub').textContent = `${b.ChildCount} movies`; return c })
    return [shelf('Continue Collections', next.map(x => x.card)), shelf('Collections', browse, '#/collections')]
}
// Collection page: hero + movies in release order, "Play next"
async function collectionPage(main, bs) {
    const movies = await boxSetMovies(bs.Id)
    const watched = movies.filter(m => m.UserData?.Played).length
    const nx = movies.find(m => !m.UserData?.Played)
    const grid = h('div.grid', movies.map((m, i) => { const c = poster(m); c.querySelector('.card-sub').textContent = [`#${i + 1}`, m.ProductionYear].filter(Boolean).join(' \u00b7 '); return c }))
    main.replaceChildren(
        detailHero({ ...bs, ProductionYear: null, OfficialRating: null }, [`${movies.length} movies`, `${watched} watched`],
            [nx ? h('a.pill.white', { href: playHash(nx.Id) }, icon('play'), watched ? ` Next: ${nx.Name}` : ` Start: ${nx.Name}`) : h('span.pill.glass', icon('check'), ' All watched'),
             watchedBtn(bs), favBtn(bs), editBtn(bs)]),
        h('section.detail-body', bs.Overview ? h('p.overview.full', bs.Overview) : null, tagChips(bs, () => itemPage(main, bs.Id))),
        h('section.shelf', h('div.shelf-head', h('h2', 'In Order')), grid))
}
export async function collectionsPage(main) {
    main.replaceChildren(loading())
    const all = (await allBoxSets()).filter(b => (b.ChildCount || 0) >= 2)
    main.replaceChildren(h('header.page-head', h('h1', 'Collections')), h('p.muted.page-sub', `${all.length} collections, made from TheMovieDb.`),
        (() => { const g = h('div.grid'); fillGrid(g, all, b => { const c = poster(b); c.querySelector('.card-sub').textContent = `${b.ChildCount} movies`; return c }); return g })())
}

// ------------------------------------------------------------------ item (Emby-style details, our look)
const AUDIO_NAMES = { truehd: 'TrueHD', eac3: 'Dolby Digital+', ac3: 'Dolby Digital', dts: 'DTS', aac: 'AAC', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', pcm_s16le: 'PCM', pcm_s24le: 'PCM' }
const LANGS = { eng: 'English', jpn: 'Japanese', spa: 'Spanish', chi: 'Chinese', zho: 'Chinese', kor: 'Korean', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', und: '' }
const channels = n => n >= 8 ? '7.1' : n >= 6 ? '5.1' : n === 2 ? 'Stereo' : n === 1 ? 'Mono' : n ? n + 'ch' : ''
const isAtmos = a => /atmos/i.test(`${a.Profile || ''} ${a.DisplayTitle || ''} ${a.Title || ''}`)
function audioName(a) {
    let codec = AUDIO_NAMES[a.Codec] || (a.Codec || '').toUpperCase()
    if (a.Codec === 'dts' && /MA/.test(a.Profile || '')) codec = 'DTS-HD MA'
    else if (a.Codec === 'dts' && /X/.test(a.Profile || '')) codec = 'DTS:X'
    const lang = a.Language in LANGS ? LANGS[a.Language] : (a.Language || '')
    return [lang, codec, isAtmos(a) ? 'Atmos' : channels(a.Channels)].filter(Boolean).join(' · ')
}
function streamsOf(it) {
    const src = it.MediaSources?.[0]
    const ms = src?.MediaStreams ?? it.MediaStreams ?? []
    return {
        video: ms.find(s => s.Type === 'Video'),
        audios: ms.filter(s => s.Type === 'Audio'),
        subs: ms.filter(s => s.Type === 'Subtitle').map(s => ({ ...s, label: subLabel(s) })),
        defAudio: src?.DefaultAudioStreamIndex,
    }
}
function badges(it) {
    const { video: v, audios, subs, defAudio } = streamsOf(it)
    const out = []
    if (v) {
        const w = v.Width || 0, ht = v.Height || 0
        out.push(w >= 3200 || ht >= 2000 ? '4K' : w >= 1800 || ht >= 1000 ? 'HD 1080p' : w >= 1200 || ht >= 700 ? 'HD 720p' : 'SD')
        const r = v.VideoRangeType || v.VideoRange || ''
        if (/DOVI/i.test(r)) out.push('Dolby Vision')
        else if (/HDR10Plus/i.test(r)) out.push('HDR10+')
        else if (/HDR|HLG|PQ/i.test(r)) out.push('HDR')
    }
    const a = audios.find(x => x.Index === defAudio) ?? audios[0]
    if (a) {
        if (audios.some(isAtmos)) out.push('Dolby Atmos')
        else if (/dts/.test(a.Codec)) out.push('DTS')
        else if (/ac3|eac3|truehd/.test(a.Codec)) out.push('Dolby')
        const ch = channels(Math.max(...audios.map(x => x.Channels || 0)))
        if (ch && ch !== 'Stereo' && ch !== 'Mono') out.push(ch)
    }
    if (new Set(audios.map(x => x.Language).filter(l => l && l !== 'und')).size > 1) out.push('Dual Audio')
    if (subs.length) out.push('CC')
    return out.length ? h('div.badges', out.map(b => h('span.badge', b))) : null
}
function endsAt(ticksLeft) {
    if (!ticksLeft) return ''
    const t = new Date(Date.now() + ticksLeft / 1e4)
    return 'Ends at ' + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function metaLine(it, extra = []) {
    const parts = [
        it.ProductionYear,
        it.OfficialRating ? h('span.cert', it.OfficialRating) : null,
        ...extra,
        it.CommunityRating ? h('span.rating', h('span.star', '★'), ' ' + it.CommunityRating.toFixed(1)) : null,
        it.CriticRating ? h('span.rating', `${it.CriticRating}% critics`) : null,
    ].filter(Boolean)
    return h('div.hero-meta', parts.flatMap((p, i) => i ? [h('span.dot', '·'), p] : [p]))
}
function facts(it) {
    const ppl = t => (it.People || []).filter(p => p.Type === t).map(p => p.Name)
    const rows = [
        ['Genres', (it.Genres || []).join(', ')],
        ['Director', ppl('Director').slice(0, 3).join(', ')],
        ['Writers', ppl('Writer').slice(0, 3).join(', ')],
        [it.Type === 'Series' ? 'Network' : 'Studio', (it.Studios || []).slice(0, 2).map(s => s.Name).join(', ')],
        it.Type === 'Series' ? ['Status', it.Status === 'Ended' ? `Ended${it.EndDate ? ' ' + new Date(it.EndDate).getFullYear() : ''}` : it.Status === 'Continuing' ? 'Still airing' : ''] : null,
    ].filter(r => r && r[1])
    if (!rows.length) return null
    return h('dl.facts', rows.map(([k, v]) => [h('dt', k), h('dd', v)]))
}
// pick audio and subtitles before playing, like Emby; the choice rides along in the play link
function pickers(it, playBtns) {
    const { audios, subs, defAudio } = streamsOf(it)
    if (audios.length < 2 && !subs.length) return null
    const pick = { audio: undefined, sub: undefined }
    const audioBtn = h('button.picker'), subBtn = h('button.picker')
    const draw = () => {
        const a = audios.find(x => x.Index === (pick.audio ?? defAudio)) ?? audios[0]
        audioBtn.replaceChildren(icon('audio'), h('span', a ? audioName(a) : 'Audio'), icon('chevron', 'down'))
        const sLabel = pick.sub == null ? 'Smart' : pick.sub === -1 ? 'Off' : subs.find(x => x.Index === pick.sub)?.label
        subBtn.replaceChildren(icon('cc'), h('span', 'Subtitles: ' + sLabel), icon('chevron', 'down'))
        for (const [btn, fromStart] of playBtns) btn.href = playHash(it.Id, fromStart, pick)
    }
    const menu = (title, rows) => {
        const s = sheet(rows.map(([label, on, fn]) => h('button.menu-row', { onclick: () => { fn(); draw(); s.close() } },
            h('span', label), on ? icon('check') : null)), { title, className: 'menu' })
    }
    audioBtn.onclick = () => menu('Audio', audios.map(a => [
        audioName(a) + (a.Title && !/^(surround|stereo)/i.test(a.Title) ? ` (${a.Title})` : ''),
        (pick.audio ?? defAudio) === a.Index, () => { pick.audio = a.Index }]))
    subBtn.onclick = () => menu('Subtitles', [
        ['Smart (forced English on its own)', pick.sub == null, () => { pick.sub = undefined }],
        ['Off', pick.sub === -1, () => { pick.sub = -1 }],
        ...subs.map(x => [x.label, pick.sub === x.Index, () => { pick.sub = x.Index }]),
    ])
    draw()
    return h('div.pickers', audios.length > 1 ? audioBtn : null, subs.length ? subBtn : null)
}
async function moreLike(it) {
    try { return shelf('More Like This', (await api.similar(it.Id)).map(poster)) } catch { return null }
}
function favBtn(it) {
    let fav = !!it.UserData?.IsFavorite
    const b = h('button.pill.glass.round', { 'aria-label': 'Favorite', title: 'Favorite' }, icon('heart'))
    b.classList.toggle('on', fav)
    b.onclick = async () => {
        fav = !fav; b.classList.toggle('on', fav)
        try { await api.setFavorite(it.Id, fav); toast(fav ? 'Added to favorites' : 'Removed from favorites') }
        catch { fav = !fav; b.classList.toggle('on', fav); toast('Couldn’t save that') }
    }
    return b
}
// for a show's "unwatch everything": remember each episode's state first so Undo can put it back exactly
async function snapshotEpisodes(it) {
    const d = await api.items({ parentId: it.Id, includeItemTypes: 'Episode', fields: 'UserData', limit: 5000 }).catch(() => ({ Items: [] }))
    return d.Items.filter(e => e.UserData?.Played || e.UserData?.PlaybackPositionTicks)
        .map(e => ({ id: e.Id, ud: { Played: !!e.UserData.Played, PlayCount: e.UserData.PlayCount || 0, PlaybackPositionTicks: e.UserData.PlaybackPositionTicks || 0, LastPlayedDate: e.UserData.LastPlayedDate } }))
}
async function unwatchEpisodes(it, alsoSpots = false) {
    // Jellyfin usually unmarks a show's episodes along with the show; make sure none are left
    await api.setPlayed(it.Id, false).catch(() => {})
    const d = await api.items({ parentId: it.Id, includeItemTypes: 'Episode', filters: 'IsPlayed', limit: 5000 }).catch(() => ({ Items: [] }))
    for (let i = 0; i < d.Items.length; i += 10) await Promise.all(d.Items.slice(i, i + 10).map(e => api.setPlayed(e.Id, false).catch(() => {})))
    if (alsoSpots) {
        const r = await api.items({ parentId: it.Id, includeItemTypes: 'Episode', filters: 'IsResumable', limit: 5000 }).catch(() => ({ Items: [] }))
        await Promise.all(r.Items.map(e => api.clearResume(e.Id).catch(() => {})))
    }
}
async function restoreEpisodes(list) {
    for (let i = 0; i < list.length; i += 10)
        await Promise.all(list.slice(i, i + 10).map(x => api.request(`/UserItems/${x.id}/UserData`, { method: 'POST', query: { userId: api.userId() }, body: x.ud }).catch(() => {})))
}
// "not watching" takes it off Continue Watching: forget its resume spot (for a show, its episodes' spots)
async function offContinueWatching(it) {
    if (it.Type === 'Movie' || it.Type === 'Episode') return api.clearResume(it.Id).catch(() => {})
    if (it.Type === 'Series') {
        const res = await api.resume().catch(() => [])
        await Promise.all(res.filter(r => r.SeriesId === it.Id).map(r => api.clearResume(r.Id).catch(() => {})))
    }
}
// the page updates by itself. For a show: green = all watched, plain = all unwatched (with Undo, from a snapshot taken
// right before saving).
function watchedBtn(it, onChange) {
    const isShow = it.Type === 'Series' || it.Type === 'BoxSet'
    const ud = it.UserData || {}
    const partly = isShow
        ? (ud.UnplayedItemCount != null && it.RecursiveItemCount != null && ud.UnplayedItemCount < it.RecursiveItemCount) || ud.PlayedPercentage > 0
        : (ud.PlaybackPositionTicks || 0) > 0
    let state = ud.Played ? 2 : partly ? 1 : 0
    let saved = state, timer = null, queue = Promise.resolve()
    const b = h('button.pill.glass.round.watched-btn', { 'aria-label': 'Watched' }, icon('check'))
    const draw = () => {
        b.classList.toggle('on', state === 2); b.classList.toggle('watching', state === 1)
        b.setAttribute('aria-label', ['Not watching', 'Currently watching', 'Watched'][state])
        b.title = ['Tap: currently watching', 'Tap: watched', 'Tap: not watching'][state]
    }
    if (state === 0 && (it.Type === 'Movie' || it.Type === 'Series')) watching.isWatching(it.Id).then(w => { if (w && state === 0) { state = 1; draw() } }).catch(() => {})
    b.onclick = () => {
        state = (state + 1) % 3
        draw()
        clearTimeout(timer)
        timer = setTimeout(() => {
            const from = saved, to = state
            if (from === to) return
            saved = to
            queue = queue.then(() => apply(from, to)).catch(() => { state = saved = from; draw(); toast('Couldn’t save that') })
        }, 1000)
    }
    async function apply(from, to) {
        const snap = isShow && to === 0 ? await snapshotEpisodes(it) : null
        if (to === 2) {
            await api.setPlayed(it.Id, true)
            await watching.setWatching(it.Id, false)
            toast(isShow ? 'Marked every episode watched' : 'Marked watched')
        } else if (to === 1) {
            if (!isShow && from === 2) await api.setPlayed(it.Id, false)     // rewatching a movie
            await watching.setWatching(it.Id, true)
            toast('Currently watching: it’s in Continue Watching')
        } else {
            await watching.setWatching(it.Id, false)
            await api.setPlayed(it.Id, false)
            if (isShow) await unwatchEpisodes(it)
            await offContinueWatching(it)
            if (it.Type === 'Movie' || it.Type === 'Series') await watching.hide(it.Id)
            const was = snap?.filter(x => x.ud.Played).length || 0
            if (isShow && snap?.length) {
                const keep = snap
                toastAction(`Marked all ${was || keep.length} watched episode${(was || keep.length) === 1 ? '' : 's'} unwatched`, 'Undo', () => {
                    queue = queue.then(async () => {
                        await restoreEpisodes(keep)
                        await watching.hide(it.Id, false)
                        state = saved = from === 2 ? 2 : 1
                        draw(); onChange?.(); toast('Put back')
                    })
                })
            } else toast('Marked unwatched')
        }
        onChange?.()
    }
    draw()
    return b
}
function cast(it) {
    const people = (it.People || []).filter(p => p.Type === 'Actor').slice(0, 14)
    if (!people.length) return null
    return h('section.shelf', h('div.shelf-head', h('h2', 'Cast')),
        h('div.shelf-row.cast', people.map(p => h('div.person',
            h('div.face', p.PrimaryImageTag ? h('img', { src: `${api.BASE}/Items/${p.Id}/Images/Primary?tag=${p.PrimaryImageTag}&maxWidth=160`, alt: '', loading: 'lazy' }) : h('span', p.Name[0])),
            h('div.card-title', p.Name), h('div.card-sub', p.Role || '')))))
}

export async function itemPage(main, id) {
    main.replaceChildren(loading())
    let it
    try { it = await api.item(id) } catch (e) { return main.replaceChildren(errorBox(e)) }
    if (it.Type === 'Series') return seriesPage(main, it)
    if (it.Type === 'Episode' && it.SeriesId) return location.replace(`#/item/${it.SeriesId}`)
    if (it.Type === 'BoxSet') return collectionPage(main, it)
    const pos = it.UserData?.PlaybackPositionTicks || 0
    const left = it.RunTimeTicks ? it.RunTimeTicks - pos : 0
    const playBtn = h('a.pill.white', { href: playHash(it.Id) }, icon('play'), pos ? ' Resume' : ' Play')
    const overBtn = pos ? h('a.pill.glass.round', { href: playHash(it.Id, true), 'aria-label': 'Start over', title: 'Start over' }, icon('restart')) : null
    main.replaceChildren(...[
        detailHero(it, [runtime(it.RunTimeTicks), endsAt(left)], [playBtn, overBtn, trailerBtn(it), watchedBtn(it), favBtn(it), editBtn(it)]),
        h('section.detail-body',
            pos ? h('div.hero-left', runtime(left) + ' left') : null,
            pickers(it, [[playBtn, false], ...(overBtn ? [[overBtn, true]] : [])]),
            it.Taglines?.[0] ? h('p.tagline', it.Taglines[0]) : null,
            it.Overview ? h('p.overview.full', it.Overview) : null,
            facts(it), tagChips(it, () => itemPage(main, it.Id)), chips(it)),
        cast(it)].filter(Boolean))
    const [coll, more] = await Promise.all([collectionShelf(it).catch(() => null), moreLike(it)])
    if (coll && main.isConnected) main.append(coll)
    if (more && main.isConnected) main.append(more)
}
function detailHero(it, extra, buttons) {
    const bg = api.img(it, 'Backdrop', { w: innerWidth < 700 ? 900 : 1920, q: 85 })
    const logo = it.ImageTags?.Logo ? api.img(it, 'Logo', { w: 700 }) : null
    return h('header.hero.detail.centered', { style: bg ? { '--hero': `url("${bg}")` } : {} },
        h('div.hero-inner',
            logo ? h('img.hero-logo', { src: logo, alt: it.Name }) : h('h1.hero-title', it.Name),
            it.OriginalTitle && it.OriginalTitle !== it.Name ? h('div.orig-title', it.OriginalTitle) : null,
            metaLine(it, extra),
            badges(it),
            h('div.hero-btns', buttons.filter(Boolean))))
}
function trailerBtn(it) {
    const t = (it.RemoteTrailers || [])[0]
    return t ? h('a.pill.glass.round', { href: t.Url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Trailer', title: 'Watch the trailer' }, icon('trailer')) : null
}
function editBtn(it) {
    return api.isAdmin() ? h('a.pill.glass.round', { href: `#/images/${it.Id}`, 'aria-label': 'Edit Images', title: 'Edit Images' }, icon('image')) : null
}
function chips(it) {
    const p = it.ProviderIds || {}, kind = it.Type === 'Series' ? 'tv' : 'movie'
    const links = [
        p.Imdb && ['IMDb', `https://www.imdb.com/title/${p.Imdb}/`],
        p.Tmdb && ['TheMovieDb', `https://www.themoviedb.org/${kind}/${p.Tmdb}`],
        p.Tvdb && it.Type === 'Series' && ['TheTVDB', `https://thetvdb.com/?tab=series&id=${p.Tvdb}`],
    ].filter(Boolean)
    return links.length ? h('div.chips', links.map(([n, u]) => h('a.chip', { href: u, target: '_blank', rel: 'noopener noreferrer' }, n))) : null
}

async function seriesPage(main, it) {
    const [seasons, up] = await Promise.all([api.seasons(it.Id), api.nextUp(it.Id).catch(() => [])])
    const nextEp = up[0]
    const seasonBar = h('div.seg.seasons')
    const list = h('div.episodes')
    const seasonName = s => s.Name === 'Season Unknown' ? 'Episodes' : s.Name
    let cur = seasons.find(s => s.Id === nextEp?.SeasonId) ?? seasons.find(s => !s.UserData?.Played) ?? seasons[0]
    let selecting = false
    const picked = new Set()
    const drawSeason = async () => {
        seasonBar.replaceChildren(...seasons.map(s => h('button' + (s.Id === cur?.Id ? '.on' : ''), { onclick: () => { cur = s; picked.clear(); drawSeason() } }, seasonName(s))))
        if (!cur) return list.replaceChildren(h('div.empty', 'No episodes'))
        list.replaceChildren(loading())
        try {
            const eps = await api.episodes(it.Id, cur.Id)
            const bar = episodeTagBar(it.Id, eps, () => drawRows())
            const tools = api.isAdmin() ? h('div.ep-tools',
                h('button.toggle' + (selecting ? '.on' : ''), { onclick: () => { selecting = !selecting; picked.clear(); drawSeason() } }, selecting ? 'Done' : 'Select'),
                selecting ? h('button.toggle', { onclick: () => { eps.forEach(e => picked.add(e.Id)); drawRows() } }, 'All') : null,
                selecting ? h('button.pill.white.small', { onclick: () => {
                    if (!picked.size) return toast('Pick some episodes first')
                    const common = eps.filter(e => picked.has(e.Id)).map(e => e.Tags || []).reduce((a, b) => a.filter(t => b.includes(t)))
                    tagEditor([...picked], common, () => drawSeason())
                } }, icon('plus'), ' Tag selected') : null) : null
            const rows = h('div.ep-rows')
            const drawRows = () => {
                const hide = hiddenFor(it.Id)
                const shown = eps.filter(e => selecting || !(e.Tags || []).some(t => hide.has(t)))
                rows.replaceChildren(...shown.map(ep => {
                    const r = episodeRow(ep, ep.Id === nextEp?.Id)
                    if (selecting) {
                        r.classList.add('selectable')
                        r.classList.toggle('picked', picked.has(ep.Id))
                        r.addEventListener('click', e => { e.preventDefault(); picked.has(ep.Id) ? picked.delete(ep.Id) : picked.add(ep.Id); r.classList.toggle('picked', picked.has(ep.Id)) })
                    }
                    return r
                }))
                const hiddenCount = eps.length - shown.length
                count.textContent = `${eps.length} episode${eps.length === 1 ? '' : 's'}${hiddenCount ? ` \u00b7 ${hiddenCount} hidden` : ''}`
            }
            const count = h('span.muted')
            list.replaceChildren(...[h('div.ep-head', h('h2', seasonName(cur)), count, h('div.spacer'), tools), bar?.el, rows].filter(Boolean))
            drawRows()
        } catch (e) { list.replaceChildren(errorBox(e)) }
    }
    const shuffle = h('button.pill.glass.round', { 'aria-label': 'Shuffle', title: 'Play a random episode', onclick: async () => {
        const d = await api.items({ parentId: it.Id, includeItemTypes: 'Episode', sortBy: 'Random', limit: 1 }).catch(() => null)
        if (d?.Items[0]) location.hash = playHash(d.Items[0].Id)
    } }, icon('shuffle'))
    const yrs = it.ProductionYear ? `${it.ProductionYear}${it.Status === 'Continuing' ? ' \u2013 Present' : it.EndDate && new Date(it.EndDate).getFullYear() !== it.ProductionYear ? ' \u2013 ' + new Date(it.EndDate).getFullYear() : ''}` : null
    const airs = it.Status === 'Continuing' && it.AirDays?.length ? `Airs ${it.AirDays.join(', ')}${it.AirTime ? ' at ' + it.AirTime : ''}` : null
    const metaIt = { ...it, ProductionYear: null }
    main.replaceChildren(...[
        detailHero(metaIt, [yrs, seasons.length > 1 ? `${seasons.length} seasons` : null],
            [nextEp ? h('a.pill.white', { href: playHash(nextEp.Id) }, icon('play'),
                ` ${nextEp.UserData?.PlaybackPositionTicks ? 'Resume' : 'Play'}${epNum(nextEp) ? ' ' + epNum(nextEp) : ''}`) : null,
             trailerBtn(it), shuffle, watchedBtn(it, () => drawSeason()), favBtn(it), editBtn(it)]),
        h('section.detail-body',
            nextEp ? h('div.hero-left', 'Up next: ' + epTitle(nextEp)) : null,
            it.Overview ? h('p.overview.full', it.Overview) : null,
            airs ? h('p.airs', airs) : null,
            facts(it), tagChips(it, () => itemPage(main, it.Id)), chips(it)),
        seasons.length > 1 ? seasonBar : null,
        list,
        cast(it)].filter(Boolean))
    await drawSeason()
    const more = await moreLike(it)
    if (more && main.isConnected) main.append(more)
}
function episodeRow(ep, isNext) {
    const src = api.img(ep, 'Primary', { w: 560 })
    const p = progressOf(ep)
    const n = epNum(ep).replace(/^S\d+ /, '').replace(/^E/, '')
    return h('a.episode' + (isNext ? '.next' : ''), { href: playHash(ep.Id), dataset: { id: ep.Id } },
        h('div.art', src ? h('img', { src, alt: '', loading: 'lazy' }) : h('div.noart', ''),
            h('span.play-over', icon('play')),
            p ? h('div.prog', h('div', { style: { width: p + '%' } })) : null),
        h('div.ep-text',
            h('div.ep-num', n ? `Episode ${n}` : 'Episode',
                ep.RunTimeTicks ? h('span', ' · ' + runtime(ep.RunTimeTicks)) : null,
                ep.PremiereDate ? h('span', ' · ' + new Date(ep.PremiereDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })) : null,
                ep.UserData?.Played ? h('span.watched', icon('check'), 'Watched') : isNext ? h('span.upnext', 'Up next') : null),
            h('div.ep-title', epTitle(ep), ...(ep.Tags || []).map(t => h('span.ep-tag', t))),
            ep.Overview ? h('p.ep-over', ep.Overview) : null))
}

// ------------------------------------------------------------------ search
export function searchPage(main) {
    const input = h('input.search-box', { type: 'search', placeholder: 'Movies, shows, episodes', autocomplete: 'off', enterkeyhint: 'search' })
    const results = h('div')
    let timer, seq = 0
    input.addEventListener('input', () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
            const q = input.value.trim(), n = ++seq
            if (q.length < 2) return results.replaceChildren()
            results.replaceChildren(loading())
            try {
                const [found, extra] = await Promise.all([api.search(q), api.atLeast('member') ? seerrSearch(q) : []])   // teens/kids: library only
                if (n !== seq) return
                const movies = found.filter(i => i.Type === 'Movie'), shows = found.filter(i => i.Type === 'Series'), eps = found.filter(i => i.Type === 'Episode')
                results.replaceChildren(...[
                    shelf('Shows', shows.map(poster)), shelf('Movies', movies.map(poster)), shelf('Episodes', eps.map(i => wide(i))),
                    notInCoveShelf(extra)].filter(Boolean))
                if (!found.length && !results.children.length) results.replaceChildren(h('div.empty', `Nothing for “${q}”`))
            } catch (e) { results.replaceChildren(errorBox(e)) }
        }, 250)
    })
    main.replaceChildren(h('header.page-head', h('h1', 'Search')), h('div.search-wrap', icon('search'), input), results)
    setTimeout(() => input.focus(), 50)
}

// ------------------------------------------------------------------ settings: "You" (per person, saved on the server)
function choiceRow(label, note, opts, getV, setV) {
    const box = h('div.ss-seg')
    const draw = v => box.replaceChildren(...opts.map(([k, l]) => h('button' + (String(v) === String(k) ? '.on' : ''), { onclick: async () => {
        draw(k)
        try { await setV(k) } catch (e) { toast('Couldn’t save: ' + e.message) }
    } }, l)))
    draw(getV())
    return h('div.ss-row', h('div', h('div', label), note ? h('div.muted.small', note) : null), box)
}
function audioGroup() {
    const g = h('div.ss-group.you-group', h('div.ss-row', h('div', 'Audio language')))
    play.audioPref().then(({ lang }) => {
        const sel = h('select.srv-select', { 'aria-label': 'Audio language', onchange: async () => {
            try { await play.setAudioPref(sel.value); toast('Audio language saved') } catch (e) { toast('Couldn’t save: ' + e.message) }
        } }, play.AUDIO_LANGS.map(([v, l]) => h('option', { value: v, selected: v === lang }, l)))
        g.replaceChildren(h('div.ss-row', h('div', h('div', 'Audio language'), h('div.muted.small', 'Picked first when a movie or show has more than one. Anime with English and Japanese follows this too.')), sel))
    }).catch(e => g.replaceChildren(h('div.ss-row', h('div.muted.small', e.message))))
    return g
}
function playbackGroup() {
    const g = h('div.ss-group.you-group')
    const build = () => {
        const p = play.get()
        const set = k => v => play.set(k, v)
        const skipOpts = [['button', 'Show button'], ['auto', 'Skip it'], ['off', 'Nothing']]
        g.replaceChildren(
            choiceRow('Intros', null, skipOpts, () => p.intro, set('intro')),
            choiceRow('Recaps', '“Previously on…”', skipOpts, () => p.recap, set('recap')),
            choiceRow('At the credits', 'Up next card, straight to the next one, or keep watching the credits', [['card', 'Up next'], ['auto', 'Next one'], ['off', 'Credits']], () => p.credits, set('credits')),
            choiceRow('Play the next one when it ends', null, [['on', 'On'], ['off', 'Off']], () => p.autoplay, set('autoplay')),
            choiceRow('Countdown', null, [['3', '3 s'], ['8', '8 s'], ['15', '15 s']], () => p.countdown, set('countdown')),
            choiceRow('Ask “Still watching?”', 'After this many episodes in a row', [['0', 'Never'], ['3', '3'], ['5', '5']], () => p.stillWatching, set('stillWatching')))
    }
    build(); play.refresh().then(build)
    return g
}

// "This device" (kept on the device, not the account: a phone on cellular and the living-room TV want different things)
const devSel = (key, label, note, opts, after) => {
    const s = h('select.srv-select', { 'aria-label': label, onchange: () => { try { localStorage.setItem(key, s.value) } catch {} ; after?.(s.value) } },
        opts.map(([v, l]) => h('option', { value: v, selected: (localStorage.getItem(key) || opts[0][0]) === v }, l)))
    return h('div.ss-row', h('div', h('div', label), note ? h('div.muted.small', note) : null), s)
}
export function applyTextSize() {
    const z = { normal: '', large: '1.12', xl: '1.25', tv: '1.4' }[localStorage.getItem('cove.textsize') || 'normal'] || ''
    document.documentElement.style.zoom = z
}
function deviceGroup(main) {
    return h('div.ss-group.you-group', { style: { marginTop: '10px' } },
        devSel('cove.quality', 'Streaming quality', 'Lower it on a slow connection. The server converts to fit.',
            [['', 'Best available'], ['40000000', '40 Mbps (4K)'], ['20000000', '20 Mbps (1080p high)'], ['10000000', '10 Mbps (1080p)'], ['6000000', '6 Mbps (720p)'], ['3000000', '3 Mbps (cellular)'], ['1500000', '1.5 Mbps (weak signal)']]),
        devSel('cove.textsize', 'Text and button size', 'Bigger for a TV across the room', [['normal', 'Normal'], ['large', 'Large'], ['xl', 'Extra large'], ['tv', 'TV across the room']], () => applyTextSize()),
        devSel('cove.convert', 'Always convert', 'Only for a device that has trouble with a file. Uses the 4090.', [['off', 'Off'], ['on', 'On']]),
        h('button.list-row', { onclick: () => keysSheet() }, h('div', h('div', 'Keyboard shortcuts'), h('div.muted.small', 'Or press ? anywhere')), icon('chevron')))
}

// ------------------------------------------------------------------ settings
export function settingsPage(main) {
    const cur = api.subsMode()
    const opt = (v, label, note) => h('button.list-row', {
        onclick: () => { api.setSubsMode(v); settingsPage(main) } },
        h('div', h('div', label), note ? h('div.muted.small', note) : null), v === cur ? icon('check') : null)
    const u = api.me()
    main.replaceChildren(
        h('header.page-head', h('h1', 'Settings')),
        h('div.group-label', 'Subtitles'),
        h('div.group',
            opt('smart', 'Smart', 'Forced English for foreign-language scenes. Full English when the audio isn’t English.'),
            opt('always', 'Always English'),
            opt('off', 'Off'),
            h('a.list-row', { href: '#/settings/subtitles' }, h('div', h('div', 'Subtitle Style'), h('div.muted.small', 'Font, size, color, edge, background, position')), icon('chevron'))),
        h('div.group-label', 'Audio'),
        audioGroup(),
        h('div.group-label', 'Playback'),
        playbackGroup(),
        h('div.group-label', 'This device'),
        h('div.group', h('button.list-row', { onclick: () => { localStorage.setItem('cove.autopause', localStorage.getItem('cove.autopause') === 'off' ? 'on' : 'off'); settingsPage(main) } },
            h('div', h('div', 'Pause when I switch away'), h('div.muted.small', 'Stops the video when you leave the tab or app. Picture in picture keeps playing.')),
            localStorage.getItem('cove.autopause') === 'off' ? null : icon('check'))),
        deviceGroup(main),
        h('div.group-label', 'Home screen'),
        h('div.group', h('a.list-row', { href: '#/home?edit=1' }, h('div', h('div', 'Rearrange Home'), h('div.muted.small', 'Order of the rows, hide the ones you don’t use. Follows you to every device.')), icon('chevron'))),
        h('div.group-label', 'Jellyfin (this server)'),
        jellyfinUserGroup(),
        api.atLeast('admin') ? h('div.group-label', 'Family') : null,
        api.atLeast('admin') ? h('div.group', h('a.list-row', { href: '#/server' }, h('div', h('div', 'Server'), h('div.muted.small', 'Dashboard, users, devices')), icon('chevron'))) : null,
        h('div.group-label', 'Face ID'),
        faceIdBox(),
        h('div.group-label', 'Approve a Device'),
        approveBox(),
        h('div.group-label', 'Account'),
        h('div.group',
            h('div.list-row', h('div', h('div', u?.name), h('div.muted.small', { owner: 'Owner', admin: 'Admin', member: 'Member', kid: 'Kid' }[api.role()] || 'Member'))),
            pictureRow(),
            pinRow(),
            h('button.list-row', { onclick: () => accountSheet() }, h('div', h('div', 'Switch Account'), h('div.muted.small', 'Anyone who signed in on this device, no password needed')), icon('chevron')),
            h('button.list-row', { onclick: () => passwordSheet() }, h('div', 'Change Password'), icon('chevron')),
            h('button.list-row.danger', { onclick: () => api.logout() }, h('div', 'Sign Out'), icon('out'))),
        h('p.muted.small.center', `Cove ${api.VERSION}`))
}

function faceIdBox() {
    const box = h('div.group.approve')
    const draw = async () => {
        if (!passkey.supported()) return box.replaceChildren(h('p.muted.small', api.cachedServerInfo().addresses?.public ? `Face ID sign-in works on ${api.cachedServerInfo().addresses.public} on your iPhone, iPad or Mac. Open Cove there to set it up.` : 'Face ID sign-in needs this server’s secure (https) address.'))
        let list = []
        try { list = await passkey.list() } catch {}
        box.replaceChildren(
            ...list.map(k => h('div.approve-row', h('div', h('div', k.device || 'Device'), h('div.muted.small', `Added ${k.added}${k.used ? ' · last used ' + k.used : ''}`)),
                h('button.pill.glass.small', { onclick: async () => { await passkey.remove(k.id).catch(() => {}); toast('Removed'); draw() } }, 'Remove'))),
            h('button.pill.white', { onclick: async () => {
                try { await passkey.setup(); toast('Face ID is set up. Use it next time you sign in.', 3500); draw() }
                catch (e) { toast(e.name === 'NotAllowedError' ? 'Face ID was cancelled' : 'Couldn’t set it up: ' + e.message, 4000) }
            } }, list.length ? 'Set up on another device' : 'Set up Face ID on this device'),
            h('p.muted.small', 'Sign in with your face instead of a password. Cove only keeps a public key; nothing secret leaves your device.'))
    }
    draw()
    return box
}
function passwordSheet() {
    const field = ph => h('input', { type: 'password', placeholder: ph, autocomplete: ph === 'Current password' ? 'current-password' : 'new-password' })
    const cur = field('Current password'), n1 = field('New password'), n2 = field('New password again')
    const err = h('div.login-err', { role: 'alert' })
    const shake = () => { err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake') }
    const btn = h('button.pill.white.block', { onclick: async () => {
        err.textContent = ''
        if (n1.value.length < 6) { err.textContent = 'Use at least 6 characters'; return shake() }
        if (n1.value !== n2.value) { err.textContent = 'The new passwords don’t match'; return shake() }
        btn.disabled = true; btn.textContent = 'Saving…'
        try { await api.changePassword(cur.value, n1.value); s.close(); toast('Password changed. Use it next time you sign in.', 3500) }
        catch (e) { err.textContent = e.message; shake(); btn.disabled = false; btn.textContent = 'Change Password' }
    } }, 'Change Password')
    const s = sheet([h('div.form-pad', h('div.field-group', cur, n1, n2), err, btn,
        h('p.muted.small', 'Changes it everywhere: Cove and every Jellyfin app. Devices already signed in stay signed in.'))],
        { title: 'Change Password', className: 'menu' })
    setTimeout(() => cur.focus(), 80)
}
function approveBox() {
    const input = h('input.code-input', { inputmode: 'numeric', maxlength: 6, placeholder: '6-digit code', autocomplete: 'one-time-code' })
    const btn = h('button.pill.white', {
        onclick: async () => {
            const code = input.value.replace(/\D/g, '')
            if (code.length !== 6) return toast('Type the 6 digits on the other screen')
            btn.disabled = true
            try { await api.approveCode(code); toast('Approved. The other device is signing in.'); input.value = '' }
            catch { toast('That code didn’t work') }
            btn.disabled = false
        } }, 'Approve')
    return h('div.group.approve', h('div.approve-row', input, btn),
        h('p.muted.small', 'A new phone, iPad or TV shows a code on its sign-in screen. Type it here to sign it in as you.'))
}

export { LIB_ICON }

export const tagPage = (main, tag) => tagPageImpl(main, tag, poster, wide)

// Switch Account sheet: everyone signed in on this device, tap to switch (no password), or add another
export function accountSheet() {
    const cur = api.userId()
    const s = sheet([
        h('div.acct-list', api.accounts().map(a => h('button.acct-row', { onclick: async () => {
            if (a.userId === cur) return s.close()
            if (!(await pinGate(a))) return
            try { await api.switchTo(a.userId); location.replace('/#/home'); location.reload() }
            catch (e) { toast(e.message, 3500); s.close() }
        } }, h('span.acct-ava', (a.name || '?').slice(0, 1).toUpperCase()), h('span.acct-name', a.name), a.userId === cur ? icon('check') : null))),
        h('button.pill.glass.block', { onclick: () => { s.close(); api.addAccount() } }, 'Add Account'),
        h('p.muted.small', 'Sign Out (in Settings) removes that account from this device.'),
    ], { title: 'Switch Account' })
}
