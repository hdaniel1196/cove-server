// The <track> loads the cues (mode "hidden"); this file paints them in an overlay with the person's style, and switches
// back to the browser's own drawing only where an overlay can't show (iPhone native fullscreen, picture in picture).
// The style is saved per person in Jellyfin display prefs (client "cove", id "cove-subs", CustomPrefs.style = JSON),
// so the Apple app can read the same thing. A copy is kept on the device for a fast start.
import * as api from './api.js'
import * as store from './prefs.js'

export const FONTS = [
    // [id, label, css family, Google Fonts family to load or null]
    ['geist', 'Geist', '"Geist", system-ui, sans-serif', null],
    ['system', 'System', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', null],
    ['atkinson', 'Atkinson Hyperlegible', '"Atkinson Hyperlegible", sans-serif', 'Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700'],
    ['inter', 'Inter', '"Inter", sans-serif', 'Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,600'],
    ['roboto', 'Roboto', '"Roboto", sans-serif', 'Roboto:ital,wght@0,400;0,500;0,700;0,900;1,400;1,700'],
    ['rounded', 'Rounded', '"Nunito", ui-rounded, sans-serif', 'Nunito:ital,wght@0,400;0,600;0,700;0,800;1,400;1,700'],
    ['condensed', 'Condensed', '"Roboto Condensed", sans-serif', 'Roboto+Condensed:ital,wght@0,400;0,500;0,700;1,400;1,700'],
    ['serif', 'Serif', '"Source Serif 4", Georgia, serif', 'Source+Serif+4:ital,wght@0,400;0,600;0,700;1,400;1,600'],
    ['typewriter', 'Typewriter', '"Courier Prime", "Courier New", monospace', 'Courier+Prime:ital,wght@0,400;0,700;1,400;1,700'],
    ['mono', 'Mono', '"Geist Mono", ui-monospace, monospace', null],
    ['casual', 'Casual', '"Comic Neue", "Comic Sans MS", cursive', 'Comic+Neue:ital,wght@0,400;0,700;1,400;1,700'],
    ['smallcaps', 'Small caps', '"Alegreya Sans SC", sans-serif', 'Alegreya+Sans+SC:ital,wght@0,400;0,500;0,700;1,400'],
]

export const DEFAULT = {
    font: 'geist', size: 100, weight: 600, color: '#ffffff', opacity: 100,
    edge: 'shadow', edgeColor: '#000000', edgeSize: 100,
    bg: '#000000', bgOpacity: 0, window: '#000000', windowOpacity: 0, radius: 6,
    bottom: 8, align: 'center', lineHeight: 125, spacing: 0, maxWidth: 80, liftWithControls: true,
    hideSdh: false, hideSpeakers: false, italics: true, caps: false,
}
export const PRESETS = [
    ['cove', 'Cove', {}],
    ['classic', 'Classic', { font: 'system', weight: 700, edge: 'outline', edgeSize: 110 }],
    ['cinema', 'Cinema', { font: 'serif', weight: 600, color: '#ffe873', edge: 'shadow', edgeSize: 120 }],
    ['boxed', 'Boxed', { font: 'inter', weight: 500, edge: 'none', bgOpacity: 75, radius: 4 }],
    ['streaming', 'Streaming', { font: 'roboto', weight: 500, edge: 'shadow', edgeSize: 140, size: 95 }],
    ['easy', 'Easy to read', { font: 'atkinson', weight: 700, size: 125, edge: 'outline', edgeSize: 130, bgOpacity: 35 }],
    ['soft', 'Soft', { font: 'rounded', weight: 700, color: '#f2f2f2', opacity: 92, edge: 'glow', edgeSize: 90 }],
    ['retro', 'Retro TV', { font: 'typewriter', weight: 700, edge: 'none', bgOpacity: 100, radius: 0, caps: true, size: 90 }],
]

// ------------------------------------------------------------------ load / save
const localKey = () => 'cove.substyle.' + (api.userId() || '')
let current = null
export function style() {
    if (current) return current
    try { current = { ...DEFAULT, ...(JSON.parse(localStorage.getItem(localKey())) || {}) } } catch { current = { ...DEFAULT } }
    return current
}
export async function refresh() {
    try {
        const p = await store.get('subs')
        if (p.style) { current = { ...DEFAULT, ...JSON.parse(p.style) }; try { localStorage.setItem(localKey(), JSON.stringify(current)) } catch {} }
    } catch {}
    return style()
}
let saveTimer
export function save(next) {
    current = { ...DEFAULT, ...next }
    try { localStorage.setItem(localKey(), JSON.stringify(current)) } catch {}
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => store.update('subs', c => { c.style = JSON.stringify(current) }).catch(() => {}), 600)
    for (const fn of listeners) fn(current)
}
const listeners = new Set()
export const onChange = fn => (listeners.add(fn), () => listeners.delete(fn))
export const presetOf = s => PRESETS.find(([, , p]) => Object.entries({ ...DEFAULT, ...p }).every(([k, v]) => s[k] === v))?.[0] || 'custom'

