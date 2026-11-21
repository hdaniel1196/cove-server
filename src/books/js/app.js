import { isLoggedIn, login, currentUser } from './api.js'
import * as lib from './library.js'
import * as views from './views.js'
import * as seriesInfo from './series-info.js'
import { openReader, closeReader, isReading, flushQueue, noZoom } from './reader.js'
import { h, icon, toast } from './ui.js'

const app = document.getElementById('app')
let main, lastBase = '#/home', hadBase = false
const IN_COVE = location.pathname.startsWith('/books')
if (IN_COVE) {
    document.body.classList.add('cove')
    if (!location.hash) history.replaceState(null, '', '#/home')   // so the Reading Now tab lights up
    for (const href of ['https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap', 'css/cove.css'])
        document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }))
    document.querySelectorAll('meta[name=theme-color]').forEach(m => m.setAttribute('content', '#0d1220'))
}
// Cove's switcher (Cove > Folio, dropdown to Reel), shared file from Cove itself
let coveSwitcher = null
if (IN_COVE) try { ({ coveSwitcher } = await import('/js/switcher.js')) } catch {}
if (IN_COVE) try { await (await import('./reader-settings.js')).syncSettings() } catch {}   // reader settings follow the person in Cove
const switcherOr = fallback => coveSwitcher ? coveSwitcher('folio', ['reel', 'folio']) : fallback

// ------------------------------------------------------------------ shell
function shell() {
    const nav = [['#/home', 'home', 'Reading Now'], ['#/library', 'library', 'Library'], ['#/search', 'search', 'Search']]
    const link = ([href, ic, label], cls) => h('a.' + cls, { href, dataset: { route: href } }, ic === 'cove' ? h('img.cove-ico', { src: '/icons/icon-192.png', alt: '' }) : icon(ic), h('span', label))
    const side = h('nav.sidebar',
        h('div.brand', h('img', { src: 'icons/icon-192.png', alt: '' }), IN_COVE ? 'Books' : 'Folio'),
        nav.map(n => link(n, 'side-link')),
        h('div.side-label', 'Collections'),
        [['#/library/books', 'Books'], ['#/library/comics', 'Graphic Novels'], ['#/library/manga', 'Manga'], ['#/library/series', 'Series & Sagas'], ['#/library/authors', 'Authors'],
         ['#/library/want', 'Want to Read'], ['#/library/finished', 'Finished'], ['#/library/downloaded', 'Downloaded']]
            .map(([href, label]) => h('a.side-link.sub', { href, dataset: { route: href } }, label)),
        h('div.spacer'),
        h('a.side-link.sub', { href: '#/settings', dataset: { route: '#/settings' } }, icon('gear'), h('span', 'Settings')))
    main = h('main#main')
    const tabs = h('nav.tabbar', nav.map(n => link(n, 'tab')))
    if (IN_COVE) {   // Cove's top bar: brand goes back to Cove, pill tabs, search + settings on the right
        const top = h('header.topbar',
            h('div.brand-row', switcherOr(h('a.brand.back-cove', { href: '/#/home', 'aria-label': 'Back to Cove' }, icon('back'), h('img', { src: '/icons/icon-192.png', alt: '' }), 'Cove'))),
            h('nav.top-nav', [['#/home', 'Reading Now'], ['#/library', 'Library'], ['#/library/series', 'Series & Sagas'], ['#/library/want', 'Want to Read']]
                .map(([href, label]) => h('a.top-link', { href, dataset: { route: href } }, label))),
            h('div.top-icons',
                h('a.top-ico', { href: '#/search', dataset: { route: '#/search' }, 'aria-label': 'Search' }, icon('search')),
                h('a.top-ico', { href: '#/settings', dataset: { route: '#/settings' }, 'aria-label': 'Settings' }, icon('gear'))))
        const onScroll = () => top.classList.toggle('scrolled', scrollY > 30)
        addEventListener('scroll', onScroll, { passive: true }); onScroll()
        const phoneBack = h('div.phone-back', switcherOr(h('a', { href: '/#/home' }, icon('back'), 'Cove')))
        return app.replaceChildren(top, phoneBack, main, tabs)
    }
    app.replaceChildren(side, main, tabs)
}

