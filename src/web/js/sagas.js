// Arrowverse / Marvel / Star Wars orders, "open the playlist and see where I left off").
// A saga is a Jellyfin playlist (so the order lives on the server). Each saga keeps its OWN progress,
// stored per user in Jellyfin display preferences (client "cove"): watching an episode elsewhere doesn't move
// the saga, and finishing something inside the saga also marks it watched everywhere (one-way).
import * as api from './api.js'
import { h, icon, toast, sheet, runtime, epNum, epTitle } from './ui.js'

import * as store from './prefs.js'
const FIELDS = 'PrimaryImageAspectRatio,ProductionYear,RunTimeTicks,UserData,ImageTags,SeriesPrimaryImage,ParentBackdropImageTags,BackdropImageTags,Overview'
const key = id => (id || '').slice(0, 10)            // short ids keep a 500-item saga's progress small

// ------------------------------------------------------------------ progress (server-side, per user, own store)
async function doneSet(sagaId) {
    const raw = (await store.get('sagas'))['saga.' + sagaId]
    return raw == null ? null : new Set(raw ? raw.split(',') : [])
}
async function writeDone(sagaId, set) {
    await store.update('sagas', c => { c['saga.' + sagaId] = [...set].join(',') })
}
export async function markDone(sagaId, itemId, done = true) {
    await store.update('sagas', c => {
        const raw = c['saga.' + sagaId]
        const set = new Set(raw ? raw.split(',') : [])
        done ? set.add(key(itemId)) : set.delete(key(itemId))
        c['saga.' + sagaId] = [...set].join(',')
    })
}

// ------------------------------------------------------------------ playlists
// edit people's sagas. but members can only edit their own. admins and owners can make it public"): cove-api decides
// (/saga/list, /saga/edit, /saga/create) and makes changes as the saga's owner, since Jellyfin only lets the owner edit.
let rules = { canCreate: false, canPublish: false }
export async function listSagas() {
    try {
        const r = await fetch('/cove-api/saga/list', { headers: { Authorization: api.authHeaderValue() } })
        if (!r.ok) throw new Error(r.status)
        const d = await r.json()
        rules = { canCreate: d.canCreate, canPublish: d.canPublish }
        return d.sagas.map(s => ({ Id: s.id, Name: s.name, ChildCount: s.count, ImageTags: s.imageTags, owner: s.owner, public: s.public, mine: s.mine, canEdit: s.canEdit }))
    } catch {   // cove-api down: your own sagas straight from Jellyfin
        const d = await api.request('/Items', { query: { userId: api.userId(), recursive: true, includeItemTypes: 'Playlist', mediaTypes: 'Video', fields: 'ChildCount,ImageTags,DateCreated', sortBy: 'SortName' } })
        rules = { canCreate: api.atLeast('member'), canPublish: false }
        return d.Items.map(s => ({ ...s, mine: true, canEdit: true }))
    }
}
const edit = (id, op, extra = {}) => api.helper('/saga/edit', { id, op, ...extra })
const sagaItems = id => api.request(`/Playlists/${id}/Items`, { query: { userId: api.userId(), fields: FIELDS, enableImages: true } }).then(d => d.Items)
const createSaga = name => api.helper('/saga/create', { name }).then(r => ({ Id: r.id }))
const addToSaga = (id, ids) => edit(id, 'add', { ids })
const removeFromSaga = (id, entryIds) => edit(id, 'remove', { entryIds })
const moveInSaga = (id, entryId, to) => edit(id, 'move', { entryId, to })
const renameSaga = (id, name) => edit(id, 'rename', { name })
const deleteSaga = id => edit(id, 'delete')
const setPublic = (id, on) => edit(id, 'public', { on })

