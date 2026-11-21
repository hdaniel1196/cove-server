// The reading screen: foliate-js renders the book; we add chrome, tap zones, settings, TOC,
// search, status line, reading-speed estimates and progress sync with Kavita.
import { makeBook } from '../vendor/foliate/view.js'
import { api, OfflineError } from './api.js'
import * as lib from './library.js'
import * as db from './db.js'
import { h, icon, sheet, toast, pct } from './ui.js'
import { FULL_WIDTH, loadSettings, saveSettings, activeTheme, bookCSS } from './reader-settings.js'
import { openAppearance } from './appearance.js'

let active = null

// Safari still pinch-zooms despite the viewport tag in some cases; its gesture events can be cancelled
export function noZoom(doc) {
    const stop = e => e.preventDefault()
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick'])
        doc.addEventListener(ev, stop, { passive: false })
    doc.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })
}
export const isReading = () => !!active

export async function openReader(book, { onClose } = {}) {
    if (active) await active.close(true)
    const r = new Reader(book, onClose)
    active = r
    await r.open()
    return r
}
export const closeReader = () => active?.close()

class Reader {
    constructor(book, onClose) {
        this.book = book
        this.onClose = onClose
        this.s = loadSettings()
        this.loc = null
        this.lastTurn = null
        this.pushTimer = null
        this.chromeShown = false
    }

    // ------------------------------------------------------------------ setup
    async open() {
        const b = this.book
        this.view = document.createElement('foliate-view')
        this.statusTop = h('div.r-status.top', h('span.r-st-title', b.title), h('span.r-st-clock'))
        this.statusBottom = h('div.r-status.bottom', h('span.r-st-left'), h('span.r-st-right'))
        this.dim = h('div.r-dim')
        this.loading = h('div.r-loading', h('div.spinner'), h('div', 'Opening…'))
        this.backPill = h('button.r-backpill', { onclick: () => this.view.history.back() }, icon('undo'), 'Back')
        this.topBar = h('header.r-bar.top',
            h('button.icon-btn', { onclick: () => this.close(), 'aria-label': 'Close book' }, icon('back')),
            h('div.r-bar-title', h('div.t', b.title), h('div.a', b.author || b.series)),
            b.isComic ? null : h('button.icon-btn', { onclick: () => this.showTOC(), 'aria-label': 'Contents' }, icon('list')),
            b.isComic ? null : h('button.icon-btn', { onclick: () => this.showSearch(), 'aria-label': 'Search' }, icon('search')),
            h('button.icon-btn', { onclick: () => this.showSettings(), 'aria-label': 'Appearance' }, icon('aa')))
        this.slider = h('input.r-slider', { type: 'range', min: 0, max: 1, step: 'any', value: 0 })
        this.sliderLabel = h('div.r-slider-label')
        this.bottomBar = h('footer.r-bar.bottom', this.sliderLabel, this.slider)
        this.stage = h('div.r-stage', this.view)
        this.el = h('div.reader', this.stage, this.statusTop, this.statusBottom, this.dim,
            this.topBar, this.bottomBar, this.backPill, this.loading)
        document.body.append(this.el)
        document.body.classList.add('reading')
        this.applyTheme()

        this.slider.addEventListener('input', () => this.sliderLabel.textContent = pct(+this.slider.value))
        this.slider.addEventListener('change', () => { this.jumped = true; this.view.goToFraction(+this.slider.value) })
        this.view.addEventListener('click', e => this.onTap(e.clientX, e.clientY, e))
        this.view.addEventListener('load', e => this.onLoad(e.detail))
        this.view.addEventListener('relocate', e => this.onRelocate(e.detail))
        this.view.history.addEventListener('index-change', () =>
            this.backPill.classList.toggle('show', this.view.history.canGoBack && this.jumped))
        this.keyHandler = e => this.onKey(e)
        document.addEventListener('keydown', this.keyHandler)
        this.visHandler = () => {
            if (document.visibilityState === 'hidden') this.pushNow()
            else { this.lastTurn = null; this.wake() }
        }
        document.addEventListener('visibilitychange', this.visHandler)
        this.clock = setInterval(() => this.updateStatus(), 30000)
        this.mq = matchMedia('(prefers-color-scheme: dark)')
        this.mqHandler = () => this.applyAll()
        this.mq.addEventListener('change', this.mqHandler)

        let file
        try {
            file = await lib.getFile(b, { save: localStorage.getItem('folio.autoDownload') !== '0' })
        } catch (e) {
            this.loading.replaceChildren(h('div', e instanceof OfflineError
                ? "This book isn't downloaded, and Kavita can't be reached right now."
                : `Couldn't open this book (${e.message}).`),
                h('button.btn', { onclick: () => this.close() }, 'Close'))
            return
        }
        const fbook = await makeBook(file)
        if (b.isManga) fbook.dir = 'rtl'   // manga: pages and taps go right to left
        await this.view.open(fbook)
        this.isFixed = this.view.isFixedLayout
        this.el.classList.toggle('fixed', this.isFixed)
        this.applyAll()

        const target = await this.startTarget()
        await this.view.init({ lastLocation: target, showTextStart: !this.isFixed })
        this.loading.remove()
        this.wake()
        this.sliderTicks()
    }

