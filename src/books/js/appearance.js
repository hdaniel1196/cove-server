// The "Aa" Appearance panel, used from the reader and from Settings. A live sample page at the top shows
// theme, font, size, spacing, margins, indent and justification as they change.
import { h, icon, sheet } from './ui.js'
import { THEMES, FONTS, FULL_WIDTH, saveSettings, activeTheme, bookCSS } from './reader-settings.js'

// Public-domain sample (Pride and Prejudice, 1813)
const SAMPLE = `
<h2>Chapter One</h2>
<p class="first">It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.</p>
<p>However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.</p>
<p>“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”</p>
<p>Mr. Bennet replied that he had not.</p>
<p>“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”</p>
<p>Mr. Bennet made no answer.</p>
<p>“Do you not want to know who has taken it?” cried his wife impatiently.</p>
<p>“<i>You</i> want to tell me, and I have no objection to hearing it.”</p>
<p>This was invitation enough.</p>`

function preview(s) {
    const frame = h('iframe.aa-preview-frame', { title: 'Sample page', tabindex: '-1', 'aria-hidden': 'true' })
    const update = () => {
        const doc = frame.contentDocument
        if (!doc?.getElementById('folio-style')) return
        const t = activeTheme(s)
        doc.getElementById('folio-style').textContent = bookCSS(s) + `
            html { height: 100%; overflow: hidden; padding: 14px ${s.margins}% 0 !important; box-sizing: border-box; }
            body { margin: 0; }
            h2 { text-align: center; font-size: 1.3em; margin: .2em 0 .8em; font-weight: 600; }
            p { margin: 0; text-indent: 1.4em; } p.first { text-indent: 0; }`
        frame.style.background = t.bg
    }
    frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style id="folio-style"></style></head><body>${SAMPLE}</body></html>`
    frame.addEventListener('load', update)
    return { el: h('div.aa-preview', frame, h('div.aa-preview-fade')), update }
}

/**
 * s: the settings object (edited in place and saved)
 * onChange(): re-apply to an open book; onBrightness(): live brightness; onKeepAwake(on)
 * isFixed: comics (fewer options, no text preview)
 */
export function openAppearance(s, { onChange = () => {}, onBrightness = () => {}, onKeepAwake = () => {}, isFixed = false } = {}) {
    const save = () => { saveSettings(s); onChange(); pv?.update() }
    const set = (k, v) => { s[k] = v; save(); refresh() }
    const pv = isFixed ? null : preview(s)
    const controls = h('div.aa-controls')
    const refresh = () => controls.replaceChildren(...build())
    const seg = (k, opts) => h('div.seg', opts.map(([v, label]) =>
        h('button', { class: String(s[k]) === String(v) ? 'on' : '', onclick: () => set(k, v) }, label)))
    const stepper = (k, step, min, max, fmt) => h('div.stepper',
        h('button', { onclick: () => set(k, +Math.max(min, s[k] - step).toFixed(2)), 'aria-label': 'Less' }, '−'),
        h('span', fmt(s[k])),
        h('button', { onclick: () => set(k, +Math.min(max, s[k] + step).toFixed(2)), 'aria-label': 'More' }, '+'))
    const toggle = (label, get, put) => h('label.row.toggle', h('span', label),
        h('input', { type: 'checkbox', checked: get(), onchange: e => { put(e.target.checked); save() } }))
    const row = (label, ctl) => h('div.row', h('span', label), ctl)
    const build = () => {
        const themeKey = activeTheme(s).key
        return [
            h('div.themes', Object.entries(THEMES).map(([k, t]) => h('button.theme-swatch', {
                class: themeKey === k ? 'on' : '',
                style: { background: t.bg, color: t.fg },
                onclick: () => {
                    const dark = s.matchSystem && matchMedia('(prefers-color-scheme: dark)').matches
                    dark ? set('darkTheme', k) : set('theme', k)
                },
            }, h('span.aa-glyph', 'Aa'), h('span.theme-name', t.name)))),
            toggle('Match system light/dark', () => s.matchSystem, v => { s.matchSystem = v; refresh() }),
            row(h('span.with-icon', icon('sun'), 'Brightness'), h('input.range', {
                type: 'range', min: 0.3, max: 1, step: 0.01, value: s.brightness,
                oninput: e => { s.brightness = +e.target.value; onBrightness() },
                onchange: () => saveSettings(s),
            })),
            ...(isFixed ? [
                row('Zoom', seg('comicZoom', [['fit-page', 'Fit page'], ['fit-width', 'Fit width']])),
                toggle('Keep screen on', () => s.keepAwake, v => { s.keepAwake = v; onKeepAwake(v) }),
                toggle('Tap sides to turn pages', () => s.tapZones !== 'off', v => s.tapZones = v ? 'sides' : 'off'),
            ] : [
                h('div.section-label', 'Font'),
                h('div.fonts', FONTS.map(([k, label, fam]) => h('button.font-chip', {
                    class: s.font === k ? 'on' : '', style: { fontFamily: fam ?? 'inherit' }, onclick: () => set('font', k),
                }, label))),
                row('Size', stepper('fontSize', 1, 12, 40, v => `${v}`)),
                row('Weight', seg('weight', [[400, 'Regular'], [500, 'Medium'], [600, 'Bold']])),
                h('div.section-label', 'Layout'),
                row('Line spacing', stepper('lineHeight', 0.05, 1.1, 2.4, v => v.toFixed(2))),
                row('Margins', stepper('margins', 1, 1, 15, v => `${v}%`)),
                row('Paragraph spacing', stepper('paraSpacing', 0.25, 0, 2, v => v ? v.toFixed(2) : 'Book')),
                row('Indent', seg('indent', [['book', 'Book'], ['em', 'Indent'], ['none', 'None']])),
                row('Column width', stepper('maxWidth', 50, 450, FULL_WIDTH, v => v >= FULL_WIDTH ? 'Full' : `${v}`)),
                row('Two columns in landscape', h('input', { type: 'checkbox', checked: s.columns !== '1',
                    onchange: e => { s.columns = e.target.checked ? 'auto' : '1'; save() } })),
                toggle('Justify text', () => s.justify, v => s.justify = v),
                toggle('Hyphenation', () => s.hyphenate, v => s.hyphenate = v),
                h('div.section-label', 'Turning pages'),
                row('Mode', seg('flow', [['paginated', 'Pages'], ['scrolled', 'Scroll']])),
                row('Tap zones', seg('tapZones', [['sides', 'Left back'], ['forward', 'Both forward'], ['off', 'Off']])),
                toggle('Page-turn animation', () => s.animated, v => s.animated = v),
                toggle('Keep screen on', () => s.keepAwake, v => { s.keepAwake = v; onKeepAwake(v) }),
                h('div.section-label', 'Status line'),
                toggle('Chapter name', () => s.status.chapter, v => s.status.chapter = v),
                toggle('Time left in chapter', () => s.status.chapterTime, v => s.status.chapterTime = v),
                toggle('Page in chapter', () => s.status.chapterPages, v => s.status.chapterPages = v),
                toggle('Time left in book', () => s.status.bookTime, v => s.status.bookTime = v),
                toggle('Percent of book', () => s.status.bookPercent, v => s.status.bookPercent = v),
                toggle('Clock', () => s.status.clock, v => s.status.clock = v),
            ]),
        ]
    }
    refresh()
    return sheet(h('div.aa', pv?.el, controls), { title: 'Appearance', className: 'aa-sheet' })
}
