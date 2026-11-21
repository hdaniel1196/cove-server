// Reader appearance: themes, fonts, layout. Saved per device in localStorage (key folio.reader).

export const THEMES = {
    white:    { name: 'White',    bg: '#ffffff', fg: '#1b1b1b', link: '#2a63c9', dark: false },
    paper:    { name: 'Paper',    bg: '#f7f3ea', fg: '#2a2723', link: '#7a4b12', dark: false },
    sepia:    { name: 'Sepia',    bg: '#f1e5c9', fg: '#4d3a28', link: '#8a4b16', dark: false },
    calm:     { name: 'Calm',     bg: '#e9e2d0', fg: '#3b3328', link: '#6b4a1f', dark: false },
    gray:     { name: 'Gray',     bg: '#545457', fg: '#ececec', link: '#bcd2ff', dark: true },
    dusk:     { name: 'Dusk',     bg: '#18202b', fg: '#c3ccd8', link: '#8fb3ff', dark: true },
    dark:     { name: 'Dark',     bg: '#1c1c1e', fg: '#d6d6d6', link: '#8fb3ff', dark: true },
    black:    { name: 'Black',    bg: '#000000', fg: '#b4b4b4', link: '#7f9fe0', dark: true },
}

export const FONTS = [
    ['original', 'Original', null],
    ['iowan', 'Iowan', "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif"],
    ['charter', 'Charter', "Charter, 'Bitstream Charter', 'Sitka Text', Georgia, serif"],
    ['newyork', 'New York', "ui-serif, 'New York', Georgia, serif"],
    ['palatino', 'Palatino', "Palatino, 'Palatino Linotype', 'Book Antiqua', serif"],
    ['georgia', 'Georgia', "Georgia, serif"],
    ['athelas', 'Athelas', "Athelas, 'Iowan Old Style', Georgia, serif"],
    ['baskerville', 'Baskerville', "Baskerville, 'Baskerville Old Face', 'Libre Baskerville', serif"],
    ['sf', 'San Francisco', "-apple-system, system-ui, 'Segoe UI', sans-serif"],
    ['rounded', 'Rounded', "ui-rounded, 'SF Pro Rounded', -apple-system, system-ui, sans-serif"],
    ['avenir', 'Avenir Next', "'Avenir Next', Avenir, 'Segoe UI', sans-serif"],
    ['seravek', 'Seravek', "Seravek, 'Gill Sans', 'Gill Sans MT', sans-serif"],
]

export const FULL_WIDTH = 1450
export const DEFAULTS = {
    theme: 'paper',
    darkTheme: 'dark',      // used when "match system" is on and the device is in dark mode
    matchSystem: true,
    font: 'iowan',
    fontSize: 19,           // px
    weight: 400,
    lineHeight: 1.5,
    paraSpacing: 0,         // em between paragraphs
    indent: 'book',         // 'book' | 'none' | 'em'
    justify: true,
    hyphenate: true,
    margins: 5,             // side margin, % of the screen width on each side
    maxWidth: FULL_WIDTH,   // px per column; FULL_WIDTH = no cap, the margins setting alone decides
    columns: 'auto',        // 'auto' (2 in landscape) | '1'
    flow: 'paginated',      // 'paginated' | 'scrolled'
    animated: true,
    tapZones: 'sides',      // 'sides' (left=back, right=forward) | 'forward' (both forward) | 'off'
    brightness: 1,
    keepAwake: true,
    status: { chapter: true, chapterTime: true, chapterPages: false, bookPercent: true, bookTime: false, clock: false },
    comicZoom: 'fit-page',
    v: 2,
}

const KEY = 'folio.reader'
export function loadSettings() {
    let s = {}
    try { s = JSON.parse(localStorage.getItem(KEY)) ?? {} } catch {}
    // v2 (Oct 12): the old 700px column cap left huge side margins on iPad; untouched old default -> full width
    // (margins chosen under the old cap were a workaround for it, so they go back to the default too)
    if (!s.v) { if (s.maxWidth === 700 || s.maxWidth == null) { s.maxWidth = FULL_WIDTH; delete s.margins } s.v = 2; saveSettings(s) }
    return { ...DEFAULTS, ...s, status: { ...DEFAULTS.status, ...(s.status ?? {}) } }
}
export function saveSettings(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {}
    if (inCove() && !isStub(s)) { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushToCove(s), 800) }
}