// ------------------------------------------------------------------ looks
const loaded = new Set()
export function loadFont(id) {
    const f = FONTS.find(x => x[0] === id)
    if (!f?.[3] || loaded.has(id)) return
    loaded.add(id)
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${f[3]}&display=swap` }))
}
export const family = id => (FONTS.find(x => x[0] === id) || FONTS[0])[2]
export function rgba(hex, pct) {
    const n = parseInt((hex || '#000000').slice(1), 16)
    return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${Math.max(0, Math.min(100, pct)) / 100})`
}
function edgeCss(s) {
    const c = s.edgeColor, k = s.edgeSize / 100
    switch (s.edge) {
        case 'outline': return { stroke: `${(0.09 * k).toFixed(3)}em ${c}`, shadow: `0 0 ${(0.04 * k).toFixed(3)}em ${rgba(c, 60)}` }
        case 'shadow': return { shadow: `${(0.04 * k).toFixed(3)}em ${(0.05 * k).toFixed(3)}em ${(0.12 * k).toFixed(3)}em ${rgba(c, 90)}, 0 0 ${(0.25 * k).toFixed(3)}em ${rgba(c, 45)}` }
        case 'raised': return { shadow: `${(0.035 * k).toFixed(3)}em ${(0.035 * k).toFixed(3)}em 0 ${c}, ${(0.06 * k).toFixed(3)}em ${(0.06 * k).toFixed(3)}em 0 ${rgba(c, 60)}` }
        case 'depressed': return { shadow: `${(-0.035 * k).toFixed(3)}em ${(-0.035 * k).toFixed(3)}em 0 ${c}, ${(0.03 * k).toFixed(3)}em ${(0.03 * k).toFixed(3)}em 0 ${rgba('#ffffff', 35)}` }
        case 'glow': return { shadow: `0 0 ${(0.12 * k).toFixed(3)}em ${c}, 0 0 ${(0.28 * k).toFixed(3)}em ${rgba(c, 80)}` }
        default: return { shadow: 'none' }
    }
}
// CSS variables on the overlay element; app.css .cues uses them
export function apply(el, s = style()) {
    loadFont(s.font)
    const e = edgeCss(s)
    const set = (k, v) => el.style.setProperty(k, v)
    set('--sub-font', family(s.font)); set('--sub-scale', s.size / 100); set('--sub-weight', s.weight)
    set('--sub-color', rgba(s.color, s.opacity)); set('--sub-shadow', e.shadow || 'none'); set('--sub-stroke', e.stroke || '0 transparent')
    set('--sub-bg', rgba(s.bg, s.bgOpacity)); set('--sub-window', rgba(s.window, s.windowOpacity)); set('--sub-radius', s.radius + 'px')
    set('--sub-bottom', s.bottom + '%'); set('--sub-align', s.align); set('--sub-lh', s.lineHeight / 100)
    set('--sub-spacing', (s.spacing / 100) + 'em'); set('--sub-maxw', s.maxWidth + '%'); set('--sub-caps', s.caps ? 'uppercase' : 'none')
    el.classList.toggle('lift', !!s.liftWithControls)
    el.classList.toggle('has-bg', s.bgOpacity > 0)
    el.classList.toggle('left', s.align === 'left')
}
// for the browser's own drawing (native fullscreen, PiP): ::cue takes color, background, font and shadow only
function cueSheet(s) {
    let tag = document.getElementById('cove-cue-style')
    if (!tag) { tag = document.createElement('style'); tag.id = 'cove-cue-style'; document.head.append(tag) }
    const e = edgeCss(s)
    tag.textContent = `.player video::cue { font-family: ${family(s.font)}; font-weight: ${s.weight}; color: ${rgba(s.color, s.opacity)};
        background: ${s.bgOpacity ? rgba(s.bg, s.bgOpacity) : 'transparent'}; text-shadow: ${e.shadow && e.shadow !== 'none' ? e.shadow : e.stroke ? `0 0 .08em ${s.edgeColor}, 0 0 .08em ${s.edgeColor}` : 'none'}; }`
}