function markActive(hash) {
    const path = hash.split('?')[0]
    const libPath = path === '#/library' ? '#/library/all' : path
    for (const a of app.querySelectorAll('[data-route]')) {
        const r = a.dataset.route
        let on
        if (a.classList.contains('tab')) on = path.startsWith(r) || (r === '#/library' && /^#\/(series|author|saga)/.test(path))
        else if (r === '#/library') on = libPath === '#/library/all'
        else on = libPath === r
        a.classList.toggle('active', on)
    }
}

// ------------------------------------------------------------------ router
function parse() {
    const raw = location.hash || '#/home'
    const [path, qs] = raw.split('?')
    const parts = path.replace(/^#\//, '').split('/')
    return { raw, path, parts, query: Object.fromEntries(new URLSearchParams(qs || '')) }
}

const scrollMemo = new Map()
async function route() {
    if (!isLoggedIn()) return showLogin()
    if (!main) shell()
    const { raw, parts, query } = parse()
    if (parts[0] === 'read') {
        const book = lib.state.byId.get(+parts[1])
        if (!book) {
            if (lib.state.loadedAt) location.replace('#/home')
            else main.replaceChildren(h('div.loading-page', h('div.spinner'), 'Loading your library…'))
            return
        }
        if (!isReading()) openReader(book, { onClose: () => {
            if (hadBase) history.back()
            else location.replace(lastBase)
        } })
        return
    }
    if (isReading()) closeReader()
    hadBase = true
    lastBase = raw
    render(raw, parts, query)
}

function render(raw = location.hash, parts = parse().parts, query = parse().query) {
    if (!main) return
    const prevKey = main.dataset.key
    if (prevKey) scrollMemo.set(prevKey, scrollEl().scrollTop)
    main.replaceChildren()
    main.dataset.key = raw
    const [v, a] = parts
    if (v === 'library') views.library(main, a || 'all', query)
    else if (v === 'series') views.series(main, a)
    else if (v === 'saga') views.saga(main, a)
    else if (v === 'author') views.author(main, a)
    else if (v === 'search') views.search(main)
    else if (v === 'settings') views.settings(main)
    else views.home(main)
    markActive(raw)
    const y = prevKey === raw ? scrollMemo.get(raw) : (scrollMemo.get(raw) ?? 0)
    requestAnimationFrame(() => scrollEl().scrollTop = y ?? 0)
}
const scrollEl = () => !IN_COVE && matchMedia('(min-width: 900px)').matches ? main : document.scrollingElement

addEventListener('hashchange', route)
addEventListener('folio:rerender', () => render())
let libTimer
addEventListener('folio:library', () => {
    if (!isReading() && parse().parts[0] === 'read') return route()
    if (isReading() || document.querySelector('.sheet-wrap')) return
    clearTimeout(libTimer)
    libTimer = setTimeout(() => {
        const el = document.activeElement
        if (el?.matches?.('input.search-input')) return
        render()
    }, 120)
})
addEventListener('folio:logout', () => { main = null; showLogin() })

// ------------------------------------------------------------------ login
function showLogin() {
    main = null
    if (IN_COVE) return location.replace('/#/books')   // Cove gets a fresh Kavita session for this account
    const user = h('input', { name: 'username', autocomplete: 'username', placeholder: 'Username', autocapitalize: 'none', required: true })
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true })
    const err = h('div.login-error')
    const btn = h('button.btn.primary.wide', { type: 'submit' }, 'Sign In')
    const form = h('form.login-card', {
        onsubmit: async e => {
            e.preventDefault()
            btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = ''
            try {
                await login(user.value.trim(), pass.value)
                await start()
            } catch (ex) {
                err.textContent = ex.message
                btn.disabled = false; btn.textContent = 'Sign In'
            }
        },
    },
        h('img.login-icon', { src: 'icons/icon-192.png', alt: '' }),
        h('h1', 'Folio'),
        h('p.muted', 'Sign in with your Kavita account'),
        user, pass, err, btn)
    app.replaceChildren(h('div.login', form))
}

// ------------------------------------------------------------------ boot
async function start() {
    shell()
    const first = lib.init()
    route()
    try { await first } catch (e) { console.error(e); toast('Could not load the library') }
    seriesInfo.init()
    flushQueue()
}

addEventListener('online', () => { lib.refresh().then(flushQueue) })
// refresh the library when coming back to the app (progress from other devices)
let hiddenAt = 0
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now()
    else if (isLoggedIn() && !isReading() && Date.now() - hiddenAt > 60_000) { lib.refresh().then(flushQueue); seriesInfo.refresh() }
})

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e))
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        // new version took over; reload only if not mid-book
        if (!reloaded && !isReading()) { reloaded = true; location.reload() }
    })
}

noZoom(document)   // no pinch / double-tap zoom anywhere in the app
if (isLoggedIn()) start(); else showLogin()
window.folio = { lib, currentUser }
