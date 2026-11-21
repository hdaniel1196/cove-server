// Library screens: Reading Now, Library, Series, Author, Search, Settings, book detail sheet.
import { api, coverUrl, currentUser, logout } from './api.js'
import * as lib from './library.js'
import * as si from './series-info.js'
import { openAppearance } from './appearance.js'
import { loadSettings } from './reader-settings.js'
import { h, icon, sheet, toast, pct, duration, summaryNodes } from './ui.js'

const S = lib.state
const go = hash => { location.hash = hash }
// append, skipping null/false (Element.append would print them as text)
const add = (el, ...xs) => el.append(...xs.flat(Infinity).filter(x => x != null && x !== false))
export const readBook = book => go(`#/read/${book.id}`)

// ------------------------------------------------------------------ building blocks
function cover(book, cls = '') {
    const p = lib.progressOf(book)
    const img = h('img', {
        src: coverUrl(book.id), loading: 'lazy', decoding: 'async', alt: '',
        onload: e => e.target.classList.add('loaded'), onerror: e => e.target.remove(),
    })
    return h('div.cover' + cls, { style: book.primaryColor ? { '--c': book.primaryColor } : null },
        h('div.cover-fallback', h('div.cf-title', book.title), h('div.cf-author', book.author)),
        img,
        p > 0 && p < 1 ? h('div.cover-progress', h('i', { style: { width: pct(p) } })) : null)
}

function statusLine(book) {
    const p = lib.progressOf(book)
    const left = p >= 1 ? h('span.st-done', icon('checkCircle'), 'Finished')
        : p > 0 ? h('span', pct(p))
        : isNew(book) ? h('span.st-new', 'NEW') : h('span.muted', book.isComic ? 'Comic' : '')
    return h('div.book-meta', left, lib.isDownloaded(book.id) ? h('span.st-dl', { title: 'Downloaded' }, icon('cloud')) : null)
}
// "NEW" = added in the last 3 weeks, but not part of the initial bulk import (first 2 days of the library)
let firstAdded = 0
const isNew = b => {
    if (!firstAdded || firstAdded > b.created) firstAdded = Math.min(...S.books.map(x => x.created || Infinity))
    return !lib.isStarted(b) && !lib.isFinished(b) && Date.now() - b.created < 21 * 864e5 && b.created - firstAdded > 2 * 864e5
}

function bookTile(book, { showTitle = false } = {}) {
    return h('button.tile', { onclick: () => openBookSheet(book), 'aria-label': `${book.title} by ${book.author}` },
        cover(book),
        showTitle ? h('div.tile-title', book.title) : null,
        statusLine(book))
}

function shelf(title, books, { onMore, showTitle = true } = {}) {
    if (!books.length) return null
    return h('section.shelf',
        h('div.shelf-head', h('h2', title), onMore ? h('button.link', { onclick: onMore }, 'See All', icon('chevron')) : null),
        h('div.shelf-row', books.map(b => bookTile(b, { showTitle }))))
}

function bookRow(book, { numbered = false, label = null, upNext = false } = {}) {
    const p = lib.progressOf(book)
    const sub = p >= 1 ? 'Finished' : p > 0 ? `${pct(p)}${book.avgHours ? ' · ' + duration(lib.hoursLeft(book)) + ' left' : ''}`
        : book.avgHours ? duration(book.avgHours) : ''
    return h('button.row-book' + (upNext ? '.up-next' : ''), { onclick: () => openBookSheet(book) },
        cover(book, '.small'),
        h('div.rb-text',
            label ? h('div.rb-num', label, upNext ? h('span.next-badge', 'Up next') : null)
                : numbered && book.number != null ? h('div.rb-num', `Book ${book.number}`) : null,
            h('div.rb-title', book.title),
            h('div.rb-author', book.author),
            h('div.rb-sub', sub, lib.isDownloaded(book.id) ? icon('cloud', 'inline') : null)),
        icon('chevron', 'muted'))
}

function header(title, ...right) {
    return h('header.page-head', h('h1', title), h('div.head-actions', ...right))
}
const settingsBtn = () => h('button.avatar', { onclick: () => go('#/settings'), 'aria-label': 'Settings' },
    (coveName() || currentUser()?.username || '?').slice(0, 1).toUpperCase())
function coveName() {
    if (!location.pathname.startsWith('/books')) return ''
    try { return JSON.parse(localStorage.getItem('cove.auth') || '{}').name || '' } catch { return '' }
}

function empty(msg) { return h('div.empty', msg) }
function offlineNote() {
    return S.offline ? h('div.offline-note', 'Offline. Showing your saved library; downloaded books still open.') : null
}

