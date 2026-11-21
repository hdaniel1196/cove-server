// Settings → "Jellyfin (this server)": each person's own Jellyfin settings, the ones Jellyfin's apps use
// every change re-reads the latest settings first and changes only that one field.
import * as api from './api.js'
import { h, icon, toast } from './ui.js'

async function patch(fields) {
    const me = await api.request('/Users/Me')
    await api.request('/Users/Configuration', { method: 'POST', query: { userId: api.userId() }, body: { ...me.Configuration, ...fields } })
}
const sw = (cfg, key, label, note) => {
    const t = h('button.ios-sw' + (cfg[key] ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!cfg[key]), 'aria-label': label, onclick: async () => {
        cfg[key] = !cfg[key]; t.classList.toggle('on', cfg[key]); t.setAttribute('aria-checked', String(cfg[key]))
        try { await patch({ [key]: cfg[key] }) } catch (e) { toast('Couldn’t save: ' + e.message) }
    } })
    return h('div.ss-row', h('div', h('div', label), note ? h('div.muted.small', note) : null), t)
}
const pick = (cfg, key, label, opts, note) => {
    const s = h('select.srv-select', { 'aria-label': label, onchange: async () => {
        cfg[key] = s.value || (key === 'SubtitleLanguagePreference' ? '' : s.value)
        try { await patch({ [key]: cfg[key] }) } catch (e) { toast('Couldn’t save: ' + e.message) }
    } }, opts.map(([v, l]) => h('option', { value: v, selected: String(cfg[key] ?? '') === v }, l)))
    return h('div.ss-row', h('div', h('div', label), note ? h('div.muted.small', note) : null), s)
}
// a list of libraries with checkboxes (and optional ↑↓ order)
function libList(views, cfg, key, { invert = false, order = false } = {}) {
    const box = h('div.srv-rank')
    let ids = order ? [...(cfg.OrderedViews || []).filter(id => views.some(v => v.Id === id)), ...views.map(v => v.Id).filter(id => !(cfg.OrderedViews || []).includes(id))] : views.map(v => v.Id)
    const draw = () => box.replaceChildren(...ids.map((id, i) => {
        const v = views.find(x => x.Id === id)
        const on = invert ? !(cfg[key] || []).includes(id) : (cfg[key] || []).includes(id)
        return h('div.srv-rank-row',
            key ? h('button.srv-check' + (on ? '.on' : ''), { onclick: async () => {
                const set = new Set(cfg[key] || [])
                ;(invert ? on : !on) ? set.add(id) : set.delete(id)
                cfg[key] = [...set]; draw()
                try { await patch({ [key]: cfg[key] }) } catch (e) { toast('Couldn’t save: ' + e.message) }
            } }, h('span.srv-box', on ? icon('check') : null), v.Name) : h('span', v.Name),
            order ? h('span.srv-rank-btns',
                h('button.srv-arrow', { disabled: i === 0, 'aria-label': `Move ${v.Name} up`, onclick: async () => { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; draw(); await patch({ OrderedViews: ids }).catch(e => toast(e.message)) } }, '↑'),
                h('button.srv-arrow', { disabled: i === ids.length - 1, 'aria-label': `Move ${v.Name} down`, onclick: async () => { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; draw(); await patch({ OrderedViews: ids }).catch(e => toast(e.message)) } }, '↓')) : null)
    }))
    draw()
    return box
}

export function jellyfinUserGroup() {
    const g = h('div.ss-group.you-group', h('div.ss-row', h('div.muted.small', 'Loading…')))
    Promise.all([api.request('/Users/Me'), api.views()]).then(([me, views]) => {
        const c = me.Configuration
        const libs = views.filter(v => v.CollectionType !== 'playlists')
        g.replaceChildren(
            h('div.ss-row', h('div.muted.small', 'These are Jellyfin’s own settings for you. They change Jellyfin’s apps (and the TV at work); Cove follows its own settings above where they overlap.')),
            pick(c, 'SubtitleMode', 'Subtitles in Jellyfin’s apps', [['Default', 'Default (as the file says)'], ['Smart', 'Smart'], ['OnlyForced', 'Forced only'], ['Always', 'Always'], ['None', 'None']]),
            pick(c, 'SubtitleLanguagePreference', 'Subtitle language', [['', 'Any'], ['eng', 'English'], ['spa', 'Spanish'], ['jpn', 'Japanese'], ['zho', 'Chinese'], ['kor', 'Korean'], ['fre', 'French']]),
            sw(c, 'RememberAudioSelections', 'Remember my audio pick', 'Per show, for the next episodes'),
            sw(c, 'RememberSubtitleSelections', 'Remember my subtitle pick', 'Per show, for the next episodes'),
            sw(c, 'EnableNextEpisodeAutoPlay', 'Play the next episode on its own', 'In Jellyfin’s apps'),
            sw(c, 'DisplayMissingEpisodes', 'Show missing episodes', 'Episodes that aired but aren’t in the library'),
            sw(c, 'DisplayCollectionsView', 'Show a Collections library', null),
            sw(c, 'HidePlayedInLatest', 'Hide watched in “Latest”', null),
            h('div.ss-row.srv-col', h('div', h('div', 'Library order'), h('div.muted.small', 'In Jellyfin’s apps (Cove’s tabs follow Jellyfin’s order too)')), libList(libs, c, null, { order: true })),
            h('div.ss-row.srv-col', h('div', h('div', 'Show in “Latest”'), h('div.muted.small', 'Untick a library to keep it out of the Latest rows')), libList(libs, c, 'LatestItemsExcludes', { invert: true })),
            h('div.ss-row.srv-col', h('div', h('div', 'Show in “My Media”'), null), libList(libs, c, 'MyMediaExcludes', { invert: true })))
    }).catch(e => g.replaceChildren(h('div.ss-row', h('div.muted.small', e.message))))
    return g
}

// profile picture: Jellyfin keeps it on the account, so every app shows it
export function pictureRow() {
    const row = h('div.list-row')
    const draw = () => {
        const src = api.userImg()
        const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
            const f = file.files[0]; if (!f) return
            try {
                const b64 = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(f) })
                await api.request(`/Users/${api.userId()}/Images/Primary`, { method: 'POST', rawBody: b64, contentType: f.type || 'image/jpeg' })
                await api.refreshPicture(); toast('Picture saved'); draw()
            } catch (e) { toast('Couldn’t save the picture: ' + e.message) }
        } })
        row.replaceChildren(
            h('div.you-pic', src ? h('img', { src, alt: '' }) : (api.me()?.name || '?')[0]),
            h('div', { style: { flex: '1' } }, h('div', 'Profile picture'), h('div.muted.small', 'Shows on the sign-in screen, Switch Account, and in Jellyfin’s apps')),
            h('button.pill.glass.small', { onclick: () => file.click() }, src ? 'Change' : 'Add'),
            src ? h('button.pill.glass.small', { onclick: async () => {
                try { await api.request(`/Users/${api.userId()}/Images/Primary`, { method: 'DELETE' }); await api.refreshPicture(); toast('Picture removed'); draw() } catch (e) { toast(e.message) }
            } }, 'Remove') : '', file)
    }
    draw()
    return row
}
