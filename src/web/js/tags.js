// editor (saves to Jellyfin + Emby through cove-api), a page per tag, library filters, and episode tags with
// "Hide <tag>" switches on show pages.
import * as api from './api.js'
import { h, icon, toast, sheet, epNum, epTitle, runtime } from './ui.js'

let allTagsCache = null
export async function allTags(parentId) {
    if (!parentId && allTagsCache) return allTagsCache
    const d = await api.request('/Items/Filters', { query: { userId: api.userId(), parentId } }).catch(() => ({}))
    const tags = (d.Tags || []).sort((a, b) => a.localeCompare(b))
    if (!parentId) allTagsCache = tags
    return tags
}
export const tagHref = t => `#/tag/${encodeURIComponent(t)}`

// chips under the details; admins get "+ Tag"
export function tagChips(it, after) {
    const tags = it.Tags || []
    const chips = tags.map(t => h('a.chip.tag', { href: tagHref(t) }, '#' + t))
    if (api.isAdmin()) chips.push(h('button.chip.tag-add', { onclick: () => tagEditor([it.Id], tags, after), 'aria-label': 'Edit tags' }, icon('plus'), tags.length ? ' Edit tags' : ' Add a tag'))
    return chips.length ? h('div.chips.tags', chips) : null
}

// editor for one item or many (episodes picked on a show page)
export function tagEditor(ids, current = [], after) {
    const have = [...current]
    const list = h('div.chips')
    const input = h('input.text-input', { placeholder: 'Tag name, like Christmas or Filler', maxlength: 40, autocomplete: 'off', list: 'cove-tag-list' })
    const sugg = h('datalist#cove-tag-list')
    const many = ids.length > 1
    const save = async (add, remove) => {
        try {
            await api.helper('/tags', { ids, add, remove })
            allTagsCache = null
            if (add.length) add.forEach(t => { if (!have.some(x => x.toLowerCase() === t.toLowerCase())) have.push(t) })
            if (remove.length) remove.forEach(t => { const i = have.findIndex(x => x.toLowerCase() === t.toLowerCase()); if (i >= 0) have.splice(i, 1) })
            draw(); toast(many ? `Saved on ${ids.length} items` : 'Saved'); after?.()
        } catch (e) { toast('Couldn’t save: ' + e.message) }
    }
    const draw = () => list.replaceChildren(...(have.length ? have.map(t => h('span.chip.tag.on', '#' + t,
        h('button.chip-x', { 'aria-label': `Remove ${t}`, onclick: () => save([], [t]) }, icon('close')))) : [h('span.muted.small', many ? 'Add a tag to all of them, or remove one from all of them.' : 'No tags yet.')]))
    const add = () => { const t = input.value.trim(); if (!t) return; input.value = ''; save([t], []) }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add() } })
    allTags().then(ts => sugg.replaceChildren(...ts.map(t => h('option', { value: t }))))
    const quick = h('div.chips.quick')
    allTags().then(ts => quick.replaceChildren(...ts.filter(t => !have.some(x => x.toLowerCase() === t.toLowerCase())).slice(0, 20)
        .map(t => h('button.chip', { onclick: () => save([t], []) }, '+ ' + t))))
    draw()
    sheet([h('div.form-pad', list, h('div.tag-row', input, h('button.pill.white', { onclick: add }, 'Add')), sugg,
        h('div.menu-label', 'Your tags'), quick,
        h('p.muted.small', 'Tags save to Jellyfin and Emby, so Emby’s Kids accounts keep matching.'))],
        { title: many ? `Tags for ${ids.length} items` : 'Tags', className: 'menu' })
    setTimeout(() => input.focus(), 80)
}

// one tag: everything that has it
export async function tagPage(main, tag, poster, wide) {
    tag = decodeURIComponent(tag)
    main.replaceChildren(h('div.loading-page', h('div.spinner')))
    const d = await api.items({ tags: tag, includeItemTypes: 'Movie,Series,Episode', sortBy: 'SortName', limit: 2000, fields: 'Tags' })
    const by = t => d.Items.filter(i => i.Type === t)
    const sec = (title, items, card) => items.length ? h('section.shelf', h('div.shelf-head', h('h2', `${title} (${items.length})`)), h('div.grid' + (card === wide ? '.wide-grid' : ''), items.map(card))) : null
    main.replaceChildren(...[
        h('header.page-head', h('h1', '#' + tag)),
        h('p.muted.page-sub', `${d.Items.length} tagged`),
        sec('Shows', by('Series'), poster), sec('Movies', by('Movie'), poster), sec('Episodes', by('Episode'), it => wide(it)),
        d.Items.length ? null : h('div.empty', 'Nothing has this tag yet.')].filter(Boolean))
}

// library: tag filter chips (only tags used in that library)
export async function libraryTagRow(libId, selected, onPick) {
    const tags = await allTags(libId)
    if (!tags.length) return null
    return h('div.chips.lib-tags', tags.map(t => h('button.chip.tag' + (selected === t ? '.on' : ''), { onclick: () => onPick(selected === t ? null : t) }, '#' + t)))
}

// show page: which episode tags exist in this season, and "Hide <tag>" switches (remembered per show)
export function episodeTagBar(seriesId, eps, onChange) {
    const tags = [...new Set(eps.flatMap(e => e.Tags || []))].sort()
    if (!tags.length) return null
    const key = 'cove.hide.' + seriesId
    let hidden = new Set(JSON.parse(localStorage.getItem(key) || '[]'))
    const bar = h('div.chips.ep-tags')
    const draw = () => bar.replaceChildren(...tags.map(t => h('button.chip' + (hidden.has(t) ? '.on' : ''), { onclick: () => {
        hidden.has(t) ? hidden.delete(t) : hidden.add(t)
        try { localStorage.setItem(key, JSON.stringify([...hidden])) } catch {}
        draw(); onChange(hidden)
    } }, (hidden.has(t) ? 'Hiding ' : 'Hide ') + t)))
    draw()
    return { el: bar, hidden: () => hidden }
}
export const hiddenFor = seriesId => new Set(JSON.parse(localStorage.getItem('cove.hide.' + seriesId) || '[]'))
