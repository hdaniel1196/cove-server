// Small DOM helpers, icons, sheets and toasts.

// h('div.card#x', { onclick, style: {...}, dataset: {...} }, ...children)
export function h(tag, props, ...children) {
    if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
        if (props != null) children.unshift(props)
        props = {}
    }
    const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i)
    const el = document.createElement(name || 'div')
    for (const part of rest.match(/[.#][^.#]+/g) ?? [])
        part[0] === '.' ? el.classList.add(part.slice(1)) : (el.id = part.slice(1))
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
        else if (k === 'style' && typeof v === 'object')
            for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val)
        else if (k === 'dataset') Object.assign(el.dataset, v)
        else if (k === 'html') el.innerHTML = v
        else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ')
        else if (k in el && typeof v !== 'string') el[k] = v
        else el.setAttribute(k, v === true ? '' : v)
    }
    append(el, children)
    return el
}
function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue
        el.append(c instanceof Node ? c : document.createTextNode(String(c)))
    }
}

const svg = (body, vb = '0 0 24 24') =>
    `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const solid = (body, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="currentColor" aria-hidden="true">${body}</svg>`
export const icons = {
    home: svg('<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>'),
    book: svg('<path d="M5 4h3v16H5zM10 4h3v16h-3z"/><path d="m15.5 4.6 2.9-.8 3.6 15.4-2.9.8z"/>'),
    film: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>'),
    antenna: svg('<path d="M12 13v8M8.5 21h7"/><circle cx="12" cy="11" r="1.6"/><path d="M8.3 7.3a5.2 5.2 0 0 0 0 7.4M15.7 7.3a5.2 5.2 0 0 1 0 7.4M5.5 4.5a9.2 9.2 0 0 0 0 13M18.5 4.5a9.2 9.2 0 0 1 0 13"/>'),
    tv: svg('<rect x="3" y="5.5" width="18" height="12" rx="2"/><path d="M8.5 21h7M9 2.5l3 3 3-3"/>'),
    heart: svg('<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
    back: svg('<path d="M15 5 8 12l7 7"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    chevron: svg('<path d="m9 5 7 7-7 7"/>'),
    play: solid('<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/>'),
    pause: solid('<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>'),
    back10: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">10</text>'),
    fwd10: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">10</text>'),
    cc: svg('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.5 10.3a2.2 2.2 0 1 0 0 3.4M17 10.3a2.2 2.2 0 1 0 0 3.4"/>'),
    audio: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    pip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor"/>'),
    next: solid('<path d="M5 5.5v13a1 1 0 0 0 1.6.8l8.6-6.5a1 1 0 0 0 0-1.6L6.6 4.7A1 1 0 0 0 5 5.5z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
    stack: svg('<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M6.5 6h11M9 3h6"/>'),
    restart: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
    shuffle: svg('<path d="M16 4h4v4M20 4l-6.5 6.5M4 20l6-6M16 20h4v-4M14.5 14.5 20 20M4 4l5 5"/>'),
    dice: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/>'),
    trailer: svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor"/>'),
    flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    trash: svg('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>'),
    image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-5-5-8.5 8.5"/>'),
    out: svg('<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l4-4-4-4M14 12H4"/>'),
}
export const icon = (name, cls = '') => h('span.icon' + (cls ? '.' + cls : ''), { html: icons[name] ?? '' })

// Bottom sheet (phones) / centered card (wide screens). Returns { el, close }.
export function sheet(content, { className = '', onClose, title, wide = false } = {}) {
    const backdrop = h('div.sheet-backdrop')
    const panel = h('div.sheet' + (className ? '.' + className : '') + (wide ? '.wide' : ''),
        h('div.sheet-grabber'),
        title ? h('div.sheet-head', h('h3', title), h('button.icon-btn', { onclick: () => close(), 'aria-label': 'Close' }, icon('close'))) : null,
        h('div.sheet-body', content))
    const wrap = h('div.sheet-wrap', backdrop, panel)
    let closed = false
    function close() {
        if (closed) return
        closed = true
        document.removeEventListener('keydown', onKey, true)
        wrap.classList.remove('open')
        wrap.classList.add('closing')
        setTimeout(() => wrap.remove(), 280)
        onClose?.()
    }
    backdrop.addEventListener('click', close)
    function onKey(e) {
        if (e.key === 'Escape' && wrap === [...document.querySelectorAll('.sheet-wrap:not(.closing)')].pop()) {
            e.stopImmediatePropagation(); e.preventDefault(); close()
        }
    }
    document.addEventListener('keydown', onKey, true)
    // drag the grabber/head down to dismiss
    let startY = null, dy = 0
    panel.addEventListener('touchstart', e => {
        if (!e.target.closest('.sheet-grabber, .sheet-head')) return
        startY = e.touches[0].clientY
        panel.style.transition = 'none'
    }, { passive: true })
    panel.addEventListener('touchmove', e => {
        if (startY == null) return
        dy = Math.max(0, e.touches[0].clientY - startY)
        panel.style.transform = `translateY(${dy}px)`
    }, { passive: true })
    panel.addEventListener('touchend', () => {
        if (startY == null) return
        panel.style.transition = ''
        panel.style.transform = ''
        if (dy > 90) close()
        startY = null; dy = 0
    })
    document.body.append(wrap)
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')))
    return { el: panel, close }
}

let toastTimer
export function toast(msg, ms = 2600) {
    let t = document.querySelector('.toast')
    if (!t) { t = h('div.toast', { role: 'status', 'aria-live': 'polite' }); document.body.append(t) }
    t.textContent = msg
    t.classList.remove('action')
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), ms)
}

// a toast with one button (e.g. Undo); stays up longer
export function toastAction(msg, label, fn, ms = 10000) {
    let t = document.querySelector('.toast')
    if (!t) { t = h('div.toast', { role: 'status', 'aria-live': 'polite' }); document.body.append(t) }
    const b = h('button.toast-btn', { onclick: () => { clearTimeout(toastTimer); t.classList.remove('show'); fn() } }, label)
    t.replaceChildren(h('span', msg), b)
    t.classList.add('show', 'action')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show', 'action'), ms)
}

export function runtime(ticks) {
    if (!ticks) return ''
    const m = Math.round(ticks / 6e8)
    if (m < 60) return `${m}m`
    return `${Math.floor(m / 60)}h ${m % 60}m`
}
export function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0))
    const hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0')
}
// "S1 E5", or "E6" when the season is unknown (files named "Show - E006 - Title"), or '' when nothing is known
export function epNum(ep) {
    let e = ep.IndexNumber, sn = ep.ParentIndexNumber
    if (e == null) { const m = /(?:^|[\s._-])(?:S(\d+))?E(\d{1,4})(?:[\s._-]|$)/i.exec(ep.Name || ''); if (m) { e = +m[2]; if (m[1]) sn = +m[1] } }
    if (e == null) return ''
    return sn != null ? `S${sn} E${e}` : `E${e}`
}
// episode title without a "Show - E006 - " prefix Jellyfin keeps when it couldn't read the file name
export function epTitle(ep) {
    return (ep.Name || '').replace(/^.*?\s-\s(?:S\d+)?E\d{1,4}\s-\s/i, '') || ep.Name || ''
}