    // Where to open: our own last position, unless Kavita has a newer one from another app/device
    async startTarget() {
        const b = this.book
        const local = lib.state.local[b.id]
        let remote = null
        try { remote = await api.getProgress(b.id) } catch {}
        const remoteAt = lib.utc(remote?.lastModifiedUtc)
        const remotePage = remote?.pageNum ?? 0
        const sections = this.view.book.sections.length
        if (remote && remoteAt > (local?.updatedAt ?? 0) + 5000 && remotePage !== (local?.pageNum ?? -1)) {
            if (remotePage > 0 && remotePage < sections) {
                if (local) toast('Picked up where you left off on another device')
                return remotePage
            }
            if (remotePage >= sections && local?.cfi) return local.cfi
        }
        return local?.cfi ?? (remotePage > 0 && remotePage < sections ? remotePage : null)
    }

    // ------------------------------------------------------------------ appearance
    applyTheme() {
        const t = activeTheme(this.s)
        this.el.style.setProperty('--r-bg', t.bg)
        this.el.style.setProperty('--r-fg', t.fg)
        this.el.classList.toggle('r-dark', t.dark)
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg)
        this.dim.style.opacity = String(1 - this.s.brightness)
    }
    applyAll() {
        const s = this.s, r = this.view.renderer
        this.applyTheme()
        if (!r) return
        if (this.isFixed) {
            r.setAttribute('zoom', s.comicZoom)
            return
        }
        r.setAttribute('flow', s.flow)
        r.setAttribute('gap', `${s.margins}%`)
        this.el.style.setProperty('--r-margin', `${s.margins}vw`)   // status line lines up with the text
        r.setAttribute('margin', `${this.compact() ? 40 : 52}px`)
        r.setAttribute('max-inline-size', s.maxWidth >= FULL_WIDTH ? '9999px' : `${s.maxWidth}px`)
        r.setAttribute('max-column-count', s.columns === '1' ? '1' : '2')
        s.animated ? r.setAttribute('animated', '') : r.removeAttribute('animated')
        r.setStyles?.(bookCSS(s))
        this.el.classList.toggle('scrolled', s.flow === 'scrolled')
    }
    compact = () => innerHeight < 600
    save() { saveSettings(this.s); this.applyAll(); this.updateStatus() }

    // ------------------------------------------------------------------ input
    onLoad({ doc }) {
        // every page document (comics too): no zooming; quick taps turn pages
        doc.documentElement.style.touchAction = 'pan-x pan-y'
        if (doc.body) doc.body.style.touchAction = 'pan-x pan-y'
        noZoom(doc)
        doc.addEventListener('click', e => {
            if (e.defaultPrevented || e.target.closest?.('a[href]')) return
            const sel = doc.getSelection()
            if (sel && !sel.isCollapsed) return
            const fr = doc.defaultView.frameElement?.getBoundingClientRect()
            // fixed-layout pages are scaled with CSS transforms
            const sx = fr && doc.documentElement.clientWidth ? fr.width / doc.documentElement.clientWidth : 1
            const sy = fr && doc.documentElement.clientHeight ? fr.height / doc.documentElement.clientHeight : 1
            this.onTap((fr?.left ?? 0) + e.clientX * (this.isFixed ? sx : 1), (fr?.top ?? 0) + e.clientY * (this.isFixed ? sy : 1), e)
        })
        doc.addEventListener('keydown', this.keyHandler)
        if (this.isFixed) {
            // comics: horizontal swipes turn pages (the paginator handles this for reflowable books)
            let sx = 0, sy = 0, st = 0
            doc.addEventListener('touchstart', e => { sx = e.touches[0].screenX; sy = e.touches[0].screenY; st = e.timeStamp }, { passive: true })
            doc.addEventListener('touchend', e => {
                const dx = e.changedTouches[0].screenX - sx, dy = e.changedTouches[0].screenY - sy
                if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && e.timeStamp - st < 600
                    && (globalThis.visualViewport?.scale ?? 1) <= 1.01)
                    dx < 0 ? this.view.goRight() : this.view.goLeft()
            }, { passive: true })
        }
    }

    onTap(x, y, e) {
        if (this.el.querySelector('.r-popup')) return
        if (this.chromeShown) { this.toggleChrome(false); return }
        const w = innerWidth
        const zone = x < w * 0.28 ? 'left' : x > w * 0.72 ? 'right' : 'center'
        if (this.s.tapZones === 'off' || zone === 'center' || this.s.flow === 'scrolled') {
            if (zone === 'center' || this.s.tapZones === 'off' || this.s.flow === 'scrolled') this.toggleChrome(true)
            return
        }
        e?.preventDefault?.()
        if (zone === 'right' || this.s.tapZones === 'forward') this.view.goRight()
        else this.view.goLeft()
    }

    onKey(e) {
        if (e.target?.closest?.('input, textarea, select') || document.querySelector('.sheet-wrap:not(.closing)')) return
        const k = e.key
        if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); this.view.goRight() }
        else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); this.view.goLeft() }
        else if (k === 'Escape') this.chromeShown ? this.toggleChrome(false) : this.close()
        else if (k === 't' && !this.isFixed) this.showTOC()
        else if (k === 'Enter') this.toggleChrome()
    }

    toggleChrome(show = !this.chromeShown) {
        this.chromeShown = show
        this.el.classList.toggle('chrome', show)
        if (!show) this.view.deselect?.()
    }

    // ------------------------------------------------------------------ position & progress
    onRelocate(d) {
        const prev = this.loc
        this.loc = d
        if (!this.slider.matches(':active')) this.slider.value = d.fraction ?? 0
        this.sliderLabel.textContent = this.chapterLabel(d)
        if (d.reason === 'page' || d.reason === 'snap') this.learnSpeed(prev, d)
        if (d.reason !== 'page' && d.reason !== 'snap' && d.reason !== 'scroll' && prev) this.jumped = true
        this.updateStatus()
        this.saveLocal(d)
    }

    chapterLabel(d) {
        if (this.isFixed) return d ? `Page ${d.section.current + 1} of ${d.section.total}` : ''
        return d?.tocItem?.label?.trim() || ''
    }

    // Reading speed: minutes per foliate "time unit" (1600 bytes of text), learned from page turns.
    async learnSpeed(prev, d) {
        const now = performance.now()
        const last = this.lastTurn
        this.lastTurn = now
        if (!last || !prev?.time || !d.time) return
        const units = prev.time.total - d.time.total
        const secs = (now - last) / 1000
        if (units <= 0 || secs < 2 || secs > 240) return
        const sample = secs / 60 / units
        if (sample < 0.05 || sample > 10) return
        const speed = this.speed ?? (await db.get('kv', 'speed')) ?? 1
        this.speed = speed * 0.93 + sample * 0.07
        if (Math.random() < 0.2) db.set('kv', 'speed', this.speed)
    }

    updateStatus() {
        const d = this.loc, s = this.s.status
        const now = new Date()
        this.statusTop.querySelector('.r-st-clock').textContent = s.clock
            ? now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
        if (!d) return
        const speed = this.speed ?? 1
        const parts = []
        const r = this.view.renderer
        if (s.chapterPages && !this.isFixed && this.s.flow !== 'scrolled' && r?.pages > 2)
            parts.push(`${Math.min(r.page, r.pages - 2)} of ${r.pages - 2}`)
        if (s.chapterTime && !this.isFixed && d.time) {
            const m = Math.round(d.time.section * speed)
            parts.push(m < 1 ? 'Last page in chapter' : `${m} min left in chapter`)
        }
        if (s.bookTime && !this.isFixed && d.time) {
            const m = Math.round(d.time.total * speed)
            parts.push(m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left in book` : `${m} min left in book`)
        }
        if (s.bookPercent) parts.push(pct(d.fraction ?? 0))
        this.statusBottom.querySelector('.r-st-left').textContent = s.chapter ? this.chapterLabel(d) : ''
        this.statusBottom.querySelector('.r-st-right').textContent = parts.join('  ·  ')
    }

    atEnd() {
        const d = this.loc
        if (!d) return false
        const secs = this.view.book.sections
        const lastLinear = secs.findLastIndex(x => x.linear !== 'no')
        if (this.isFixed) return d.section.current >= secs.length - 1
        return d.section.current >= lastLinear && (this.view.renderer.atEnd || (d.fraction ?? 0) > 0.995)
    }

    async saveLocal(d) {
        const b = this.book
        const finished = this.atEnd()
        const rec = {
            cfi: d.cfi, index: d.section?.current ?? 0, fraction: d.fraction ?? 0,
            pageNum: finished ? b.pages : (d.section?.current ?? 0),
            finished, updatedAt: Date.now(), synced: false,
        }
        await lib.setLocal(b.id, rec)
        clearTimeout(this.pushTimer)
        this.pushTimer = setTimeout(() => this.pushNow(), finished ? 300 : 2500)
        if (finished && !this.finishedShown) { this.finishedShown = true; this.showFinished() }
    }

    async pushNow() {
        clearTimeout(this.pushTimer)
        await pushProgress(this.book)
    }

    showFinished() {
        const nx = lib.nextAfter(this.book)
        toast(nx ? `Finished! Up next${nx.saga ? ` in ${nx.saga.title}` : ''}: ${nx.book.title}` : 'Finished! Marked as read in Kavita.', 4500)
    }

    // ------------------------------------------------------------------ keep screen on
    async wake() {
        if (!this.s.keepAwake || !navigator.wakeLock || document.visibilityState !== 'visible') return
        try { this.lock = await navigator.wakeLock.request('screen') } catch {}
    }

    // ------------------------------------------------------------------ slider ticks (chapter starts)
    sliderTicks() {
        if (this.isFixed) return
        const fr = this.view.getSectionFractions?.() ?? []
        if (fr.length > 1 && fr.length < 150) {
            const stops = fr.map(f => `transparent calc(${(f * 100).toFixed(3)}% - 1px), var(--tick) calc(${(f * 100).toFixed(3)}% - 1px), var(--tick) calc(${(f * 100).toFixed(3)}% + 0px), transparent calc(${(f * 100).toFixed(3)}% + 0px)`)
            this.slider.style.setProperty('--ticks', `linear-gradient(90deg, ${stops.join(',')})`)
        }
    }

    // ------------------------------------------------------------------ sheets
    showTOC() {
        this.toggleChrome(false)
        const toc = this.view.book.toc ?? []
        const current = this.loc?.tocItem?.href
        let currentEl = null
        const render = (items, depth = 0) => items.map(item => {
            const el = h('button.toc-item', {
                style: { paddingLeft: `${16 + depth * 18}px` },
                onclick: () => { this.jumped = true; this.view.goTo(item.href); s.close() },
            }, h('span', item.label?.trim() || 'Untitled'))
            if (item.href === current) { el.classList.add('current'); currentEl = el }
            return [el, item.subitems?.length ? render(item.subitems, depth + 1) : []]
        })
        const list = h('div.toc', this.isFixed ? h('p.muted.pad', 'Pages') : null, render(toc))
        const s = sheet(list, { title: 'Contents', className: 'toc-sheet' })
        requestAnimationFrame(() => currentEl?.scrollIntoView({ block: 'center' }))
    }

    showSearch() {
        this.toggleChrome(false)
        const input = h('input.search-input', { type: 'search', placeholder: 'Search this book', enterkeyhint: 'search' })
        const results = h('div.search-results')
        const status = h('div.muted.pad-s')
        let token = 0
        const run = async () => {
            const q = input.value.trim()
            const my = ++token
            results.replaceChildren()
            if (q.length < 2) { status.textContent = ''; return }
            status.textContent = 'Searching…'
            let count = 0
            for await (const r of this.view.search({ query: q })) {
                if (my !== token) return
                if (r === 'done') break
                if (r.progress != null) { status.textContent = `Searching… ${pct(r.progress)}`; continue }
                if (r.subitems) {
                    results.append(h('div.search-group', r.label))
                    for (const it of r.subitems) {
                        count++
                        results.append(h('button.search-hit', {
                            onclick: () => { this.jumped = true; this.view.goTo(it.cfi); s.close() },
                        }, it.excerpt.pre, h('mark', it.excerpt.match), it.excerpt.post))
                    }
                }
            }
            if (my === token) status.textContent = count ? `${count} result${count === 1 ? '' : 's'}` : 'No results'
        }
        let t
        input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350) })
        const s = sheet(h('div', input, status, results), {
            title: 'Search', className: 'search-sheet',
            onClose: () => this.view.clearSearch(),
        })
        setTimeout(() => input.focus(), 300)
    }

    showSettings() {
        this.toggleChrome(false)
        openAppearance(this.s, {
            isFixed: this.isFixed,
            onChange: () => { this.applyAll(); this.updateStatus() },
            onBrightness: () => this.applyTheme(),
            onKeepAwake: on => on ? this.wake() : this.lock?.release?.(),
        })
    }

    // ------------------------------------------------------------------ teardown
    async close(silent = false) {
        if (this.closed) return
        this.closed = true
        clearInterval(this.clock)
        document.removeEventListener('keydown', this.keyHandler)
        document.removeEventListener('visibilitychange', this.visHandler)
        this.mq?.removeEventListener('change', this.mqHandler)
        this.lock?.release?.().catch?.(() => {})
        if (this.speed) db.set('kv', 'speed', this.speed)
        this.pushNow()
        try { this.view.close?.() } catch {}
        this.view.book?.destroy?.()
        this.el.classList.add('closing')
        document.body.classList.remove('reading')
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff')
        setTimeout(() => this.el.remove(), 200)
        if (active === this) active = null
        if (!silent) this.onClose?.()
    }
}

// Send a book's local position to Kavita (or leave it queued if offline).
export async function pushProgress(book) {
    const rec = lib.state.local[book.id]
    if (!rec || rec.synced) return
    try {
        await api.saveProgress({
            volumeId: book.volumeId, chapterId: book.id, pageNum: rec.pageNum,
            seriesId: book.seriesId, libraryId: book.libraryId, bookScrollId: null,
        })
        book.pagesRead = rec.pageNum
        book.lastRead = Date.now()
        await lib.setLocal(book.id, { ...rec, synced: true })
        dispatchEvent(new Event('folio:library'))
    } catch (e) {
        if (!(e instanceof OfflineError)) console.warn('progress sync failed', e)
    }
}

// Push anything that was read offline
export async function flushQueue() {
    for (const [id, rec] of Object.entries(lib.state.local))
        if (!rec.synced) {
            const b = lib.state.byId.get(+id)
            if (b) await pushProgress(b)
        }
}
