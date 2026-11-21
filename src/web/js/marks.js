// good! i like the new logo."). One family: a single 1.75 line on a 24 grid, each part with its own color on a dark tile.
// The part's internal key stays "reel" for movies and shows (saved settings and the apps use it); its name is Cinema.
const svg = (stroke, body) => `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const MARKS = {
    cove: { color: '#5fd4e8', tile: '#11141c', body: '<path d="M18.4 6.2A8.5 8.5 0 1 0 18.4 17.8"/><path d="M8.2 13.2c1.2-1 2.4-1 3.6 0s2.4 1 3.6 0"/>' },
    reel: { color: '#5fd4e8', tile: '#0f2026', body: '<rect x="3.5" y="5" width="17" height="12" rx="2.5"/><path d="M10.5 8.8v4.4l3.6-2.2z"/><path d="M8.5 20h7"/>' },
    folio: { color: '#ff9a5c', tile: '#2a1810', body: '<path d="M12 7.5c-2-1.6-4.8-2-8-1.5v12c3.2-.5 6 0 8 1.5"/><path d="M12 7.5c2-1.6 4.8-2 8-1.5v12c-3.2-.5-6 0-8 1.5"/><path d="M12 7.5v12"/>' },
    vinyl: { color: '#b59cff', tile: '#1c1430', body: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M12 6.5a5.5 5.5 0 0 1 5.5 5.5"/>' },
    requests: { color: '#e5b454', tile: '#2a2010', body: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M12 8.5v5M9.5 11h5"/>' },
}
export const PART_NAMES = { reel: 'Cinema', folio: 'Folio', vinyl: 'Vinyl', requests: 'Requests' }

// the bare line mark (color can be overridden, e.g. gray for "off")
export const markSvg = (key, color) => svg(color || MARKS[key].color, MARKS[key].body)
// the mark on its rounded tile, as an HTML string; size in px
export function markTile(key, size = 34, { off = false } = {}) {
    const m = MARKS[key]
    const pad = Math.round(size * 0.22)
    return `<span class="cove-tile" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;background:${off ? '#1a1e28' : m.tile};padding:${pad}px">${markSvg(key, off ? '#7a8296' : null)}</span>`
}
