// Cove shell: frosted top bar with centered pill tabs on wide screens, tab bar on phones, hash router, sign-in, player route.
import * as api from './api.js'
import { h, icon } from './ui.js'
import * as v from './views.js'
import { play } from './player.js'
import { imagesPage } from './images.js'
import * as sagas from './sagas.js'
import { requestsPage } from './requests.js'
import * as passkey from './passkey.js'
import { peoplePage, joinPage } from './people.js'
import { coveSwitcher } from './switcher.js'
import { serverPage } from './server.js'
import { pinGate } from './pin.js'
import './keys.js'
import { watchCollapsibles } from './collapse.js'
import { liveTvPage } from './livetv.js'
import { subsStylePage } from './subs-page.js'

const app = document.getElementById('app')
v.applyTextSize()
let main, lastPage = '#/home', closePlayer = null

function shell() {
    const libLinks = v.libs.map(l => [`#/lib/${l.Id}`, v.LIB_ICON[l.CollectionType] ?? 'film', l.Name])
    const nav = [['#/home', 'home', 'Home'], ...libLinks, ...(v.liveView ? [['#/livetv', 'antenna', 'Live TV']] : []), ['#/sagas', 'stack', 'Sagas'], ['#/search', 'search', 'Search']]
    // Cove = the whole app, this part is Cinema (key "reel"); the switcher lists the parts this person has (Folio with Books on; Vinyl later)
    const pt = api.parts()
    const parts = [...(pt.reel ? ['reel'] : []), ...(pt.folio ? ['folio'] : [])]
    const side = h('header.topbar',
        h('div.brand-row', coveSwitcher('reel', parts)),
        h('nav.top-nav', nav.filter(([href]) => href !== '#/search').map(([href, , label]) =>
            h('a.top-link', { href, dataset: { route: href } }, label))),
        h('div.top-icons',
            h('a.icon-btn.top-ico', { href: '#/search', dataset: { route: '#/search' }, 'aria-label': 'Search' }, icon('search')),
            h('a.icon-btn.top-ico', { href: '#/settings', dataset: { route: '#/settings' }, 'aria-label': 'Settings' }, icon('gear'))))
    const onScroll = () => side.classList.toggle('scrolled', scrollY > 30)
    addEventListener('scroll', onScroll, { passive: true }); onScroll()
    const tabs = h('nav.tabbar', nav.map(([href, ic, label]) =>
        h('a.tab', { href, dataset: { route: href }, 'aria-label': label }, icon(ic), h('span', label))))
    main = h('main#main')
    watchCollapsibles(main)   // fold-up sections on Settings and Server pages
    const phoneSwitch = h('div.phone-switch', coveSwitcher('reel', parts))   // phones: top left on Home
    app.replaceChildren(side, phoneSwitch, main, tabs)
}
function markActive(hash) {
    app.querySelector('.phone-switch')?.classList.toggle('on', hash === '#/home')
    for (const a of app.querySelectorAll('[data-route]')) {
        const r = a.dataset.route
        a.classList.toggle('active', hash === r || hash.startsWith(r + '/') || (r === '#/home' && hash.startsWith('#/item') && false))
    }
}