// ------------------------------------------------------------------ text cleanup
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export function cueHtml(text, s = style()) {
    let t = text.replace(/\r/g, '')
    if (s.hideSdh) t = t.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/^\s*[♪#]+\s*$/gm, '')
    if (s.hideSpeakers) t = t.replace(/^(\s*-?\s*)(<i>)?[A-Z][A-Z0-9 .'&-]{1,30}:\s*/gm, '$1$2')
    let lines = t.split('\n').map(l => l.trim()).filter(l => l && !/^-$/.test(l.replace(/<[^>]+>/g, '').trim()) && l.replace(/<[^>]+>/g, '').trim())
    return lines.map(l => {
        let x = esc(l).replace(/&lt;(\/?)(i|b|u)&gt;/g, s.italics ? '<$1$2>' : (m, sl, tg) => tg === 'i' ? '' : `<${sl}${tg}>`).replace(/&lt;[^&]*?&gt;/g, '')
        return `<span class="cl">${x}</span>`
    }).join('<br>')
}

// ------------------------------------------------------------------ the renderer
export function renderer(video, root) {
    const box = h('div.cues'), inner = h('div.cues-in')
    box.append(inner)
    root.append(box)
    let track = null, delay = 0, last = '', raf = 0, native = false
    const s = () => style()
    apply(box); cueSheet(s())
    const off = onChange(st => { apply(box, st); cueSheet(st); last = ''; })
    function frame() {
        raf = requestAnimationFrame(frame)
        if (!track || native || !track.cues) { if (last) { inner.innerHTML = ''; last = '' } return }
        const t = video.currentTime - delay
        let html = '', top = false
        for (const c of track.cues) {
            if (c.startTime > t) break
            if (c.endTime > t) {
                const part = cueHtml(c.text)
                if (part) html += (html ? '<br>' : '') + part
                if (typeof c.line === 'number' && !c.snapToLines && c.line < 40) top = true
            }
        }
        if (html !== last) { inner.innerHTML = html; last = html; box.classList.toggle('top', top); box.classList.toggle('on', !!html) }
    }
    raf = requestAnimationFrame(frame)
    const useNative = on => {
        native = on
        if (track) track.mode = on ? 'showing' : 'hidden'
    }
    const pipOn = () => useNative(true), pipOff = () => useNative(false)
    video.addEventListener('enterpictureinpicture', pipOn); video.addEventListener('leavepictureinpicture', pipOff)
    video.addEventListener('webkitbeginfullscreen', pipOn); video.addEventListener('webkitendfullscreen', pipOff)
    video.addEventListener('webkitpresentationmodechanged', () => useNative(video.webkitPresentationMode !== 'inline'))
    return {
        setTrack(t) {
            for (const x of video.textTracks) if (x !== t) x.mode = 'disabled'
            track = t
            if (t) t.mode = native ? 'showing' : 'hidden'
            last = ''
        },
        get delay() { return delay },
        set delay(v) { delay = Math.round(v * 10) / 10; last = '' },
        destroy() { cancelAnimationFrame(raf); off(); box.remove() },
    }
}
function h(tag) { const [n, ...cls] = tag.split('.'); const e = document.createElement(n); e.className = cls.join(' '); return e }