const inCove = () => location.pathname.startsWith('/books')
// a device that never changed anything only has what the v2 migration wrote ({maxWidth, v}); that must never become
const isStub = s => !s || Object.keys(s).every(k => k === 'maxWidth' || k === 'v' || k === 'margins')
let pushTimer
async function coveAuth() {
    try { return (await import('/js/api.js')).authHeaderValue() } catch { return null }
}
async function pushToCove(s) {
    const auth = await coveAuth(); if (!auth) return
    try {   // read first, change only our key (rule from Cove: never write back a stale copy)
        const cur = await fetch('/cove-api/prefs?store=books', { headers: { Authorization: auth } }).then(r => r.json())
        await fetch('/cove-api/prefs?store=books', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefs: { ...(cur.prefs || {}), reader: JSON.stringify(s) } }) })
    } catch {}
}
// at start: take the person's saved settings, or (first time) send this device's
export async function syncSettings() {
    if (!inCove()) return
    const auth = await coveAuth(); if (!auth) return
    try {
        const r = await fetch('/cove-api/prefs?store=books', { headers: { Authorization: auth } }).then(x => x.json())
        if (r.found && r.prefs?.reader) { try { localStorage.setItem(KEY, r.prefs.reader) } catch {} }
        else { const local = JSON.parse(localStorage.getItem(KEY) || 'null'); if (local && !isStub(local)) await pushToCove(local) }
    } catch {}
}

export function activeTheme(s) {
    const dark = s.matchSystem && matchMedia('(prefers-color-scheme: dark)').matches
    const key = dark ? s.darkTheme : s.theme
    return { key, ...(THEMES[key] ?? THEMES.paper) }
}

// CSS injected into every book page (inside foliate's iframe)
export function bookCSS(s) {
    const t = activeTheme(s)
    const family = FONTS.find(f => f[0] === s.font)?.[2]
    const indent = s.indent === 'none' ? 'text-indent: 0 !important;' : s.indent === 'em' ? 'text-indent: 1.4em !important;' : ''
    return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: ${t.dark ? 'dark' : 'light'};
        background: ${t.bg} !important;
        color: ${t.fg} !important;
        font-size: ${s.fontSize}px !important;
        -webkit-text-size-adjust: none;
        text-size-adjust: none;
        touch-action: pan-x pan-y !important;   /* no zoom: fast page-turn taps aren't a double-tap zoom, no pinch */
    }
    body {
        background: transparent !important;
        color: inherit !important;
        ${family ? `font-family: ${family} !important;` : ''}
        ${s.weight !== 400 ? `font-weight: ${s.weight} !important;` : ''}
        -webkit-font-smoothing: antialiased;
    }
    body * { color: inherit !important; background-color: transparent !important; border-color: currentColor; }
    ${family ? `body p, body li, body blockquote, body dd, body div, body span:not([class*="drop"]) { font-family: inherit !important; }` : ''}
    p, li, blockquote, dd {
        line-height: ${s.lineHeight} !important;
        text-align: ${s.justify ? 'justify' : 'start'};
        -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
        hyphens: ${s.hyphenate ? 'auto' : 'manual'};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2; orphans: 2;
    }
    p { ${s.paraSpacing ? `margin-top: 0 !important; margin-bottom: ${s.paraSpacing}em !important;` : ''} ${indent} }
    [align="left"] { text-align: left; } [align="right"] { text-align: right; }
    [align="center"] { text-align: center; } [align="justify"] { text-align: justify; }
    .center, .right { text-indent: 0 !important; }
    a, a * { color: ${t.link} !important; text-decoration: none; }
    pre { white-space: pre-wrap !important; }
    img, svg { ${t.dark ? 'opacity: .9;' : ''} }
    ::selection { background: ${t.dark ? 'rgba(120,160,255,.35)' : 'rgba(255,200,60,.45)'}; }
    aside[epub|type~="endnote"], aside[epub|type~="footnote"],
    aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
    `
}