// Saga state: items in order, which are done (first open of a saga seeds it from what's already watched)
export async function sagaState(id) {
    // first let cove-api put back anything Sonarr/Radarr replaced (new file = new Jellyfin id), then carry the marks over
    try {
        const r = await api.helper('/saga/sync', { id })
        if (r.repaired?.length) {
            const set = await doneSet(id)
            if (set) {
                let changed = false
                for (const { old, new: nu } of r.repaired) if (set.delete(key(old))) { set.add(key(nu)); changed = true }
                if (changed) await writeDone(id, set)
            }
        }
    } catch {}
    const items = await sagaItems(id)
    let done = await doneSet(id)
    if (!done) {
        done = new Set(items.filter(i => i.UserData?.Played).map(i => key(i.Id)))
        await writeDone(id, done).catch(() => {})
    }
    const isDone = i => done.has(key(i.Id))
    // where you left off: the first unwatched item after the last watched one; earlier gaps stay unwatched.
    // If everything after the last watched one is done, fall back to the first gap.
    let last = -1
    items.forEach((it, i) => { if (isDone(it)) last = i })
    let nextIndex = items.findIndex((it, i) => i > last && !isDone(it))
    if (nextIndex < 0) nextIndex = items.findIndex(i => !isDone(i))
    return { items, done, isDone, nextIndex, catchUp: nextIndex >= 0 && nextIndex < last, count: items.filter(isDone).length }
}

// What the player needs to play inside a saga: next item in the saga's order, and marking things done
export function playerContext(sagaId) {
    let cache = null
    const st = async () => (cache ??= await sagaState(sagaId))
    return {
        id: sagaId,
        async nextAfter(itemId) {
            const s = await st()
            const i = s.items.findIndex(x => x.Id === itemId)
            for (let k = i + 1; k < s.items.length; k++) if (!s.isDone(s.items[k])) return s.items[k]
            return null
        },
        async done(itemId) {
            cache = null
            await markDone(sagaId, itemId, true).catch(() => {})
        },
    }
}

const playHash = (itemId, sagaId) => `#/play/${itemId}?saga=${sagaId}`
const thumbOf = it => api.img(it, 'Primary', { w: 480 }) ?? api.img(it, 'Thumb', { w: 480 }) ?? api.img(it, 'Backdrop', { w: 480 })
const lineOf = it => it.Type === 'Episode'
    ? { top: [epNum(it), it.SeriesName].filter(Boolean).join(' · '), title: epTitle(it) }
    : { top: ['Movie', it.ProductionYear].filter(Boolean).join(' · '), title: it.Name }

// ------------------------------------------------------------------ Sagas page (all of them)
export async function sagasPage(main) {
    main.replaceChildren(h('div.loading-page', h('div.spinner')))
    let list
    try { list = await listSagas() } catch (e) { return main.replaceChildren(h('div.empty', 'Couldn’t load sagas: ' + e.message)) }
    const grid = h('div.saga-grid')
    main.replaceChildren(
        h('header.page-head.row', h('h1', 'Sagas'), rules.canCreate ? h('button.pill.glass', { onclick: () => newSaga() }, icon('plus'), ' New Saga') : null),
        h('p.muted.page-sub', 'Watch orders across shows and movies. Each one remembers where you are.'),
        grid)
    if (!list.length) return grid.replaceChildren(h('div.empty', 'No sagas yet. Make one for a watch order, like Marvel or an anime without the filler.'))
    const mine = list.filter(s => s.mine), pub = list.filter(s => !s.mine && s.public), others = list.filter(s => !s.mine && !s.public)
    if (!pub.length && !others.length) return grid.replaceChildren(...mine.map(s => sagaCard(s)))
    const group = (title, items, note) => items.length ? [h('h2.saga-group', title), note ? h('p.muted.small.saga-group-note', note) : null, h('div.saga-grid', items.map(s => sagaCard(s)))] : []
    grid.replaceWith(h('div.saga-groups', ...group('Yours', mine), ...group('For everyone', pub), ...group('Everyone else’s', others, 'Only you and other admins see these.')))
}
function sagaCard(s) {
    const prog = h('div.saga-prog', h('div'))
    const sub = h('div.card-sub', `${s.ChildCount ?? 0} items`)
    const cont = h('a.pill.white.small', { href: `#/saga/${s.Id}` }, icon('play'), ' Continue')
    const img = api.img(s, 'Primary', { w: 500 })
    const card = h('div.saga-card',
        h('a.saga-art', { href: `#/saga/${s.Id}` }, img ? h('img', { src: img, alt: '', loading: 'lazy' }) : h('div.noart', s.Name)),
        h('div.saga-info', h('a.saga-name', { href: `#/saga/${s.Id}` }, s.Name),
            (!s.mine && s.owner?.name && s.owner.name !== '?') || s.public ? h('div.saga-by', [!s.mine && s.owner?.name && s.owner.name !== '?' ? 'by ' + s.owner.name : null, s.public ? 'For everyone' : null].filter(Boolean).join(' · ')) : null,
            sub, prog, cont))
    sagaState(s.Id).then(st => {
        const pct = st.items.length ? st.count / st.items.length * 100 : 0
        prog.firstChild.style.width = pct + '%'
        sub.textContent = `${st.count} of ${st.items.length} watched`
        const nx = st.items[st.nextIndex]
        if (nx) { cont.href = playHash(nx.Id, s.Id); if (st.catchUp) cont.lastChild.textContent = ' Catch up' }
        else { cont.replaceChildren(icon('check'), ' Finished'); cont.classList.replace('white', 'glass') }
    }).catch(() => {})
    return card
}
function newSaga() {
    const input = h('input.text-input', { placeholder: 'Name, like Marvel in order', maxlength: 80 })
    const s = sheet([
        h('div.form-pad', input,
            h('button.pill.white.block', { onclick: async () => {
                const name = input.value.trim()
                if (!name) return input.focus()
                try { const r = await createSaga(name); s.close(); location.hash = `#/saga/${r.Id}?edit=1` }
                catch (e) { toast('Couldn’t make it: ' + e.message) }
            } }, 'Make Saga')),
    ], { title: 'New Saga', className: 'menu' })
    setTimeout(() => input.focus(), 80)
}

