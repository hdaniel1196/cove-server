// open a little dropdown for whichever of the two you have"). Cove = the whole app; its parts are Cinema (movies & shows; internal key "reel"),
// Folio (books, served at /books/) and later Vinyl (music). Plain DOM + its own styles, so Folio (inside Cove) imports
// this same file from /js/switcher.js. With only one part, it's just the label (no dropdown).

import { markTile } from './marks.js'
const FILM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/></svg>'
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9.5 6 6 6-6"/></svg>'
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'

export const PARTS = {
    reel: { name: 'Cinema', what: 'Movies & shows', href: '/#/home', icon: markTile('reel', 34) },
    folio: { name: 'Folio', what: 'Books', href: '/#/books', icon: markTile('folio', 34) },
}

const CSS = `
.cove-switch { position: relative; display: inline-flex; font-family: inherit; }
.cs-btn { display: inline-flex; align-items: center; gap: 9px; padding: 5px 12px 5px 5px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
    background: rgba(24,32,51,.72); -webkit-backdrop-filter: blur(20px) saturate(160%); backdrop-filter: blur(20px) saturate(160%);
    color: #f5f5f7; font: inherit; cursor: pointer; transition: background .16s ease, transform .15s ease-out; -webkit-tap-highlight-color: transparent; }
.cs-btn:hover { background: rgba(40,50,72,.8); }
.cs-btn:active { transform: scale(.97); }
.cs-btn:focus-visible, .cs-item:focus-visible { outline: 2px solid #5fd4e8; outline-offset: 2px; }
.cs-mark { width: 28px; height: 28px; border-radius: 8px; display: block; }
.cove-tile { flex: none; display: grid; place-items: center; box-sizing: border-box; }
.cove-tile svg { width: 100%; height: 100%; display: block; }
.cs-words { display: flex; align-items: baseline; gap: 6px; line-height: 1; }
.cs-cove { font-size: 13px; font-weight: 600; color: rgba(235,235,245,.55); letter-spacing: -.01em; }
.cs-part { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.cs-down { width: 15px; height: 15px; color: rgba(235,235,245,.6); transition: transform .2s cubic-bezier(.22,1,.36,1); }
.cs-down svg, .cs-check svg, .cs-reel svg { width: 100%; height: 100%; display: block; }
.cove-switch.open .cs-down { transform: rotate(180deg); }
.cove-switch.solo .cs-btn { cursor: default; padding-right: 14px; }
.cs-menu { position: absolute; top: calc(100% + 8px); left: 0; z-index: 60; min-width: 240px; padding: 6px; border-radius: 16px;
    background: rgba(20,27,44,.94); -webkit-backdrop-filter: blur(24px) saturate(160%); backdrop-filter: blur(24px) saturate(160%);
    border: 1px solid rgba(255,255,255,.12); box-shadow: 0 2px 6px rgba(0,0,0,.5), 0 18px 44px rgba(0,0,0,.55);
    transform-origin: top left; opacity: 0; transform: scale(.96) translateY(-4px); pointer-events: none;
    transition: opacity .15s ease-out, transform .18s cubic-bezier(.22,1,.36,1); }
.cove-switch.open .cs-menu { opacity: 1; transform: none; pointer-events: auto; }
.cs-label { padding: 8px 10px 6px; font-size: 12px; font-weight: 600; color: rgba(235,235,245,.45); }
.cs-item { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 11px; color: #f5f5f7; text-decoration: none; transition: background .12s ease; }
.cs-item:hover { background: rgba(255,255,255,.08); }
.cs-item:active { background: rgba(255,255,255,.12); }
.cs-glyph { width: 34px; height: 34px; border-radius: 9px; flex: none; display: grid; place-items: center; }
.cs-reel { background: linear-gradient(160deg, #1d3c55, #0f2233); color: #5fd4e8; padding: 7px; box-sizing: border-box; }
.cs-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.cs-text b { font-size: 15px; font-weight: 600; }
.cs-text small { font-size: 12.5px; color: rgba(235,235,245,.55); }
.cs-check { width: 18px; height: 18px; color: #5fd4e8; }
@media (prefers-reduced-motion: reduce) { .cs-menu, .cs-down, .cs-btn { transition: none; } }
`

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }

// current: 'reel' | 'folio'; parts: the ones this person has, e.g. ['reel', 'folio']
export function coveSwitcher(current, parts) {
    if (!document.getElementById('cove-switch-css')) {
        const s = el('style'); s.id = 'cove-switch-css'; s.textContent = CSS; document.head.append(s)
    }
    const solo = parts.length < 2
    const root = el('div', 'cove-switch' + (solo ? ' solo' : ''))
    const btn = el('button', 'cs-btn')
    btn.type = 'button'
    btn.innerHTML = `<img class="cs-mark" src="/icons/icon-192.png" alt=""><span class="cs-words"><span class="cs-cove">Cove</span><span class="cs-part">${PARTS[current].name}</span></span>`
    btn.setAttribute('aria-label', `Cove, ${PARTS[current].name}` + (solo ? '' : '. Switch to another part of Cove'))
    root.append(btn)
    if (solo) { btn.disabled = true; return root }
    btn.append(el('span', 'cs-down', DOWN))
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false')
    const menu = el('div', 'cs-menu'); menu.setAttribute('role', 'menu')
    menu.append(el('div', 'cs-label', 'Cove'))
    for (const k of parts) {
        const p = PARTS[k]
        const a = el('a', 'cs-item', `${p.icon}<span class="cs-text"><b>${p.name}</b><small>${p.what}</small></span>${k === current ? `<span class="cs-check">${CHECK}</span>` : ''}`)
        a.href = p.href; a.setAttribute('role', 'menuitem')
        if (k === current) { a.setAttribute('aria-current', 'page'); a.addEventListener('click', e => { e.preventDefault(); close() }) }
        menu.append(a)
    }
    root.append(menu)
    const onDoc = e => { if (!root.contains(e.target)) close() }
    const onKey = e => { if (e.key === 'Escape') { close(); btn.focus() } }
    function open() { root.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey) }
    function close() { root.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey) }
    btn.addEventListener('click', () => root.classList.contains('open') ? close() : open())
    addEventListener('hashchange', close)
    return root
}
