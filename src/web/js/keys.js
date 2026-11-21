// Keyboard shortcuts (Nov 20, 2026): press ? anywhere for this list. The player handles its own keys (player.js).
import { h, sheet } from './ui.js'

export const PLAYER_KEYS = [
    ['Space or K', 'Play / pause'], ['← / →', 'Back / forward 10 seconds'], ['J / L', 'Back / forward 30 seconds'],
    ['↑ / ↓', 'Volume up / down'], ['M', 'Mute'], ['C', 'Subtitles on / off'], ['S', 'Skip intro, recap or credits'],
    ['N', 'Next episode'], ['F', 'Full screen'], ['P', 'Picture in picture'], ['< / >', 'Slower / faster'], ['Esc', 'Close the player'],
]
export const APP_KEYS = [['/', 'Search'], ['G then H', 'Home'], ['G then L', 'Live TV'], ['G then S', 'Settings'], ['?', 'This list']]

export function keysSheet() {
    if (document.querySelector('.keys-sheet')) return
    const table = rows => h('div.keys-list', rows.map(([k, what]) => h('div.keys-row', h('span.keys-k', k.split(' ').map(p => /^(or|then|\/)$/.test(p) ? h('span.muted', ` ${p} `) : h('kbd', p))), h('span', what))))
    sheet([h('div.form-pad', h('div.menu-label', 'Watching'), table(PLAYER_KEYS), h('div.menu-label', 'Anywhere'), table(APP_KEYS))], { title: 'Keyboard shortcuts', className: 'menu.keys-sheet' })
}

// app-wide keys (not while typing, not while the player is open: it has its own)
let g = 0
addEventListener('keydown', e => {
    const t = e.target
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable) return
    if (e.key === '?') { e.preventDefault(); return keysSheet() }
    if (document.body.classList.contains('playing') || document.querySelector('.sheet-wrap')) return
    if (e.key === '/') { e.preventDefault(); location.hash = '#/search'; return }
    if (e.key === 'g') { g = Date.now(); return }
    if (Date.now() - g < 1200) {
        const to = { h: '#/home', l: '#/livetv', s: '#/settings' }[e.key]
        if (to) { e.preventDefault(); location.hash = to }
        g = 0
    }
})