// ------------------------------------------------------------------ one saga
export async function sagaPage(main, id, query) {
    main.replaceChildren(h('div.loading-page', h('div.spinner')))
    let saga, st
    let meta = { canEdit: false }
    try { [saga, st, meta] = await Promise.all([api.item(id), sagaState(id), listSagas().then(l => l.find(x => x.Id === id) || { canEdit: false })]) }
    catch (e) { return main.replaceChildren(h('div.empty', 'Couldn’t load this saga: ' + e.message)) }
    let editing = query?.get('edit') === '1' && meta.canEdit, unwatchedOnly = false
    const list = h('div.saga-list')
    const head = h('div')
    const redraw = async (reload = false) => {
        if (reload) st = await sagaState(id)
        drawHead(); drawList()
    }
    function drawHead() {
        const pct = st.items.length ? Math.round(st.count / st.items.length * 100) : 0
        const nx = st.items[st.nextIndex]
        head.replaceChildren(
            h('header.saga-head',
                h('a.icon-btn', { href: '#/sagas', 'aria-label': 'Back to Sagas' }, icon('back')),
                h('div.saga-title',
                    h('h1', saga.Name),
                    h('div.muted', `${st.count} of ${st.items.length} watched · ${pct}%` + (!meta.mine && meta.owner?.name && meta.owner.name !== '?' ? ` · by ${meta.owner.name}` : '') + (meta.public ? ' · For everyone' : '')),
                    h('div.saga-prog.big', h('div', { style: { width: pct + '%' } })))),
            h('div.saga-actions',
                nx ? h('a.pill.white.saga-go', { href: playHash(nx.Id, id) }, icon('play'),
                    h('span.saga-go-text', ` ${st.nextIndex === 0 && !st.count ? 'Start' : st.catchUp ? 'Catch up' : 'Continue'}: #${st.nextIndex + 1} ${lineOf(nx).title}`)) : st.items.length ? h('span.pill.glass', icon('check'), ' All watched') : null,
                editing ? null : h('button.toggle' + (unwatchedOnly ? '.on' : ''), { onclick: () => { unwatchedOnly = !unwatchedOnly; redraw() } }, 'Unwatched only'),
                meta.canEdit ? h('button.toggle' + (editing ? '.on' : ''), { onclick: () => { editing = !editing; unwatchedOnly = false; redraw() } }, editing ? 'Done' : 'Edit') : null,
                editing && rules.canPublish ? h('button.toggle' + (meta.public ? '.on' : ''), { onclick: async () => {
                    try { await setPublic(id, !meta.public); meta.public = !meta.public; toast(meta.public ? 'Everyone can watch it now' : 'Only its maker sees it now'); redraw() } catch (e) { toast(e.message) }
                } }, 'For everyone') : null,
                editing ? h('button.pill.glass', { onclick: () => addSheet(id, () => redraw(true)) }, icon('plus'), ' Add') : null,
                editing ? h('button.pill.glass', { onclick: () => rename() }, 'Rename') : null,
                editing ? removeSagaBtn() : null))
    }
    function drawList() {
        const rows = st.items.map((it, i) => ({ it, i })).filter(({ it }) => !unwatchedOnly || !st.isDone(it))
        if (!rows.length) return list.replaceChildren(h('div.empty', editing ? 'Empty. Tap Add to put shows, seasons, episodes or movies in.' : 'Nothing left here.'))
        list.replaceChildren(...rows.map(({ it, i }) => row(it, i)))
        const cur = list.querySelector('.saga-row.next')
        if (cur && !editing) requestAnimationFrame(() => cur.scrollIntoView({ block: 'center' }))   // jump to where you left off
    }
    function row(it, i) {
        const done = st.isDone(it)
        const src = thumbOf(it)
        const { top, title } = lineOf(it)
        const check = h('button.saga-check' + (done ? '.on' : ''), { 'aria-label': done ? 'Mark not watched in this saga' : 'Mark watched in this saga',
            onclick: async e => {
                e.preventDefault()
                await markDone(id, it.Id, !done).catch(() => toast('Couldn’t save that'))
                redraw(true)
            } }, icon('check'))
        const tools = editing ? h('div.saga-tools',
            h('button.ie-btn', { 'aria-label': 'Remove from saga', onclick: async () => { await removeFromSaga(id, [it.PlaylistItemId]).catch(e => toast(e.message)); redraw(true) } }, icon('close')),
            h('button.ie-btn.saga-grip', { 'aria-label': `Drag to move ${lineOf(it).title}`, onpointerdown: e => startDrag(e, i),
                onkeydown: e => { if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); moveTo(i, i - 1) } else if (e.key === 'ArrowDown' && i < st.items.length - 1) { e.preventDefault(); moveTo(i, i + 1) } } },
                h('span.icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>' })))
            : check
        return h('div.saga-row' + (i === st.nextIndex ? '.next' : '') + (done ? '.done' : ''),
            h('span.saga-num', i + 1),
            h('a.saga-thumb', { href: playHash(it.Id, id) }, src ? h('img', { src, alt: '', loading: 'lazy' }) : h('div.noart', ''), h('span.play-over', icon('play'))),
            h('a.saga-text', { href: playHash(it.Id, id) },
                h('div.ep-num', top, it.RunTimeTicks ? h('span', ' · ' + runtime(it.RunTimeTicks)) : null, i === st.nextIndex ? h('span.upnext', 'Up next') : null),
                h('div.ep-title', title)),
            tools)
    }
    // wherever"). The row lifts, the others slide aside, one move call on drop, the list changes right away.
    async function moveTo(from, to) {
        if (from === to) return
        const [m] = st.items.splice(from, 1); st.items.splice(to, 0, m); drawList()
        try { await moveInSaga(id, m.PlaylistItemId, to) } catch (e) { toast('Couldn’t move it: ' + e.message) }
        redraw(true)
    }
    function startDrag(e, from) {
        e.preventDefault()
        const rows = [...list.querySelectorAll('.saga-row')]
        const el = rows[from]; if (!el) return
        const rects = rows.map(r => r.getBoundingClientRect())
        const h0 = rects[from].height + 8, y0 = e.clientY
        let to = from
        el.classList.add('dragging'); list.classList.add('drag-on')
        e.currentTarget.setPointerCapture?.(e.pointerId)
        const move = ev => {
            const dy = ev.clientY - y0
            el.style.transform = `translateY(${dy}px) scale(1.02)`
            const mid = rects[from].top + rects[from].height / 2 + dy
            to = rects.reduce((n, r, k) => (k !== from && mid > r.top + r.height / 2 ? (k > from ? k : n) : n), from)
            const lo = rects.findIndex((r, k) => k !== from && mid < r.top + r.height / 2)
            to = lo === -1 ? rows.length - 1 : (lo > from ? lo - 1 : lo)
            rows.forEach((r, k) => {
                if (k === from) return
                const shift = from < to && k > from && k <= to ? -h0 : from > to && k >= to && k < from ? h0 : 0
                r.style.transform = shift ? `translateY(${shift}px)` : ''
            })
            // scroll the page when dragging near the edges
            if (ev.clientY < 80) scrollBy(0, -12); else if (ev.clientY > innerHeight - 80) scrollBy(0, 12)
        }
        const up = () => {
            removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
            rows.forEach(r => { r.style.transform = '' }); el.classList.remove('dragging'); list.classList.remove('drag-on')
            moveTo(from, to)
        }
        addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
    }
    function rename() {
        const input = h('input.text-input', { value: saga.Name, maxlength: 80 })
        const s = sheet([h('div.form-pad', input, h('button.pill.white.block', { onclick: async () => {
            const name = input.value.trim(); if (!name) return
            try { await renameSaga(id, name); saga.Name = name; s.close(); redraw() } catch (e) { toast(e.message) }
        } }, 'Save'))], { title: 'Rename Saga', className: 'menu' })
    }
    function removeSagaBtn() {
        let armed = false
        const b = h('button.pill.glass.danger-text', { onclick: async () => {
            if (!armed) { armed = true; b.textContent = 'Tap again to delete'; setTimeout(() => { armed = false; b.textContent = 'Delete Saga' }, 3000); return }
            try { await deleteSaga(id); toast('Saga deleted. Your watched shows are untouched.'); location.hash = '#/sagas' } catch (e) { toast(e.message) }
        } }, 'Delete Saga')
        return b
    }
    main.replaceChildren(head, list)
    redraw()
}