// ------------------------------------------------------------------ router
function parse() {
    const raw = location.hash || '#/home'
    const [path, qs = ''] = raw.split('?')
    return { raw, path, parts: path.replace(/^#\/?/, '').split('/').filter(Boolean), query: new URLSearchParams(qs) }
}
async function route() {
    // invite links work signed out
    if (location.hash.startsWith('#/join/')) { main = null; return joinPage(app, location.hash.slice(7), () => boot()) }
    if (!api.isLoggedIn()) return showLogin()
    if (!main) { await boot(); return }
    // no Cinema for this person: their Books if they have them, otherwise the empty-Cove page
    if (!api.parts().reel && !location.hash.startsWith('#/settings')) {
        if (api.parts().folio) return openBooks(main)
        return nothingPage()
    }
    const { raw, parts, query } = parse()
    if (parts[0] === 'play') {
        if (closePlayer) return
        closePlayer = await play(parts[1], {
            fromStart: query.get('start') === '0',
            audioIndex: query.has('audio') ? +query.get('audio') : undefined,
            subIndex: query.has('sub') ? +query.get('sub') : undefined,
            saga: query.has('saga') ? sagas.playerContext(query.get('saga')) : undefined,
            onClose: () => {
                closePlayer = null
                if (parse().parts[0] === 'play') history.length > 1 ? history.back() : location.replace(lastPage)
            },
        })
        return
    }
    if (closePlayer) { const c = closePlayer; closePlayer = null; c() }
    lastPage = raw
    markActive(parse().path)
    main.scrollTo?.(0, 0); scrollTo(0, 0)
    switch (parts[0]) {
        case 'lib': return v.section(main, parts[1], parts[2])
        case 'item': return v.itemPage(main, parts[1])
        case 'images': return imagesPage(main, parts[1])
        case 'sagas': return sagas.sagasPage(main)
        case 'livetv': return liveTvPage(main, parts[1])
        case 'requests': return requestsPage(main)
        case 'people': return location.replace('#/server/users')
        case 'server': return serverPage(main, parts[1], parts[2])
        case 'books': return openBooks(main)
        case 'collections': return v.collectionsPage(main)
        case 'tag': return v.tagPage(main, parts[1])
        case 'saga': return sagas.sagaPage(main, parts[1], query)
        case 'search': return v.searchPage(main)
        case 'settings': return parts[1] === 'subtitles' ? subsStylePage(main) : v.settingsPage(main)
        default: return v.home(main)
    }
}
addEventListener('hashchange', route)
addEventListener('cove:logout', () => { main = null; showLogin() })
addEventListener('cove:me', () => { if (main) { shell(); route() } })   // Books turned on/off, level changed

async function boot() {
    app.replaceChildren(h('div.boot', h('div.spinner')))
    api.refreshMe()
    try { await v.loadLibs() } catch (e) {
        if (!api.isLoggedIn()) return showLogin()
        app.replaceChildren(h('div.boot', h('p', 'Can’t reach the server.'), h('button.pill.white', { onclick: () => location.reload() }, 'Try Again')))
        return
    }
    shell()
    route()
}

function nothingPage() {
    main = null
    const who = api.me()?.name || 'friend'
    app.replaceChildren(h('div.nothing',
        h('div.nothing-art', { html: '<svg viewBox="0 0 220 140" aria-hidden="true"><path d="M10 112c30-10 60-10 100 0s70 10 100 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".35"/><path d="M30 124c30-8 60-8 90 0s60 8 80 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".2"/><ellipse cx="110" cy="104" rx="46" ry="9" fill="currentColor" opacity=".12"/><path d="M110 100V44" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M110 46c-22-14-40-6-48 4M110 46c18-16 38-12 46-2M110 46c-6-20-24-26-36-22M110 46c10-18 30-20 40-14" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round"/></svg>' }),
        h('h1', 'Your Cove is a little empty'),
        h('p', `Hi ${who}. Right now there’s nothing turned on for you here: no movies, no shows, no books, no music. Just one very lonely palm tree.`),
        h('p.muted', `Ask ${api.ownerName()} to switch something on for you. Then tap Check Again.`),
        h('div.nothing-btns',
            h('button.pill.white', { onclick: async () => { await api.refreshMe(); location.replace('/#/home'); location.reload() } }, 'Check Again'),
            h('button.pill.glass', { onclick: () => v.accountSheet?.() }, 'Switch Account'),
            h('button.pill.glass', { onclick: () => api.logout() }, 'Sign Out'))))
}

// ------------------------------------------------------------------ sign in
function showLogin() {
    main = null
    let last = ''
    try { last = localStorage.getItem('cove.lastUser') || '' } catch {}
    const user = h('input', { type: 'text', inputmode: 'email', placeholder: 'Email', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, value: last })
    const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' })
    const err = h('div.login-err', { role: 'alert', 'aria-live': 'assertive' })
    const btn = h('button.pill.white.block', { type: 'submit' }, 'Sign In')
    const form = h('form.login-card',
        { onsubmit: async e => {
            e.preventDefault()
            err.textContent = ''
            btn.disabled = true; btn.textContent = 'Signing in…'
            try {
                await api.login(user.value.trim(), pass.value)
                try { localStorage.setItem('cove.lastUser', user.value.trim()) } catch {}
                if (parse().parts[0] === 'play') location.replace('#/home')
                await boot()
            } catch (x) {
                err.textContent = x.message
                err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake')   // wrong input shakes (motion-rules)
                btn.disabled = false; btn.textContent = 'Sign In'
            }
        } },
        h('img.login-icon', { src: 'icons/icon-192.png', alt: '' }),
        (() => { const t = h('h1', api.cachedServerInfo().name || 'Cove'); api.serverInfo().then(i => { if (i.name) t.textContent = i.name }); return t })(),
        h('p.muted', 'Movies and shows at home.'),
        h('div.field-group', user, pass),
        err, btn,
        h('button.link-btn', { type: 'button', onclick: () => codeLogin() }, 'Sign in with a code instead'))
    // Face ID first on the HTTPS address, if this device can do passkeys
    if (passkey.supported()) {
        const fid = h('button.pill.glass.block.faceid', { type: 'button', onclick: async () => {
            err.textContent = ''; fid.disabled = true; fid.textContent = 'Checking…'
            try { await passkey.signIn(); if (parse().parts[0] === 'play') location.replace('#/home'); await boot() }
            catch (x) { err.textContent = x.name === 'NotAllowedError' ? 'Face ID was cancelled' : (x.message || 'Face ID didn’t work'); fid.disabled = false; fid.textContent = 'Sign in with Face ID' }
        } }, 'Sign in with Face ID')
        form.insertBefore(fid, form.querySelector('.field-group'))
    }
    // accounts already signed in on this device: one tap, no password
    const saved = api.accounts()
    if (saved.length) form.insertBefore(h('div.acct-list.login-accts', h('div.muted.small', 'On this device'), saved.map(a => h('button.acct-row', { type: 'button', onclick: async () => {
        err.textContent = ''
        if (!(await pinGate(a))) return
        try { await api.switchTo(a.userId); location.replace('/#/home'); location.reload() } catch (x) { err.textContent = x.message; showLogin() }
    } }, h('span.acct-ava', (a.name || '?').slice(0, 1).toUpperCase()), h('span.acct-name', a.name), icon('chevron')))), form.querySelector('.field-group'))
    app.replaceChildren(h('div.login', form))
    setTimeout(() => (saved.length ? null : (last ? pass : user))?.focus(), 50)
}

// A code on this screen, approved from Settings on a device that's already signed in.
async function codeLogin() {
    const box = h('div.code-digits', { 'aria-live': 'polite', 'aria-label': 'Sign-in code' }, h('div.spinner'))
    const note = h('p.muted', 'On a device that’s already signed in, open Settings → Approve a Device and type this code.')
    let stop = false
    app.replaceChildren(h('div.login', h('div.login-card',
        h('img.login-icon', { src: 'icons/icon-192.png', alt: '' }),
        h('h1', 'Sign in with a code'), box, note,
        h('button.link-btn', { onclick: () => { stop = true; showLogin() } }, 'Use name and password'))))
    try {
        const { Code, Secret } = await api.codeStart()
        box.replaceChildren(...Code.split('').map(c => h('span', c)))
        const until = Date.now() + 10 * 60_000
        while (!stop && Date.now() < until) {
            await new Promise(r => setTimeout(r, 2500))
            if (stop) return
            const st = await api.codeCheck(Secret).catch(() => null)
            if (st?.Authenticated) {
                await api.codeFinish(Secret)
                if (parse().parts[0] === 'play') location.replace('#/home')
                return boot()
            }
        }
        if (!stop) { box.replaceChildren(h('span.muted.small', 'Code expired')); note.replaceChildren(h('button.pill.glass', { onclick: codeLogin }, 'New Code')) }
    } catch (e) { box.replaceChildren(h('span.muted.small', e.message)) }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
route()

// Books = Folio's app at /books/, signed in to Kavita for this Cove account (cove-api trades their Kavita key for a session)
async function openBooks(main) {
    if (!api.hasBooks()) return location.replace('#/home')
    main.replaceChildren(h('div.loading-page', h('div.spinner'), 'Opening your books…'))
    try {
        const r = await fetch('/cove-api/books/session', { headers: { Authorization: api.authHeaderValue() } })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error)
        localStorage.setItem('folio.auth', JSON.stringify(d))
        location.href = '/books/'
    } catch (e) {
        main.replaceChildren(h('div.empty', h('div', icon('book')), h('p', e.message || 'Couldn’t open Books'), h('a.pill.glass', { href: '#/home' }, 'Back to Home')))
    }
}