// ------------------------------------------------------------------ Reading Now
export function home(main) {
    const books = S.books
    if (!books.length) {
        add(main, header('Reading Now', settingsBtn()),
            S.loadedAt ? empty('Your Kavita library is empty.') : h('div.loading-page', h('div.spinner'), 'Loading your library…'))
        return
    }
    const reading = books.filter(lib.isStarted).sort((a, b) => lib.lastActivity(b) - lib.lastActivity(a))
    const current = reading[0]
    const nextUp = []
    const seen = new Set(reading.map(b => b.seriesId))
    for (const s of S.series) {
        const sb = lib.seriesBooks(s.id)
        if (seen.has(s.id) || sb.length < 2) continue
        const doneIdx = sb.findLastIndex(lib.isFinished)
        if (doneIdx >= 0 && doneIdx < sb.length - 1 && !lib.isFinished(sb[doneIdx + 1]))
            nextUp.push({ book: sb[doneIdx + 1], at: lib.lastActivity(sb[doneIdx]) })
    }
    // sagas carry "up next" across series (finish Farseer -> Liveship Traders #1)
    for (const sg of S.sagas) {
        const bs = lib.sagaBooks(sg)
        if (!bs.some(b => lib.isFinished(b) || lib.isStarted(b))) continue
        const next = lib.sagaNext(sg)
        if (next && !lib.isStarted(next) && !seen.has(next.seriesId) && !nextUp.some(x => x.book.id === next.id))
            nextUp.push({ book: next, at: Math.max(...bs.map(lib.lastActivity)) })
    }
    nextUp.sort((a, b) => b.at - a.at)
    const want = S.series.filter(s => s.wantToRead).map(s => lib.nextInSeries(s.id)).filter(Boolean)
    const recent = [...books].sort((a, b) => b.created - a.created).slice(0, 18)
    const downloaded = books.filter(b => lib.isDownloaded(b.id)).sort((a, b) => lib.lastActivity(b) - lib.lastActivity(a))
    const finished = books.filter(lib.isFinished).sort((a, b) => lib.lastActivity(b) - lib.lastActivity(a)).slice(0, 18)

    add(main, 
        header('Reading Now', settingsBtn()),
        offlineNote(),
        current ? hero(current) : h('section.hero.empty-hero',
            h('div', h('h2', 'Nothing in progress'), h('p.muted', 'Pick something from your library.')),
            h('button.btn', { onclick: () => go('#/library') }, 'Browse Library')),
        shelf('Continue Reading', reading.slice(1)),
        shelf('Up Next', nextUp.map(x => x.book)),
        (() => {
            const miss = si.missingNext()
            if (!miss.length) return null
            return h('section.shelf',
                h('div.shelf-head', h('h2', 'Next in Your Series'), h('span.muted.small', 'not in your library yet')),
                h('div.list.missing-list', miss.map(m => {
                    const r = missingRow(m.entry)
                    r.querySelector('.rb-num').prepend(`${m.series.name} · `)
                    return r
                })))
        })(),
        S.sagas.length ? h('section.shelf',
            h('div.shelf-head', h('h2', 'Sagas'), h('button.link', { onclick: () => go('#/library/sagas') }, 'See All', icon('chevron'))),
            h('div.shelf-row.sagas-row', S.sagas.map(sagaTile))) : null,
        shelf('Want to Read', want, { onMore: () => go('#/library/want') }),
        shelf('Recently Added', recent, { onMore: () => go('#/library/all?sort=added') }),
        shelf('On This Device', downloaded, { onMore: () => go('#/library/downloaded') }),
        shelf('Finished', finished, { onMore: () => go('#/library/finished') }),
    )
}

function hero(book) {
    const p = lib.progressOf(book)
    const left = lib.hoursLeft(book)
    return h('section.hero',
        h('div.hero-bg', h('img', { src: coverUrl(book.id), alt: '' })),
        h('button.hero-cover', { onclick: () => readBook(book) }, cover(book, '.big')),
        h('div.hero-text',
            h('div.hero-kicker', 'Continue reading'),
            h('div.hero-title', book.title),
            h('div.hero-author', book.author),
            book.number != null && book.series !== book.title ? h('div.hero-series', `${book.series} · Book ${book.number}`) : null,
            h('div.hero-progress', h('div.bar', h('i', { style: { width: pct(p) } })),
                h('span', `${pct(p)}${left ? ` · ${duration(left)} left` : ''}`)),
            h('div.hero-actions',
                h('button.btn.primary', { onclick: () => readBook(book) }, 'Continue'),
                h('button.btn.ghost', { onclick: () => openBookSheet(book) }, 'Details'))))
}

// ------------------------------------------------------------------ Library
const FILTERS = [
    ['all', 'All'], ['books', 'Books'], ['comics', 'Graphic Novels'], ['manga', 'Manga'], ['series', 'Series & Sagas'], ['authors', 'Authors'],
    ['want', 'Want to Read'], ['reading', 'Reading'], ['finished', 'Finished'], ['downloaded', 'Downloaded'],
]
const SORTS = [['recent', 'Recent'], ['title', 'Title'], ['author', 'Author'], ['added', 'Recently Added']]

