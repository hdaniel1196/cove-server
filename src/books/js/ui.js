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
export const icons = {
    home: svg('<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>'),
    library: svg('<path d="M5 4h3v16H5zM10 4h3v16h-3z"/><path d="m15.5 4.6 2.9-.8 3.6 15.4-2.9.8z"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    back: svg('<path d="M15 5 8 12l7 7"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/>'),
    aa: svg('<path d="M3 19 8 6l5 13M4.8 14.5h6.4"/><path d="M14.5 12.2a3 3 0 0 1 5.5 1.3V19m0-3.2c-.4 2-1.8 3.3-3.4 3.3-1.4 0-2.4-.8-2.4-2 0-1.5 1.5-2.2 5.8-2.3"/>'),
    cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4.3 4.3 0 0 1-.5 8.5z"/><path d="m12 11v5m-2.2-2.2L12 16l2.2-2.2"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    checkCircle: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.3 9.5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    bookmark: svg('<path d="M7 4h10v16l-5-3.5L7 20z"/>'),
    trash: svg('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>'),
    rows: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    sort: svg('<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>'),
    chevron: svg('<path d="m9 5 7 7-7 7"/>'),
    sync: svg('<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v3h3M4 13a8 8 0 0 0 14.6 4.5M20 20v-3h-3"/>'),
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
    if (!t) { t = h('div.toast'); document.body.append(t) }
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), ms)
}

export const pct = x => `${Math.round(x * 100)}%`
export function duration(hours) {
    if (!hours || hours <= 0) return ''
    const m = Math.round(hours * 60)
    if (m < 60) return `${m} min`
    const hh = Math.floor(m / 60), mm = m % 60
    return mm && hh < 10 ? `${hh} hr ${mm} min` : `${hh} hr`
}
export function stripHtml(html) {
    const d = document.createElement('div')
    d.innerHTML = html
    return d.textContent.trim()
}
// Sanitized summary paragraphs (Kavita summaries are HTML from the EPUB)
export function summaryNodes(html) {
    const text = (() => {
        const d = new DOMParser().parseFromString(html || '', 'text/html')
        return [...d.body.querySelectorAll('p')].map(p => p.textContent.trim()).filter(Boolean)
    })()
    const paras = text.length ? text : stripHtml(html || '').split(/\n{2,}/).filter(Boolean)
    return paras.map(t => h('p', t))
}
