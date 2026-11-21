// Settings → Subtitle Style: presets, then every knob, with a live preview over a real backdrop from the library.
import * as api from './api.js'
import { h, icon, toast } from './ui.js'
import * as subs from './subs.js'

const SAMPLES = [
    'I didn’t think you’d actually come back.\n<i>Neither did I.</i>',
    '[thunder rumbling]\nMARCUS: We need to go. Now.',
    '- Is that everything you packed?\n- Everything that matters.',
    '♪ Under the bright lights ♪\n(sighs) Okay. One more time.',
]
const COLORS = ['#ffffff', '#f2f2f2', '#ffe873', '#ffd400', '#9be7ff', '#7dffb0', '#ff9db5', '#000000']
const DARKS = ['#000000', '#1c1c1e', '#0b1d3a', '#3a0b0b', '#ffffff']

export async function subsStylePage(main) {
    let s = { ...(await subs.refresh()) }
    let sample = 0, bright = false
    let backdrop = null
    try {
        const d = await api.request('/Items', { query: { userId: api.userId(), recursive: true, includeItemTypes: 'Movie,Series', sortBy: 'Random', limit: 6, imageTypes: 'Backdrop', fields: 'BackdropImageTags' } })
        backdrop = (d.Items || []).map(x => api.img(x, 'Backdrop', { w: 1280 })).filter(Boolean)
    } catch {}
    let bdIndex = 0

    // ---------------------------------------------------------------- preview
    const pvCues = h('div.cues.on', h('div.cues-in'))
    const preview = h('div.ss-preview', pvCues)
    const drawBg = () => {
        preview.style.backgroundImage = bright ? 'linear-gradient(160deg, #f4efe6, #d9e4ef 60%, #fafafa)' : backdrop?.length ? `url("${backdrop[bdIndex % backdrop.length]}")` : 'linear-gradient(160deg, #23304a, #0b0d14)'
    }
    const drawCue = () => { pvCues.firstChild.innerHTML = subs.cueHtml(SAMPLES[sample % SAMPLES.length], s); subs.apply(pvCues, s) }
    preview.append(h('div.ss-preview-bar',
        h('button.pill.glass.small', { onclick: () => { sample++; drawCue() } }, 'Next line'),
        h('button.pill.glass.small', { onclick: e => { bright = !bright; e.currentTarget.textContent = bright ? 'Dark scene' : 'Bright scene'; drawBg() } }, 'Bright scene'),
        backdrop?.length > 1 ? h('button.pill.glass.small', { onclick: () => { bdIndex++; bright = false; drawBg() }, 'aria-label': 'Another picture' }, icon('shuffle')) : null))

    // ---------------------------------------------------------------- change + redraw
    const parts = []          // functions that refresh a control from s
    const set = (patch, redraw = true) => {
        s = { ...s, ...patch }
        subs.save(s)
        drawCue()
        if (redraw) parts.forEach(f => f())
    }

    // ---------------------------------------------------------------- controls
    const presetRow = h('div.ss-presets')
    const drawPresets = () => {
        const on = subs.presetOf(s)
        presetRow.replaceChildren(...subs.PRESETS.map(([id, label, p]) => {
            const look = { ...subs.DEFAULT, ...p }
            const c = h('div.cues.on', h('div.cues-in', { html: subs.cueHtml('Hello there', look) }))
            subs.apply(c, look)
            return h('button.ss-preset' + (on === id ? '.on' : ''), { onclick: () => set({ ...subs.DEFAULT, ...p, hideSdh: s.hideSdh, hideSpeakers: s.hideSpeakers, italics: s.italics, liftWithControls: s.liftWithControls }) },
                h('div.ss-preset-art', { style: backdrop?.length ? { backgroundImage: `url("${backdrop[(subs.PRESETS.findIndex(x => x[0] === id)) % backdrop.length]}")` } : {} }, c),
                h('span.l', label))
        }), ...(on === 'custom' ? [h('div.ss-preset.on', h('div.ss-preset-art'), h('span.l', 'Custom'))] : []))
    }
    parts.push(drawPresets)

    const range = (label, key, min, max, step, fmt) => {
        const o = h('output'), i = h('input', { type: 'range', min, max, step, 'aria-label': label,
            oninput: () => { set({ [key]: +i.value }, false); o.textContent = fmt(+i.value); drawPresets() } })
        const sync = () => { i.value = s[key]; o.textContent = fmt(s[key]) }
        parts.push(sync); sync()
        return h('div.ss-row', h('span.ss-lab', label), h('div.ss-range', i, o))
    }
    const seg = (label, key, opts) => {
        const box = h('div.ss-seg')
        const sync = () => box.replaceChildren(...opts.map(([v, l]) => h('button' + (s[key] === v ? '.on' : ''), { onclick: () => set({ [key]: v }) }, l)))
        parts.push(sync); sync()
        return h('div.ss-row', h('span.ss-lab', label), box)
    }
    const colors = (label, key, list) => {
        const box = h('div.ss-swatches')
        const sync = () => {
            const custom = h('input', { type: 'color', value: s[key], 'aria-label': label + ' custom color', oninput: e => set({ [key]: e.target.value }, false), onchange: () => parts.forEach(f => f()) })
            box.replaceChildren(...list.map(c => h('button.ss-sw' + (s[key] === c ? '.on' : ''), { style: { background: c }, 'aria-label': c, onclick: () => set({ [key]: c }) })),
                h('span.ss-sw.custom' + (list.includes(s[key]) ? '' : '.on'), { title: 'Any color' }, custom))
        }
        parts.push(sync); sync()
        return h('div.ss-row', h('span.ss-lab', label), box)
    }
    const toggle = (label, key, note) => {
        const t = h('button.ios-sw', { role: 'switch', 'aria-label': label, onclick: () => set({ [key]: !s[key] }) })
        const sync = () => { t.classList.toggle('on', !!s[key]); t.setAttribute('aria-checked', String(!!s[key])) }
        parts.push(sync); sync()
        return h('div.ss-row', h('div', h('div', label), note ? h('div.muted.small', note) : null), t)
    }
    const fonts = h('div.ss-fonts')
    const drawFonts = () => fonts.replaceChildren(...subs.FONTS.map(([id, label, fam]) => {
        subs.loadFont(id)
        return h('button.ss-font' + (s.font === id ? '.on' : ''), { style: { fontFamily: fam, fontWeight: s.weight }, onclick: () => set({ font: id }) }, 'Aa Bb 123', h('small', label))
    }))
    parts.push(drawFonts)

    const pct = v => v + '%'
    const mode = api.subsMode()
    const modeSeg = h('div.ss-seg', [['smart', 'Smart'], ['always', 'Always'], ['off', 'Off']].map(([v, l]) =>
        h('button' + (mode === v ? '.on' : ''), { onclick: e => { api.setSubsMode(v); [...e.currentTarget.parentNode.children].forEach(b => b.classList.toggle('on', b === e.currentTarget)) } }, l)))

    main.replaceChildren(h('div.ss-wrap',
        h('header.page-head', h('a.pill.glass.small.srv-back', { href: '#/settings' }, icon('back'), ' Settings'), h('h1', 'Subtitle Style')),
        preview,
        h('div.group-label', 'Looks'), presetRow,
        h('div.group-label', 'When subtitles show'),
        h('div.ss-group', h('div.ss-row', h('div', h('div', 'Turn on'), h('div.muted.small', 'Smart: foreign-language parts only, full English when the audio isn’t English')), modeSeg)),
        h('div.group-label', 'Font'),
        h('div.ss-group', fonts,
            range('Size', 'size', 50, 250, 5, pct),
            seg('Weight', 'weight', [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy']]),
            toggle('All caps', 'caps'),
            range('Letter spacing', 'spacing', -5, 20, 1, v => (v / 100).toFixed(2) + 'em'),
            range('Line spacing', 'lineHeight', 100, 180, 5, pct)),
        h('div.group-label', 'Text color'),
        h('div.ss-group', colors('Color', 'color', COLORS), range('Opacity', 'opacity', 30, 100, 5, pct)),
        h('div.group-label', 'Edge'),
        h('div.ss-group',
            seg('Style', 'edge', [['none', 'None'], ['outline', 'Outline'], ['shadow', 'Shadow'], ['raised', 'Raised'], ['depressed', 'Depressed'], ['glow', 'Glow']]),
            colors('Color', 'edgeColor', DARKS),
            range('Thickness', 'edgeSize', 30, 250, 10, pct)),
        h('div.group-label', 'Background'),
        h('div.ss-group',
            colors('Behind the words', 'bg', DARKS), range('Opacity', 'bgOpacity', 0, 100, 5, pct),
            colors('Behind the whole block', 'window', DARKS), range('Opacity', 'windowOpacity', 0, 100, 5, pct),
            range('Corner roundness', 'radius', 0, 20, 1, v => v + 'px')),
        h('div.group-label', 'Position'),
        h('div.ss-group',
            range('Height from bottom', 'bottom', 0, 40, 1, pct),
            range('Width', 'maxWidth', 40, 100, 5, pct),
            seg('Line up', 'align', [['center', 'Center'], ['left', 'Left']]),
            toggle('Move up when the controls show', 'liftWithControls', 'So the words never sit under the play bar')),
        h('div.group-label', 'Text'),
        h('div.ss-group',
            toggle('Hide sound notes', 'hideSdh', 'Drops [music], (sighs) and the like from hearing-impaired subtitles'),
            toggle('Hide speaker names', 'hideSpeakers', 'Drops “MARCUS:” at the start of a line'),
            toggle('Keep italics', 'italics', 'Italics usually mean a voice off screen or on a phone')),
        h('div.ss-group', { style: { marginTop: '22px' } },
            h('button.list-row', { onclick: () => { set({ ...subs.DEFAULT }); toast('Back to the Cove look') } }, h('div', 'Reset to Cove look'), icon('restart'))),
        h('p.muted.small.lt-foot', 'Saved to your account, so it follows you to every device and the Apple app. Timing can be nudged while watching: Subtitles → Size, height and timing.')))
    drawBg(); drawCue(); parts.forEach(f => f())
}