// ------------------------------------------------------------------ adding to a saga
function addSheet(sagaId, after) {
    const input = h('input.search-box', { type: 'search', placeholder: 'Find a show, episode or movie', autocomplete: 'off' })
    const results = h('div.add-results')
    let timer, seq = 0
    const add = async (ids, what) => {
        if (!ids.length) return toast('Nothing to add')
        try { await addToSaga(sagaId, ids); toast(`Added ${what}`); after() } catch (e) { toast('Couldn’t add: ' + e.message) }
    }
    input.addEventListener('input', () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
            const q = input.value.trim(), n = ++seq
            if (q.length < 2) return results.replaceChildren()
            const found = await api.search(q).catch(() => [])
            if (n !== seq) return
            results.replaceChildren(...found.map(it => {
                const { top, title } = it.Type === 'Series' ? { top: 'Show', title: it.Name } : lineOf(it)
                const r = h('div.add-row',
                    h('div.add-text', h('div.ep-num', top), h('div.ep-title', title)),
                    h('div.add-btns'))
                const btns = r.querySelector('.add-btns')
                if (it.Type === 'Series') {
                    btns.append(h('button.btn', { onclick: async () => add((await api.episodes(it.Id)).map(e => e.Id), it.Name) }, 'Whole show'),
                        h('button.btn', { onclick: async () => {
                            const ss = await api.seasons(it.Id)
                            btns.replaceChildren(...ss.map(s => h('button.btn', { onclick: async () => add((await api.episodes(it.Id, s.Id)).map(e => e.Id), `${it.Name} ${s.Name}`) }, s.Name)))
                        } }, 'Pick a season'))
                } else btns.append(h('button.btn', { onclick: () => add([it.Id], title) }, 'Add'))
                return r
            }))
            if (!found.length) results.replaceChildren(h('div.empty', 'Nothing found'))
        }, 250)
    })
    sheet([h('div.form-pad', input), results], { title: 'Add to Saga', className: 'menu', wide: true })
    setTimeout(() => input.focus(), 80)
}

// ------------------------------------------------------------------ Home shelf: next item of each saga
export async function continueSagasCards(makeCard) {
    const list = await listSagas().catch(() => [])
    const cards = []
    for (const s of list.slice(0, 12)) {
        try {
            const st = await sagaState(s.Id)
            const nx = st.items[st.nextIndex]
            if (nx && st.count > 0) cards.push(makeCard(nx, s, `${s.Name} · #${st.nextIndex + 1} of ${st.items.length}`))
        } catch {}
    }
    return cards
}