export function library(main, filter = 'all', query = {}) {
    const pref = JSON.parse(localStorage.getItem('folio.libview') || '{}')
    const sort = query.sort || pref.sort || 'recent'
    const layout = pref.layout || 'grid'
    const setPref = p => { localStorage.setItem('folio.libview', JSON.stringify({ ...pref, sort, layout, ...p })); dispatchEvent(new Event('folio:rerender')) }

    const chips = h('div.chips', FILTERS.map(([k, label]) =>
        h('button.chip', { class: k === filter ? 'on' : '', onclick: () => go(`#/library/${k}`) }, label)))
    const sortSel = h('select.sort-select', { onchange: e => setPref({ sort: e.target.value }), 'aria-label': 'Sort' },
        SORTS.map(([k, l]) => h('option', { value: k, selected: k === sort }, l)))
    const layoutBtn = h('button.icon-btn', { onclick: () => setPref({ layout: layout === 'grid' ? 'list' : 'grid' }), 'aria-label': 'Toggle layout' },
        icon(layout === 'grid' ? 'rows' : 'grid'))

    add(main, header('Library', settingsBtn()), offlineNote(), chips)
    requestAnimationFrame(() => chips.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }))

    if (filter === 'series' || filter === 'sagas') return add(main, seriesAndSagas(sort, pref, setPref))
    if (filter === 'authors') return add(main, authorList())

    let books = S.books
    if (filter === 'books') books = books.filter(b => !b.isComic)
    if (filter === 'comics') books = books.filter(b => b.isComic && !b.isManga)
    if (filter === 'manga') books = books.filter(b => b.isManga)
    if (filter === 'want') books = S.series.filter(s => s.wantToRead).flatMap(s => lib.seriesBooks(s.id).filter(b => !lib.isFinished(b)))
    if (filter === 'reading') books = books.filter(lib.isStarted)
    if (filter === 'finished') books = books.filter(lib.isFinished)
    if (filter === 'downloaded') books = books.filter(b => lib.isDownloaded(b.id))
    books = sortBooks(books, sort)

    add(main, h('div.lib-toolbar', h('span.muted', `${books.length} ${books.length === 1 ? 'book' : 'books'}`), h('div.spacer'), sortSel, layoutBtn))
    if (!books.length) return add(main, empty(filter === 'want' ? 'Nothing here yet. Open a book and tap "Want to Read".'
        : filter === 'downloaded' ? 'No books saved on this device yet. Books you open are saved automatically.' : 'Nothing here.'))
    add(main, layout === 'grid'
        ? h('div.grid', books.map(b => bookTile(b, { showTitle: false })))
        : h('div.list', books.map(b => bookRow(b))))
}

function sortBooks(books, sort) {
    const c = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    const bySeries = (a, b) => c.compare(a.series, b.series) || (a.number ?? 0) - (b.number ?? 0)
    const arr = [...books]
    if (sort === 'title') arr.sort((a, b) => c.compare(a.title.replace(/^(the|a|an) /i, ''), b.title.replace(/^(the|a|an) /i, '')))
    else if (sort === 'author') arr.sort((a, b) => c.compare(lastName(a.author), lastName(b.author)) || bySeries(a, b))
    else if (sort === 'added') arr.sort((a, b) => b.created - a.created || bySeries(a, b))
    else arr.sort((a, b) => lib.lastActivity(b) - lib.lastActivity(a) || b.created - a.created || bySeries(a, b))
    return arr
}
const lastName = n => (n || '').split(',')[0].trim().split(' ').slice(-1)[0]

// One tab for both: sagas first (each holds its series), then the series that aren't part of a saga
function seriesAndSagas(sort, pref, setPref) {
    const inSaga = new Set(S.sagas.flatMap(sg => sg.series))
    const showAll = !!pref.allSeries
    const rest = S.series.filter(s => s.books.length > 1 && (showAll || !inSaga.has(s.id)))
    return h('div',
        h('div.lib-toolbar', h('span.muted', `${S.sagas.length} sagas · ${rest.length} ${showAll ? '' : 'other '}series`), h('div.spacer'),
            h('button.btn.ghost.small-btn', { onclick: () => editSaga() }, icon('plus'), 'New Saga')),
        S.sagas.length ? [
            h('div.shelf-head', h('h2', 'Sagas'), h('span.muted.small', 'series that belong together, in reading order')),
            h('div.grid.series-grid', S.sagas.map(sagaTile))] : null,
        h('div.shelf-head.series-head-row', h('h2', showAll ? 'All Series' : 'Other Series'),
            S.sagas.length ? h('button.link', { onclick: () => setPref({ allSeries: !showAll }) },
                showAll ? 'Hide series in sagas' : 'Show series in sagas too') : null),
        seriesGrid(sort, rest))
}

function seriesGrid(sort, list = S.series.filter(s => s.books.length > 1)) {
    const c = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    list = [...list]
    const act = s => Math.max(0, ...lib.seriesBooks(s.id).map(lib.lastActivity))
    if (sort === 'author') list.sort((a, b) => c.compare(lastName(a.author), lastName(b.author)) || c.compare(a.sortName, b.sortName))
    else if (sort === 'recent') list.sort((a, b) => act(b) - act(a) || c.compare(a.sortName, b.sortName))
    else if (sort === 'added') list.sort((a, b) => b.created - a.created)
    else list.sort((a, b) => c.compare(a.sortName, b.sortName))
    return h('div.grid.series-grid', list.map(s => seriesTile(s)))
}

function seriesTile(s, label = '') {
    const sb = lib.seriesBooks(s.id)
    const done = sb.filter(lib.isFinished).length
    return h('button.tile.series-tile', { onclick: () => go(`#/series/${s.id}`) },
        h('div.stack', sb.slice(0, 3).reverse().map((b, i, a) => h('div.stack-item', { style: { '--i': a.length - 1 - i } }, cover(b)))),
        h('div.tile-title', label ? h('span.ss-num.inline-num', label) : null, s.name),
        h('div.book-meta', h('span.muted', done === sb.length && sb.length ? 'Finished' : `${sb.length} books${done ? ` · ${done} read` : ''}`)))
}

