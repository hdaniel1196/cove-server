// Edit Images (admins), laid out like Emby's: an Images grid with one card per slot, then Backdrops.
// Search pulls candidates from Jellyfin's image providers; + uploads your own; the trash removes one.
// Changes go through Emby (cove-api), which writes the file next to the media, so Emby and Jellyfin match.
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'

const SLOTS = [
    ['Primary', 'poster'], ['Logo', 'logo'], ['Thumb', 'wide'],
    ['Banner', 'banner'], ['Disc', 'disc'], ['Art', 'art'],
]
const searchIcon = () => icon('search')
const addIcon = () => icon('plus')
const trashIcon = () => icon('trash')

export async function imagesPage(main, id) {
    if (!api.isAdmin()) return main.replaceChildren(h('div.empty', 'Only admins can edit pictures.'))
    main.replaceChildren(h('div.loading-page', h('div.spinner')))
    let item, imgs, providers
    try {
        [item, imgs, providers] = await Promise.all([api.item(id), api.itemImages(id), api.remoteProviders(id).catch(() => [])])
    } catch (e) { return main.replaceChildren(h('div.empty', 'Couldn’t load the pictures: ' + e.message)) }
    const searchable = new Set(providers.flatMap(p => p.SupportedImages || []))
    const byType = t => imgs.filter(i => i.ImageType === t)
    const refresh = () => imagesPage(main, id)
    const readOnly = i => (i.Path || '').startsWith('/media/')
    // Jellyfin re-reads the folder after Emby writes the file; give it a moment before redrawing
    const later = fn => setTimeout(fn, 2500)

    function card(type, shape, info, index) {
        const has = !!info
        const art = h('div.ie-art.' + shape,
            has ? h('img', { src: api.imageUrl(id, type, index, shape === 'poster' ? 400 : 700), alt: type, loading: 'lazy' }) : h('span.ie-empty', type))
        const busy = h('div.ie-busy', h('div.spinner'))
        const el = h('div.ie-card', art, busy,
            h('div.ie-name', type === 'Backdrop' ? `Backdrop ${index + 1}` : type),
            h('div.ie-size', has && info.Width ? `${info.Width}×${info.Height}` : ' '))
        el.append(h('div.ie-actions',
                searchable.has(type) ? h('button.ie-btn', { 'aria-label': `Search for a ${type} picture`, title: 'Search online', onclick: () => pick(type) }, searchIcon()) : null,
                has ? removeBtn(type, index, info, el) : h('button.ie-btn', { 'aria-label': `Upload a ${type} picture`, title: 'Upload', onclick: () => upload(type, el) }, addIcon()),
                has ? h('button.ie-btn', { 'aria-label': `Replace with an upload`, title: 'Upload a replacement', onclick: () => upload(type, el) }, addIcon()) : null))
        return el
    }
    function removeBtn(type, index, info, el) {
        let armed = false, t
        const b = h('button.ie-btn', { 'aria-label': `Remove the ${type} picture`, title: 'Remove' }, trashIcon())
        b.onclick = async () => {
            if (!armed) { armed = true; b.classList.add('armed'); toast('Tap the trash again to remove it'); t = setTimeout(() => { armed = false; b.classList.remove('armed') }, 3000); return }
            clearTimeout(t)
            el.classList.add('working')
            try {
                const r = await api.helper('/image', { itemId: id, type, index: index ?? 0, delete: true })
                if (!r.emby) {
                    if (readOnly(info)) throw new Error('it lives next to the file and Emby doesn’t know this item')
                    await api.deleteImage(id, type, type === 'Backdrop' ? index : null)
                }
                toast(r.emby ? 'Removed in Emby and Jellyfin' : 'Removed'); later(refresh)
            }
            catch (e) { el.classList.remove('working'); toast('Couldn’t remove it: ' + e.message) }
        }
        return b
    }
    function upload(type, el) {
        const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' })
        input.onchange = async () => {
            const f = input.files?.[0]
            if (!f) return
            el?.classList.add('working')
            try {
                const r = await api.helper('/image', { itemId: id, type, data: await api.fileToBase64(f), contentType: f.type || 'image/jpeg' })
                if (!r.emby) await api.uploadImage(id, type, f)
                toast(r.emby ? 'Saved for Emby and Jellyfin' : 'Picture saved'); later(refresh)
            }
            catch (e) { el?.classList.remove('working'); toast('Upload failed: ' + e.message) }
        }
        input.click()
    }
    async function pick(type) {
        let all = false
        const grid = h('div.ie-results', h('div.loading-page', h('div.spinner')))
        const langBtn = h('button.toggle', { onclick: () => { all = !all; langBtn.classList.toggle('on', all); load() } }, 'All languages')
        const s = sheet([h('div.ie-results-bar', langBtn), grid], { title: `Find a ${type} picture`, className: 'menu', wide: true })
        async function load() {
            grid.replaceChildren(h('div.loading-page', h('div.spinner')))
            try {
                const d = await api.remoteImages(id, type, all)
                if (!d.Images?.length) return grid.replaceChildren(h('div.empty', 'Nothing found for this one.'))
                const shape = SLOTS.find(x => x[0] === type)?.[1] || 'wide'
                grid.replaceChildren(...d.Images.map(r => h('button.ie-result', {
                    onclick: async e => {
                        const b = e.currentTarget
                        b.classList.add('working')
                        try {
                            const x = await api.helper('/image', { itemId: id, type, url: r.Url, provider: r.ProviderName })
                            if (!x.emby) await api.downloadImage(id, type, r.Url)
                            toast(x.emby ? 'Saved for Emby and Jellyfin' : 'Picture saved'); s.close(); later(refresh)
                        }
                        catch (x) { b.classList.remove('working'); toast('Couldn’t save it: ' + x.message) }
                    } },
                    h('div.ie-art.' + (type === 'Backdrop' ? 'wide' : shape), h('img', { src: r.ThumbnailUrl || r.Url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })),
                    h('div.ie-meta',
                        h('span', r.ProviderName),
                        h('span.muted', [r.Width && `${r.Width}×${r.Height}`, r.Language && r.Language.toUpperCase(), r.CommunityRating ? `★ ${r.CommunityRating.toFixed(1)}` : null].filter(Boolean).join(' · '))))))
            } catch (e) { grid.replaceChildren(h('div.empty', 'Search failed: ' + e.message)) }
        }
        load()
    }

    const backdrops = byType('Backdrop').sort((a, b) => (a.ImageIndex ?? 0) - (b.ImageIndex ?? 0))
    main.replaceChildren(
        h('header.ie-head',
            h('a.icon-btn', { href: `#/item/${id}`, 'aria-label': 'Back' }, icon('back')),
            h('div', h('h1', 'Edit Images'), h('div.muted', item.Name))),
        h('section.ie-section',
            h('h2', 'Images'),
            h('div.ie-grid', SLOTS.map(([type, shape]) => card(type, shape, byType(type)[0], null)))),
        h('section.ie-section',
            h('div.ie-sec-head', h('h2', 'Backdrops'),
                searchable.has('Backdrop') ? h('button.ie-btn', { 'aria-label': 'Search for a backdrop', onclick: () => pick('Backdrop') }, searchIcon()) : null,
                h('button.ie-btn', { 'aria-label': 'Upload a backdrop', onclick: () => upload('Backdrop') }, addIcon())),
            backdrops.length
                ? h('div.ie-grid', backdrops.map(b => card('Backdrop', 'wide', b, b.ImageIndex ?? 0)))
                : h('p.muted', 'No backdrops yet.')),
        h('p.muted.small.ie-note', 'Pictures are saved through Emby next to the media file, so Emby and Jellyfin show the same art.'))
}