function authorList() {
    const map = new Map()
    for (const b of S.books) for (const a of (b.author || 'Unknown').split(', ')) {
        if (!map.has(a)) map.set(a, [])
        map.get(a).push(b)
    }
    const c = new Intl.Collator(undefined, { sensitivity: 'base' })
    const authors = [...map.entries()].sort((a, b) => c.compare(lastName(a[0]), lastName(b[0])))
    return h('div.list.authors', authors.map(([name, books]) =>
        h('button.row-author', { onclick: () => go(`#/author/${encodeURIComponent(name)}`) },
            h('div.author-covers', books.slice(0, 3).map(b => cover(b, '.tiny'))),
            h('div.ra-text', h('div.ra-name', name), h('div.muted', `${books.length} ${books.length === 1 ? 'book' : 'books'}`)),
            icon('chevron', 'muted'))))
}

// ------------------------------------------------------------------ Series & Author pages
export function series(main, id) {
    const s = S.seriesById.get(+id)
    if (!s) return add(main, backBar(), empty('Series not found.'))
    const books = lib.seriesBooks(s.id)
    const next = books.find(b => !lib.isFinished(b))
    const done = books.filter(lib.isFinished).length
    add(main, 
        backBar(),
        h('header.series-head',
            h('div.stack.big', books.slice(0, 3).reverse().map((b, i, a) => h('div.stack-item', { style: { '--i': a.length - 1 - i } }, cover(b)))),
            h('div',
                h('h1', s.name),
                h('button.link.author-link', { onclick: () => go(`#/author/${encodeURIComponent(s.author)}`) }, s.author),
                h('div.muted', `${books.length} ${books.length === 1 ? 'book' : 'books'}${done ? ` · ${done} finished` : ''}`),
                lib.sagasOfSeries(s.id).map(sg => h('button.link.saga-link', { onclick: () => go(`#/saga/${sg.id}`) },
                    `Part ${sg.series.indexOf(s.id) + 1} of ${sg.series.length} in ${sg.title}`, icon('chevron'))),
                h('div.series-actions',
                    next ? h('button.btn.primary', { onclick: () => readBook(next) },
                        lib.isStarted(next) ? `Continue Book ${next.number ?? ''}`.trim() : (done ? `Read Book ${next.number ?? 'Next'}` : 'Start Series')) : null,
                    wantButton(s)))),
        completeSeries(s, books))
}

// ------------------------------------------------------------------ full series list (Hardcover/Goodreads via Chaptarr)
const stars = (r, votes) => r ? h('span.stars', '★ ', r.toFixed(2), votes ? h('span.muted', ` · ${si.fmtVotes(votes)}`) : null) : null

function completeSeries(s, books) {
    const info = si.seriesInfo(s.id)
    if (!info) return h('div.list', books.map(b => bookRow(b, { numbered: true })))
    const shown = new Set()
    const row = e => {
        if (e.owned) {
            shown.add(e.owned.id)
            return bookRow(e.owned, { label: `Book ${e.pos}${e.owned.seriesId === s.id && e.owned.number != null && String(e.owned.number) !== e.pos ? ` · Kavita says #${e.owned.number}` : ''}` })
        }
        return missingRow(e)
    }
    const mainRows = info.main.map(row)
    const extraRows = info.extras.map(row)
    const leftovers = books.filter(b => !shown.has(b.id))   // in Kavita but not in the Hardcover list
    const have = info.main.filter(e => e.owned).length
    const upcoming = info.main.length - info.released.length
    return h('div',
        h('div.series-info-bar',
            h('span', have === info.released.length ? `You have all ${have}${upcoming ? ` (+${upcoming} coming)` : ''}` : `You have ${have} of ${info.released.length}${upcoming ? ` (+${upcoming} coming)` : ''}`),
            info.rating ? stars(info.rating) : null,
            h('span.muted.small', info.umbrella ? `Numbered as in ${info.title}` : info.sameName && info.title !== s.name ? `Series data: ${info.title}` : 'Series data from Hardcover / Goodreads')),
        h('div.list', mainRows),
        leftovers.length ? h('div', h('div.section-label.pad-x', 'Also in this series in Kavita'), h('div.list', leftovers.map(b => bookRow(b, { numbered: true })))) : null,
        extraRows.length ? h('details.extras',
            h('summary', `Novellas & extras (${extraRows.length})`),
            h('div.list', extraRows)) : null)
}

function missingRow(e) {
    const req = si.requestFor(e.id)
    const future = si.isUpcoming(e)
    const when = e.date ? new Date(e.date + 'T12:00:00') : null
    const soon = when && when - Date.now() < 300 * 864e5
    const comingText = when ? `Comes out ${when.toLocaleDateString(undefined, soon ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' })}`
        : e.year ? `Coming ${e.year}` : 'Not published yet'
    const status = future ? h('span.muted', comingText, req ? ' · Chaptarr will grab it when it comes out' : '')
        : req ? reqLabel(req) : null
    const btn = !si.isAdmin() || future || (req && req.state !== 'notfound') ? null
        : h('button.btn.get-btn', { onclick: async ev => {
            ev.stopPropagation()
            const b = ev.currentTarget
            b.disabled = true; b.textContent = 'Asking…'
            try { await si.getBook(e); toast(`Searching for ${e.title}…`) }
            catch (err) { toast(err.message || "Couldn't reach Chaptarr"); b.disabled = false; b.textContent = 'Get' }
        } }, req?.state === 'notfound' ? 'Retry' : 'Get')
    return h('div.row-book.missing', { onclick: () => e.goodreads && window.open(e.goodreads, '_blank') },
        h('div.cover.small.remote', e.cover ? h('img', { src: e.cover, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', onload: ev => ev.target.classList.add('loaded') }) : null),
        h('div.rb-text',
            h('div.rb-num', `Book ${e.pos}`, h('span.missing-badge', 'Not in library')),
            h('div.rb-title', e.title),
            h('div.rb-sub', [e.year && !future ? e.year : null, stars(e.rating, e.votes)].filter(Boolean).flatMap((x, i) => i ? [' · ', x] : [x])),
            status ? h('div.rb-sub', status) : null),
        btn)
}

function reqLabel(r) {
    if (r.state === 'downloading') return h('span.req.req-dl', `Downloading${r.progress != null ? ` ${pct(r.progress)}` : '…'}`)
    if (r.state === 'downloaded') return h('span.req.req-done', 'Downloaded, arriving in your library shortly')
    if (r.state === 'notfound') return h('span.req.req-nf', `Not found yet. Searching again daily${r.searches ? ` (${r.searches} tries)` : ''}`)
    if (r.state === 'upcoming') return h('span.req.req-nf', 'Not out yet. Will download when released')
    return h('span.req', 'Searching…')
}

export function author(main, name) {
    name = decodeURIComponent(name)
    const books = S.books.filter(b => (b.author || 'Unknown').split(', ').includes(name))
    const groups = new Map()
    for (const b of books) {
        const key = lib.seriesBooks(b.seriesId).length > 1 ? b.series : 'Standalone'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(b)
    }
    add(main, backBar(), header(name), h('div.muted.pad-x', `${books.length} ${books.length === 1 ? 'book' : 'books'}`),
        [...groups.entries()].map(([g, bs]) => shelf(g, bs.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
            g === 'Standalone' ? {} : { onMore: () => go(`#/series/${bs[0].seriesId}`) })))
}

// ------------------------------------------------------------------ Sagas (a collection of series, in reading order)
const sagaAuthors = sg => [...new Set(lib.sagaBooks(sg).map(b => b.author).filter(Boolean))].join(', ')

function sagaTile(sg) {
    const bs = lib.sagaBooks(sg)
    const done = bs.filter(lib.isFinished).length
    const firsts = sg.series.map(id => lib.seriesBooks(id).find(b => sg.books.includes(b.id))).filter(Boolean)
    return h('button.tile.series-tile.saga-tile', { onclick: () => go(`#/saga/${sg.id}`) },
        h('div.stack', firsts.slice(0, 3).reverse().map((b, i, a) => h('div.stack-item', { style: { '--i': a.length - 1 - i } }, cover(b)))),
        h('div.tile-title', sg.title),
        h('div.book-meta', h('span.muted', `${sg.series.length} series · ${bs.length} books`)),
        done ? h('div.mini-bar', h('i', { style: { width: pct(done / bs.length) } })) : null)
}

export function saga(main, id) {
    const sg = S.sagas.find(s => s.id === +id)
    if (!sg) return add(main, backBar(), empty(S.loadedAt ? 'Saga not found.' : 'Loading…'))
    const bs = lib.sagaBooks(sg)
    const done = bs.filter(lib.isFinished).length
    const next = lib.sagaNext(sg)
    const pos = b => bs.indexOf(b) + 1
    add(main,
        h('div.back-bar.with-action', h('button.link', { onclick: () => history.length > 1 ? history.back() : go('#/library/sagas') }, icon('back'), 'Back'),
            h('button.link', { onclick: () => editSaga(sg) }, 'Edit')),
        h('header.saga-head',
            h('div.saga-kicker', 'Saga'),
            h('h1', sg.title),
            h('div.muted', `${sagaAuthors(sg)} · ${sg.series.length} series · ${bs.length} books`),
            h('div.hero-progress.saga-progress', h('div.bar', h('i', { style: { width: pct(done / (bs.length || 1)) } })),
                h('span', done === bs.length && bs.length ? 'All finished' : `${done} of ${bs.length} finished`))),
        next ? h('section.up-next-card',
            h('button.unc-cover', { onclick: () => readBook(next) }, cover(next)),
            h('div.unc-text',
                h('div.hero-kicker', lib.isStarted(next) ? 'Reading now' : 'Up next'),
                h('div.unc-title', next.title),
                h('div.muted', `${next.series}${next.number != null ? ` · Book ${next.number}` : ''}`),
                h('div.muted.small', `Book ${pos(next)} of ${bs.length} in ${sg.title}`),
                h('div.hero-actions',
                    h('button.btn.primary', { onclick: () => readBook(next) }, lib.isStarted(next) ? 'Continue' : 'Start'),
                    h('button.btn.ghost', { onclick: () => openBookSheet(next) }, 'Details')))) : null,
        sg.series.length > 1 ? h('section.shelf',
            h('div.shelf-head', h('h2', 'Series in this saga')),
            h('div.shelf-row.sagas-row', sg.series.map((sid, i) => S.seriesById.get(sid)).filter(Boolean)
                .map((s, i) => seriesTile(s, String(i + 1))))) : null,
        h('div.shelf-head', h('h2', 'Reading order')),
        // one section per stretch of the same series (sagas can alternate between series)
        sagaRuns(bs).map((run, i) => {
            const sid = run[0].seriesId
            const s = S.seriesById.get(sid)
            const sDone = run.filter(lib.isFinished).length
            return h('section.saga-series',
                h('button.saga-series-head', { onclick: () => go(`#/series/${sid}`) },
                    h('span.ss-num', String(i + 1)),
                    h('span.ss-name', s?.name ?? run[0].series),
                    h('span.muted.small', sDone === run.length ? 'Finished' : `${sDone}/${run.length}`),
                    icon('chevron', 'muted')),
                h('div.list', run.map(b => bookRow(b, { label: `Book ${pos(b)}${b.number != null ? ` · #${b.number} in series` : ''}`, upNext: b === next }))))
        }))
}

function sagaRuns(books) {
    const runs = []
    for (const b of books) {
        const last = runs[runs.length - 1]
        if (last && last[0].seriesId === b.seriesId) last.push(b)
        else runs.push([b])
    }
    return runs
}

// true when the saga is exactly "whole series, one after another" (what the editor produces)
function isSeriesOrdered(sg) {
    const expected = sg.series.flatMap(sid => lib.seriesBooks(sid).map(b => b.id))
    return expected.join(',') === sg.books.join(',')
}

export function editSaga(sg = null) {
    const title = h('input.text-input', { value: sg?.title ?? '', placeholder: 'Saga name, e.g. Realm of the Elderlings', maxlength: 80 })
    let order = [...(sg?.series ?? [])]
    const original = sg ? sg.series.join(',') : ''
    const listEl = h('div.saga-edit-list')
    const pickerEl = h('div.saga-picker')
    const q = h('input.search-input', { type: 'search', placeholder: 'Find a series or author', autocomplete: 'off' })
    const c = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

    const renderList = () => listEl.replaceChildren(...(order.length ? order.map((sid, i) => {
        const s = S.seriesById.get(sid)
        return h('div.se-row',
            h('span.ss-num', String(i + 1)),
            h('div.author-covers', lib.seriesBooks(sid).slice(0, 3).map(b => cover(b, '.tiny'))),
            h('div.ra-text', h('div.ra-name', s?.name ?? '?'), h('div.muted.small', `${s?.author ?? ''} · ${s?.books.length ?? 0} books`)),
            h('button.icon-btn.sm', { disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; renderList() }, 'aria-label': 'Move up' }, '↑'),
            h('button.icon-btn.sm', { disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; renderList() }, 'aria-label': 'Move down' }, '↓'),
            h('button.icon-btn.sm', { onclick: () => { order.splice(i, 1); renderList(); renderPicker() }, 'aria-label': 'Remove' }, icon('close')))
    }) : [h('p.muted.small.pad-s', 'Add series below, in the order you want to read them.')]))

    const renderPicker = () => {
        const term = q.value.trim().toLowerCase()
        const avail = S.series.filter(s => !order.includes(s.id)
            && (!term || `${s.name} ${s.author}`.toLowerCase().includes(term)))
            .sort((a, b) => c.compare(a.author, b.author) || c.compare(a.sortName, b.sortName))
        pickerEl.replaceChildren(...avail.slice(0, 60).map(s => h('button.se-row.pick', {
            onclick: () => { order.push(s.id); if (!title.value.trim() && order.length === 1) title.placeholder = `${s.author} saga`; renderList(); renderPicker() },
        },
            h('div.author-covers', lib.seriesBooks(s.id).slice(0, 3).map(b => cover(b, '.tiny'))),
            h('div.ra-text', h('div.ra-name', s.name), h('div.muted.small', `${s.author} · ${s.books.length} ${s.books.length === 1 ? 'book' : 'books'}`)),
            icon('plus', 'muted'))))
    }
    q.addEventListener('input', renderPicker)

    const save = h('button.btn.primary.wide', { onclick: async () => {
        const name = title.value.trim()
        if (!name) { title.focus(); toast('Give the saga a name'); return }
        if (!order.length) { toast('Add at least one series'); return }
        save.disabled = true; save.textContent = 'Saving…'
        try {
            const id = await lib.saveSaga({ id: sg?.id, title: name, summary: sg?.summary ?? '', series: order }, { reorder: order.join(',') !== original })
            sh.close()
            toast('Saga saved')
            go(`#/saga/${id}`)
            dispatchEvent(new Event('folio:rerender'))
        } catch (e) {
            console.error(e); toast("Couldn't save to Kavita")
            save.disabled = false; save.textContent = 'Save'
        }
    } }, 'Save')

    const del = sg ? h('button.btn.ghost.danger-btn.wide', { onclick: async () => {
        if (!confirm(`Delete the saga "${sg.title}"? The books and series stay; only the grouping is removed.`)) return
        try { await lib.deleteSaga(sg.id); sh.close(); toast('Saga deleted'); go('#/library/sagas') }
        catch { toast("Couldn't reach Kavita") }
    } }, 'Delete Saga') : null

    renderList(); renderPicker()
    const sh = sheet(h('div.saga-edit',
        h('label.field-label', 'Name'), title,
        sg && !isSeriesOrdered(sg) ? h('p.muted.small.edit-note',
            'This saga alternates between series book by book. Renaming keeps that order; changing the series list below resets it to whole series one after another.') : null,
        h('div.section-label', 'Series in reading order'), listEl,
        h('div.section-label', 'Add series'), q, pickerEl,
        h('div.saga-edit-actions', save, del)),
    { title: sg ? 'Edit Saga' : 'New Saga', className: 'saga-sheet' })
}

function backBar() {
    return h('div.back-bar', h('button.link', { onclick: () => history.length > 1 ? history.back() : go('#/library') }, icon('back'), 'Back'))
}

function wantButton(s) {
    const btn = h('button.btn.ghost', { onclick: async () => {
        const on = !s.wantToRead
        try {
            await api.setWantToRead(s.id, on)
            s.wantToRead = on
            toast(on ? `Added ${s.name} to Want to Read` : 'Removed from Want to Read')
            dispatchEvent(new Event('folio:library'))
        } catch { toast("Couldn't reach Kavita") }
    } }, icon(s.wantToRead ? 'check' : 'plus'), s.wantToRead ? 'Want to Read' : 'Want to Read')
    if (s.wantToRead) btn.classList.add('on')
    return btn
}

// ------------------------------------------------------------------ Search
export function search(main) {
    const input = h('input.search-input.big', { type: 'search', placeholder: 'Title, author or series', enterkeyhint: 'search', autocomplete: 'off', value: sessionStorage.getItem('folio.q') || '' })
    const results = h('div.search-page-results')
    const render = () => {
        const q = input.value
        sessionStorage.setItem('folio.q', q)
        const hits = lib.search(q)
        if (!q.trim()) {
            const authors = [...new Set(S.books.map(b => b.author).filter(Boolean))].sort()
            results.replaceChildren(h('h2.pad-x', 'Authors'),
                h('div.chips.wrap', authors.map(a => h('button.chip', { onclick: () => go(`#/author/${encodeURIComponent(a)}`) }, a))))
            return
        }
        const seriesHits = S.series.filter(s => s.books.length > 1 && s.name.toLowerCase().includes(q.trim().toLowerCase()))
        results.replaceChildren(
            seriesHits.length ? h('div', h('h2.pad-x', 'Series'), h('div.list', seriesHits.map(s =>
                h('button.row-author', { onclick: () => go(`#/series/${s.id}`) },
                    h('div.author-covers', lib.seriesBooks(s.id).slice(0, 3).map(b => cover(b, '.tiny'))),
                    h('div.ra-text', h('div.ra-name', s.name), h('div.muted', `${s.author} · ${s.books.length} books`)),
                    icon('chevron', 'muted'))))) : null,
            hits.length ? h('div', h('h2.pad-x', 'Books'), h('div.list', hits.slice(0, 80).map(b => bookRow(b)))) : null,
            !hits.length && !seriesHits.length ? empty('No matches.') : null)
    }
    input.addEventListener('input', render)
    add(main, header('Search'), h('div.search-wrap', icon('search', 'search-ico'), input), results)
    render()
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 50)
}

// ------------------------------------------------------------------ Settings
export function settings(main) {
    const u = currentUser()
    const dl = Object.entries(S.downloads)
    const used = dl.reduce((n, [, d]) => n + (d.size || 0), 0)
    const auto = localStorage.getItem('folio.autoDownload') !== '0'
    const est = h('span.muted', '')
    navigator.storage?.estimate?.().then(e => est.textContent = `${mb(e.usage)} used of ${mb(e.quota)} available to the app`)
    add(main, 
        backBar(),
        header('Settings'),
        h('div.group',
            h('div.row', h('span', 'Signed in as'), h('strong', u?.username ?? '')),
            h('div.row', h('span', 'Server'), h('span.muted', location.host)),
            h('button.row.action', { onclick: async () => { toast('Syncing…'); await lib.refresh(); toast(S.offline ? "Can't reach Kavita" : 'Library up to date') } },
                h('span', 'Sync library now'), icon('sync')),
            h('div.row', h('span', 'Last synced'), h('span.muted', S.loadedAt ? new Date(S.loadedAt).toLocaleString() : 'never'))),
        h('h2.pad-x', 'Reading'),
        h('div.group',
            h('button.row.action', { onclick: () => openAppearance(loadSettings()) },
                h('span', 'Appearance'), h('span.muted.small', 'theme, font, size, margins, with a sample page'))),
        h('h2.pad-x', 'Offline'),
        h('div.group',
            h('label.row.toggle', h('span', 'Save books on this device when opened'),
                h('input', { type: 'checkbox', checked: auto, onchange: e => localStorage.setItem('folio.autoDownload', e.target.checked ? '1' : '0') })),
            h('div.row', h('span', `${dl.length} downloaded ${dl.length === 1 ? 'book' : 'books'}`), h('span.muted', mb(used))),
            h('div.row.small', est),
            dl.length ? h('button.row.action.danger', { onclick: async () => {
                if (!confirm('Remove all downloaded books from this device? Reading progress stays.')) return
                for (const [id] of dl) await lib.removeDownload(+id)
                toast('Downloads removed')
                dispatchEvent(new Event('folio:rerender'))
            } }, h('span', 'Remove all downloads'), icon('trash')) : null),
        si.isAdmin() ? [
            h('h2.pad-x', 'Series lists & requests'),
            h('div.group',
                h('button.row.action', { onclick: async ev => {
                    const row = ev.currentTarget
                    try {
                        await si.syncAuthors()
                        toast('Checking authors with Chaptarr…')
                        const poll = async () => {
                            const st = await si.syncStatus()
                            row.querySelector('.muted').textContent = st.message || ''
                            if (st.running) return setTimeout(poll, 4000)
                            await si.refresh()
                            toast(st.error ? `Sync failed: ${st.error}` : `Series lists updated${st.added.length ? `, added ${st.added.join(', ')}` : ''}`)
                        }
                        poll()
                    } catch (e) { toast(e.message || "Couldn't reach folio-api") }
                } }, h('span', 'Update series lists'), h('span.muted.small', 'adds new authors to Chaptarr (nothing downloads)')),
                si.allRequests().map(r => h('div.row', h('span', h('strong', r.title), h('span.muted', ` · ${r.author}`)), reqLabel(r))),
                !si.allRequests().length ? h('div.row.small', h('span.muted', 'Books you tap "Get" on show up here.')) : null),
        ] : null,
        h('div.group',
            h('button.row.action.danger', { onclick: () => { if (confirm('Sign out of Folio on this device?')) logout() } }, h('span', 'Sign out'))),
        h('p.muted.pad-x.small', 'Folio reads your Kavita library and syncs reading progress with Kavita, so the Kavita web reader and other Kavita apps stay in step.'))
}
const mb = n => n ? (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`) : '0 MB'

// ------------------------------------------------------------------ Book detail sheet
export function openBookSheet(book) {
    const s = S.seriesById.get(book.seriesId)
    const sb = lib.seriesBooks(book.seriesId)
    const inSeries = sb.length > 1
    const content = h('div.detail')
    let sh
    const render = () => {
        const p = lib.progressOf(book)
        const finished = lib.isFinished(book)
        const started = lib.isStarted(book)
        const dl = lib.isDownloaded(book.id)
        content.replaceChildren(
            h('div.detail-top',
                h('button.detail-cover', { onclick: () => { sh.close(); readBook(book) } }, cover(book, '.big')),
                h('div.detail-info',
                    h('h2.detail-title', book.title),
                    h('button.link.author-link', { onclick: () => { sh.close(); go(`#/author/${encodeURIComponent(book.author)}`) } }, book.author),
                    inSeries ? h('button.link.series-link', { onclick: () => { sh.close(); go(`#/series/${book.seriesId}`) } },
                        `${book.series}${book.number != null ? ` · Book ${book.number}` : ''}`) : null,
                    lib.sagasOfBook(book.id).map(sg => h('button.link.series-link', { onclick: () => { sh.close(); go(`#/saga/${sg.id}`) } },
                        `${sg.title} · Book ${sg.books.indexOf(book.id) + 1} of ${sg.books.length}`)),
                    (() => {
                        const bi = si.bookInfo(book)
                        return bi?.rating ? h('a.rating-link', { href: bi.goodreads || '#', target: '_blank', rel: 'noopener' },
                            stars(bi.rating, bi.votes), bi.goodreads ? h('span.muted', ' ratings on Goodreads') : null) : null
                    })(),
                    started ? h('div.hero-progress', h('div.bar', h('i', { style: { width: pct(p) } })),
                        h('span', `${pct(p)}${book.avgHours ? ` · ${duration(lib.hoursLeft(book))} left` : ''}`)) : null,
                    h('button.btn.primary.wide', { onclick: () => { sh.close(); readBook(book) } },
                        finished ? 'Read Again' : started ? 'Continue' : 'Read'))),
            h('div.detail-actions',
                s ? wantButton(s) : null,
                h('button.btn.ghost', { onclick: async () => {
                    try {
                        if (dl) { await lib.removeDownload(book.id); toast('Removed from this device') }
                        else { toast('Downloading…'); await lib.download(book); toast('Saved for offline reading') }
                    } catch { toast("Couldn't download right now") }
                    render()
                } }, icon(dl ? 'trash' : 'cloud'), dl ? 'Remove Download' : 'Download'),
                h('button.btn.ghost', { onclick: async () => {
                    try {
                        if (finished) {
                            await api.markVolumeUnread(book.seriesId, book.volumeId)
                            book.pagesRead = 0
                            await lib.setLocal(book.id, { ...(S.local[book.id] ?? {}), finished: false, fraction: 0, pageNum: 0, cfi: null, updatedAt: Date.now(), synced: true })
                            toast('Marked as unread')
                        } else {
                            await api.markVolumeRead(book.seriesId, book.volumeId)
                            book.pagesRead = book.pages
                            await lib.setLocal(book.id, { ...(S.local[book.id] ?? {}), finished: true, fraction: 1, pageNum: book.pages, updatedAt: Date.now(), synced: true })
                            toast('Marked as finished')
                        }
                        dispatchEvent(new Event('folio:library'))
                    } catch { toast("Couldn't reach Kavita") }
                    render()
                } }, icon(finished ? 'undo' : 'checkCircle'), finished ? 'Mark as Unread' : 'Mark as Finished')),
            h('div.facts',
                fact('Length', book.avgHours ? duration(book.avgHours) : '—'),
                book.words ? fact('Words', book.words >= 1000 ? `${Math.round(book.words / 1000)}K` : String(book.words)) : fact('Pages', String(book.pages)),
                book.releaseYear ? fact('Published', book.releaseYear) : null,
                fact('Format', book.ext.replace('.', '').toUpperCase()),
                book.bytes ? fact('Size', mb(book.bytes)) : null),
            book.summary ? h('div.summary.clamp', { onclick: e => e.currentTarget.classList.remove('clamp') }, summaryNodes(book.summary)) : null,
            (() => {
                const nx = lib.nextAfter(book)
                return nx && finished ? shelf(nx.saga ? `Next in ${nx.saga.title}` : 'Next in Series', [nx.book]) : null
            })(),
            inSeries ? shelf(`More in ${book.series}`, sb.filter(b => b.id !== book.id)) : null)
        // series shelf tiles open their own sheet; close this one first
        content.querySelectorAll('.shelf .tile').forEach(t => t.addEventListener('click', () => sh.close(), { capture: true }))
    }
    render()
    sh = sheet(content, { className: 'detail-sheet', wide: true })
}
const fact = (k, v) => h('div.fact', h('div.fact-k', k), h('div.fact-v', v))
