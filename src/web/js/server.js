// would be useful to see who logged in from where with what device"). Emby's layout as reference, Cove's look.
// Tabs: Dashboard (server, now playing, alerts, activity) and Devices. More tabs (Users, Libraries, Live TV, ...)
// come next. Everything here is plain Jellyfin API through /jf with the signed-in admin's token.
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'
import { pairSheet } from './pair.js'
import { usersInto, peopleCall, peopleLevelSheet, levelLabel, drawServices } from './people.js'

const TABS = [['dashboard', 'Dashboard'], ['general', 'General'], ['users', 'Users'], ['requests', 'Requests'], ['libraries', 'Libraries'], ['devices', 'Devices'], ['livetv', 'Live TV'], ['playback', 'Playback'], ['transcoding', 'Transcoding'], ['plugins', 'Plugins'], ['tasks', 'Tasks'], ['activity', 'Activity'], ['logs', 'Logs'], ['backup', 'Backup'], ['network', 'Network']]
let timer = null

const ago = d => {
    const s = Math.max(0, (Date.now() - Date.parse(d)) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`
    const days = Math.floor(s / 86400)
    return days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : new Date(d).toLocaleDateString()
}
const when = d => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

let host = {}
export function serverPage(main, tab = 'dashboard', arg) {
    clearInterval(timer)
    if (!api.atLeast('admin')) return location.replace('#/settings')
    const body = h('div.srv-body')
    const on = tab === 'user' ? 'users' : tab === 'library' ? 'libraries' : tab
    main.replaceChildren(
        h('header.page-head', h('h1', 'Server')),
        h('div.seg-row', h('div.seg', TABS.map(([k, label]) => h('button', { class: k === on ? 'on' : '', onclick: () => location.hash = '#/server/' + k }, label)))),
        body)
    const pages = { dashboard, devices, users: usersInto, user: b => userPage(b, decodeURIComponent(arg || '')), libraries: librariesTab, livetv: liveTvTab, general: generalTab, requests: requestsTab, playback: playbackTab, activity: b => activityTab(b), library: b => libraryPage(b, arg),
        transcoding: transcodingTab, plugins: b => pluginsTab(b), tasks: tasksTab, logs: b => logsTab(b, arg), backup: backupTab, network: networkTab }
    // this server's own details first (addresses, notes, paths), then the page
    api.hostInfo().then(x => { host = x || {}; (pages[tab] || dashboard)(body) })
}
addEventListener('hashchange', () => { if (!location.hash.startsWith('#/server')) clearInterval(timer) })

// ------------------------------------------------------------------ dashboard
async function dashboard(body) {
    const server = h('div.srv-card'), now = h('div.srv-now'), alerts = h('div.group.srv-list'), activity = h('div.group.srv-list')
    body.replaceChildren(
        h('div.group-label', 'Server'), server,
        h('div.group-label', 'Watching now'), now,
        h('div.group-label', 'Alerts'), alerts,
        h('div.group-label', 'Activity'), activity)
    try {
        const info = await api.request('/System/Info')
        server.replaceChildren(
            h('div.srv-title', info.ServerName || 'Server', h('span.srv-ok', 'Running')),
            row('Jellyfin', info.Version + (info.HasUpdateAvailable ? ' (update available)' : '')),
            ...addrRows(host, false))
    } catch (e) { server.replaceChildren(h('p.muted', 'Can’t reach Jellyfin: ' + e.message)) }
    const refresh = async () => {
        try { drawNow(now, await api.request('/Sessions', { query: { activeWithinSeconds: 960 } })) } catch {}
        try { drawLog(alerts, activity, (await api.request('/System/ActivityLog/Entries', { query: { limit: 60 } })).Items || []) } catch {}
    }
    await refresh()
    timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 10_000)
}
const row = (k, v) => h('div.srv-row', h('span.muted', k), h('span', v))
const addrRows = (host, full) => [
    host.addresses?.local ? row('At home', host.addresses.local) : '',
    host.addresses?.public ? row(full ? 'Away (Cove)' : 'Away', host.addresses.public) : '',
    host.jellyfinApps ? row(full ? 'Jellyfin’s own apps' : 'Jellyfin apps', host.jellyfinApps + (full ? '' : ' (sign in with Quick Connect)')) : '',
    full && host.jellyfinDirect ? row('Jellyfin itself, home only', host.jellyfinDirect) : '']

function drawNow(box, sessions) {
    const playing = sessions.filter(s => s.NowPlayingItem)
    if (!playing.length) return box.replaceChildren(h('p.muted.srv-empty', 'Nobody’s watching right now.'))
    box.replaceChildren(...playing.map(s => {
        const it = s.NowPlayingItem, ps = s.PlayState || {}
        const pct = it.RunTimeTicks ? Math.min(100, (ps.PositionTicks || 0) / it.RunTimeTicks * 100) : 0
        const title = it.SeriesName ? `${it.SeriesName} · ${it.ParentIndexNumber != null ? `S${it.ParentIndexNumber} E${it.IndexNumber}` : it.Name}` : it.Name
        const tc = s.TranscodingInfo
        const how = ps.PlayMethod === 'Transcode' ? (tc && tc.IsVideoDirect ? 'Remux' : 'Converting on the 4090') : 'Direct play'
        const art = api.img(it, 'Primary', { w: 120 })
        return h('div.srv-play',
            art ? h('img.srv-poster', { src: art, alt: '', loading: 'lazy' }) : h('div.srv-poster'),
            h('div.srv-play-info',
                h('div.srv-play-title', title),
                h('div.muted.small', `${s.UserName} · ${s.DeviceName} · ${s.Client}`),
                h('div.muted.small', (ps.IsPaused ? 'Paused · ' : '') + how),
                h('div.srv-bar', h('span', { style: `width:${pct.toFixed(1)}%` }))))
    }))
}

function drawLog(alerts, activity, items) {
    const bad = items.filter(e => e.Severity && e.Severity !== 'Information' || /Failed|Locked/i.test(e.Type || ''))
    alerts.replaceChildren(...(bad.length ? bad.slice(0, 8).map(logRow) : [h('div.list-row', h('span.muted', 'No alerts. All quiet.'))]))
    activity.replaceChildren(...items.filter(e => !bad.includes(e)).slice(0, 25).map(logRow))
}
function logRow(e) {
    const ip = (e.ShortOverview || '').replace(/^IP address:\s*/, '')
    return h('div.list-row.srv-log',
        h('div', h('div', e.Name), h('div.muted.small', ago(e.Date) + (ip && !/^172\./.test(ip) ? ' · ' + ip : ''))),
        e.Severity && e.Severity !== 'Information' ? icon('flag') : null)
}

// ------------------------------------------------------------------ devices
async function devices(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let list = []
    try { list = (await api.request('/Devices')).Items || [] } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const mine = localStorage.getItem('cove.device')
    list.sort((a, b) => Date.parse(b.DateLastActivity) - Date.parse(a.DateLastActivity))
    const draw = () => body.replaceChildren(
        h('p.muted.small.srv-note', `${list.length} device${list.length === 1 ? '' : 's'}. Everyone reaches the server through Cove, so the address shows as Cove’s for now.`),
        h('div.group.srv-list', list.map(d => h('div.list-row.srv-dev',
            h('span.srv-dev-ico', icon(devIcon(d))),
            h('div.srv-dev-info',
                h('div', d.Name, d.Id === mine ? h('span.srv-tag', 'This device') : null),
                h('div.muted.small', `${d.AppName} ${d.AppVersion || ''}`.trim()),
                h('div.muted.small', `${d.LastUserName || 'Nobody yet'} · ${ago(d.DateLastActivity)} · ${when(d.DateLastActivity)}`)),
            d.Id === mine ? null : h('button.pill.glass.small', { onclick: () => removeDev(d) }, 'Remove')))))
    const removeDev = d => {
        const s = sheet([h('div.form-pad',
            h('p', `Remove ${d.Name} (${d.AppName}, ${d.LastUserName || 'no one'})?`),
            h('p.muted.small', 'That device gets signed out and has to sign in again. Nothing else changes.'),
            h('button.pill.white.block', { onclick: async () => {
                try { await api.request('/Devices', { method: 'DELETE', query: { id: d.Id } }); list = list.filter(x => x.Id !== d.Id); s.close(); toast(`Removed ${d.Name}`); draw() }
                catch (e) { toast(e.message) }
            } }, 'Remove Device'))], { title: 'Remove Device' })
    }
    draw()
}
function devIcon(d) {
    const n = `${d.Name} ${d.AppName}`.toLowerCase()
    if (/tv|webos|roku|tizen|fire/.test(n)) return 'tv'
    return 'film'
}

// ------------------------------------------------------------------ one user (Emby's user pages, on Jellyfin's policy)
// The level (Change Level) owns admin, the Kids/Teens tag lock and never-lock-out; everything here is per person.
async function userPage(body, email) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let person, user, libs
    try {
        const { people } = await peopleCall('')
        person = people.find(p => (p.email || '').toLowerCase() === email.toLowerCase())
        if (!person?.userId) throw new Error('They haven’t been set up yet')
        ;[user, libs] = await Promise.all([api.request('/Users/' + person.userId), api.request('/Library/MediaFolders')])
    } catch (e) { return body.replaceChildren(h('a.pill.glass.small.srv-back', { href: '#/server/users' }, icon('back'), ' Users'), h('p.muted.srv-empty', e.message)) }
    const pol = structuredClone(user.Policy)
    const me = person.userId === api.userId(), isOwner = person.role === 'owner'
    const folders = (libs.Items || []).filter(f => f.CollectionType !== 'boxsets' && f.CollectionType !== 'playlists')
    const save = h('button.pill.white', { disabled: true, onclick: async () => {
        save.disabled = true; save.textContent = 'Saving…'
        try {
            const fresh = (await api.request('/Users/' + person.userId)).Policy   // keep what the level owns
            const keep = { IsAdministrator: fresh.IsAdministrator, AllowedTags: fresh.AllowedTags, BlockedTags: fresh.BlockedTags,
                MaxParentalRating: fresh.MaxParentalRating, BlockUnratedItems: fresh.BlockUnratedItems, LoginAttemptsBeforeLockout: fresh.LoginAttemptsBeforeLockout }
            await api.request(`/Users/${person.userId}/Policy`, { method: 'POST', body: { ...pol, ...keep } })
            save.textContent = 'Saved'; wrap.classList.remove('show'); toast(`Saved ${person.name}’s settings`)
        } catch (e) { toast(e.message); save.disabled = false; save.textContent = 'Save' }
    } }, 'Save')
    const changed = () => { save.disabled = false; save.textContent = 'Save'; wrap.classList.add('show') }
    const wrap = h('div.srv-save-wrap', h('span', 'Unsaved changes'), save)
    const onFlip = {}
    const sw = (key, label, note) => {
        const t = h('button.ios-sw' + (pol[key] ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!pol[key]), 'aria-label': label,
            onclick: () => { pol[key] = !pol[key]; t.classList.toggle('on', !!pol[key]); t.setAttribute('aria-checked', String(!!pol[key])); changed(); onFlip[key]?.() } })
        return h('div.list-row.srv-sw', h('div', h('div', label), note ? h('div.muted.small', note) : null), t)
    }
    const num = (key, label, { scale = 1, unit = '', zero = 'No limit' } = {}) => {
        const i = h('input.srv-num', { type: 'number', min: 0, inputmode: 'numeric', value: pol[key] ? Math.round(pol[key] / scale) : '', placeholder: zero,
            oninput: () => { pol[key] = i.value ? Math.max(0, Math.round(+i.value * scale)) : 0; changed() } })
        return h('div.list-row.srv-sw', h('div', label), h('span.srv-num-wrap', i, unit ? h('span.muted.small', unit) : null))
    }
    const folderList = (allKey, listKey) => {
        const box = h('div.srv-folders')
        const draw = () => box.replaceChildren(...(pol[allKey] ? [] : folders.map(f => {
            const on = (pol[listKey] || []).includes(f.Id)
            return h('button.srv-check' + (on ? '.on' : ''), { onclick: () => {
                const set = new Set(pol[listKey] || []); on ? set.delete(f.Id) : set.add(f.Id); pol[listKey] = [...set]; changed(); draw()
            } }, h('span.srv-box', on ? icon('check') : null), f.Name)
        })))
        onFlip[allKey] = draw; draw()
        return box
    }
    const tagNote = person.role === 'kid' ? 'Only titles tagged Kids.' : person.role === 'teen' ? 'Only titles tagged Kids or Teens.' : 'Sees every title in the libraries they have.'
    body.replaceChildren(
        h('a.pill.glass.small.srv-back', { href: '#/server/users' }, icon('back'), ' Users'),
        h('div.srv-user-head', h('div.avatar', (person.name || '?')[0]),
            h('div', h('div.srv-title', person.name, h('span.level.' + person.role, levelLabel(person.role))),
                h('div.muted.small', `Signs in with ${person.email}`))),
        h('div.group-label', 'Level'),
        h('div.group', h('div.list-row', h('div', h('div', levelLabel(person.role)), h('div.muted.small', tagNote + (pol.IsAdministrator ? ' Can manage the server.' : ''))),
            !isOwner && api.role() === 'owner' ? h('button.pill.glass.small', { onclick: () => peopleLevelSheet(person, () => userPage(body, email)) }, 'Change') : null)),
        h('div.group-label', 'Access'),
        h('div.group',
            sw('EnableRemoteAccess', 'Allow connections from away', 'Off = only at home'),
            isOwner || me ? null : sw('IsDisabled', 'Disable this user', 'Signs them out and blocks sign-in until you turn it back off'),
            sw('IsHidden', 'Hide from sign-in screens', 'In Jellyfin’s own apps'),
            sw('EnableAllFolders', 'All libraries'), folderList('EnableAllFolders', 'EnabledFolders')),
        h('div.group-label', 'Playback'),
        h('div.group',
            sw('EnableMediaPlayback', 'Allow playback'),
            sw('EnablePlaybackRemuxing', 'Allow changing the file type', 'Remux: video copied untouched, no quality loss'),
            sw('EnableAudioPlaybackTranscoding', 'Allow converting audio'),
            sw('EnableVideoPlaybackTranscoding', 'Allow converting video', 'On the 4090, when a device can’t play the file'),
            sw('ForceRemoteSourceTranscoding', 'Always convert away from home'),
            num('MaxActiveSessions', 'Streams at once', { zero: 'Unlimited' }),
            num('RemoteClientBitrateLimit', 'Quality limit away from home', { scale: 1_000_000, unit: 'Mbps' })),
        h('div.group-label', 'Features'),
        h('div.group',
            sw('EnableLiveTvAccess', 'Live TV'),
            sw('EnableLiveTvManagement', 'Manage Live TV recordings'),
            sw('EnableContentDownloading', 'Allow downloads'),
            sw('EnableSyncTranscoding', 'Downloads that need converting'),
            sw('EnableSubtitleManagement', 'Manage subtitles'),
            sw('EnableCollectionManagement', 'Manage collections'),
            sw('EnablePublicSharing', 'Social sharing'),
            sw('EnableRemoteControlOfOtherUsers', 'Remote control of other users'),
            sw('EnableSharedDeviceControl', 'Remote control of shared devices')),
        h('div.group-label', 'Delete media from'),
        h('div.group', sw('EnableContentDeletion', 'All libraries', 'Deletes the actual files'), folderList('EnableContentDeletion', 'EnableContentDeletionFromFolders')),
        h('div.srv-save-space'))
    // the floating Save bar lives on <body> (a transformed page would pin it to the page instead of the screen)
    document.querySelector('.srv-save-wrap')?.remove()
    document.body.append(wrap)
    const gone = () => { if (!location.hash.startsWith('#/server/user/')) { wrap.remove(); removeEventListener('hashchange', gone) } }
    addEventListener('hashchange', gone)
}

// ------------------------------------------------------------------ libraries (Emby's library pages, on Jellyfin's LibraryOptions)
// shows Jellyfin's /media/... paths as this computer's own folder when the server says what that is (host.mediaFolder)
const winPath = p => host.mediaFolder && p.startsWith('/media/') ? host.mediaFolder + '\\' + p.slice(7).replace(/\//g, '\\') : p
const TYPE_LABEL = { movies: 'Movies', tvshows: 'TV shows', boxsets: 'Collections', music: 'Music', musicvideos: 'Music videos', books: 'Books', homevideos: 'Home videos' }
const KIND = { Movie: 'Movie', Series: 'Series', Season: 'Season', Episode: 'Episode', MusicArtist: 'Artist', MusicAlbum: 'Album', Audio: 'Song', MusicVideo: 'Music video', BoxSet: 'Collection' }

// a floating "Unsaved changes · Save" bar on <body>, removed when leaving the page
function saveBar(onSave) {
    const btn = h('button.pill.white', { onclick: async () => {
        btn.disabled = true; btn.textContent = 'Saving…'
        try { await onSave(); bar.classList.remove('show'); toast('Saved') } catch (e) { toast(e.message) }
        btn.disabled = false; btn.textContent = 'Save'
    } }, 'Save')
    const bar = h('div.srv-save-wrap', h('span', 'Unsaved changes'), btn)
    document.querySelectorAll('.srv-save-wrap').forEach(x => x.remove())
    document.body.append(bar)
    const here = location.hash
    const gone = () => { if (location.hash !== here) { bar.remove(); removeEventListener('hashchange', gone) } }
    addEventListener('hashchange', gone)
    return () => bar.classList.add('show')
}
const swRow = (obj, key, label, note, changed) => {
    const t = h('button.ios-sw' + (obj[key] ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!obj[key]), 'aria-label': label,
        onclick: () => { obj[key] = !obj[key]; t.classList.toggle('on', !!obj[key]); t.setAttribute('aria-checked', String(!!obj[key])); changed() } })
    return h('div.list-row.srv-sw', h('div', h('div', label), note ? h('div.muted.small', note) : null), t)
}
const selectRow = (obj, key, label, options, note, changed, parse = v => v) => {
    const s = h('select.srv-select', { onchange: () => { obj[key] = parse(s.value); changed() } },
        options.map(([v, l]) => h('option', { value: v, selected: String(obj[key] ?? '') === String(v) }, l)))
    return h('div.list-row.srv-sw', h('div', h('div', label), note ? h('div.muted.small', note) : null), s)
}
const numRow = (obj, key, label, unit, changed) => {
    const i = h('input.srv-num', { type: 'number', min: 0, inputmode: 'numeric', value: obj[key] ?? '', oninput: () => { obj[key] = Math.max(0, +i.value || 0); changed() } })
    return h('div.list-row.srv-sw', h('div', label), h('span.srv-num-wrap', i, unit ? h('span.muted.small', unit) : null))
}
// ranked list with checkboxes and up/down arrows (Emby's drag handles, made tappable)
function rankList(all, enabled, order, onChange) {
    let ord = [...order.filter(n => all.includes(n)), ...all.filter(n => !order.includes(n))]
    let on = new Set(enabled)
    const box = h('div.srv-rank')
    const emit = () => onChange(ord.filter(n => on.has(n)), [...ord])
    const draw = () => box.replaceChildren(...ord.map((n, i) => h('div.srv-rank-row',
        h('button.srv-check' + (on.has(n) ? '.on' : ''), { onclick: () => { on.has(n) ? on.delete(n) : on.add(n); emit(); draw() } }, h('span.srv-box', on.has(n) ? icon('check') : null), n),
        h('span.srv-rank-btns',
            h('button.srv-arrow', { disabled: i === 0, 'aria-label': `Move ${n} up`, onclick: () => { [ord[i - 1], ord[i]] = [ord[i], ord[i - 1]]; emit(); draw() } }, '↑'),
            h('button.srv-arrow', { disabled: i === ord.length - 1, 'aria-label': `Move ${n} down`, onclick: () => { [ord[i + 1], ord[i]] = [ord[i], ord[i + 1]]; emit(); draw() } }, '↓')))))
    draw()
    return box
}

async function librariesTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let libs, cfg
    try { [libs, cfg] = await Promise.all([api.request('/Library/VirtualFolders'), api.request('/System/Configuration')]) }
    catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const resume = { MinResumePct: cfg.MinResumePct, MaxResumePct: cfg.MaxResumePct, MinResumeDurationSeconds: cfg.MinResumeDurationSeconds }
    const show = saveBar(async () => {
        const fresh = await api.request('/System/Configuration')
        await api.request('/System/Configuration', { method: 'POST', body: { ...fresh, ...resume } })
    })
    const scanAll = h('button.pill.glass.small', { onclick: async () => {
        scanAll.disabled = true
        try { await api.request('/Library/Refresh', { method: 'POST' }); toast('Scanning every library. New files show up in a few minutes.') } catch (e) { toast(e.message) }
        setTimeout(() => scanAll.disabled = false, 5000)
    } }, 'Scan All Libraries')
    body.replaceChildren(
        h('div.srv-users-head', h('p.muted.small', 'Sonarr and Radarr already tell Jellyfin about new downloads, so scanning by hand is rarely needed.'), scanAll),
        h('div.group.srv-list', libs.map(l => h('a.list-row', { href: '#/server/library/' + l.ItemId },
            h('div', h('div', l.Name), h('div.muted.small', `${TYPE_LABEL[l.CollectionType] || l.CollectionType || 'Mixed'} · ${(l.Locations || []).map(winPath).join(', ')}`)),
            icon('chevron')))),
        h('div.group-label', 'Resume (all libraries)'),
        h('div.group',
            numRow(resume, 'MinResumePct', 'Counts as not started before', '%', show),
            numRow(resume, 'MaxResumePct', 'Counts as watched after', '%', show),
            numRow(resume, 'MinResumeDurationSeconds', 'Shortest video that can be resumed', 'sec', show)))
}

async function libraryPage(body, id) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let lib, avail
    try {
        lib = (await api.request('/Library/VirtualFolders')).find(l => l.ItemId === id)
        if (!lib) throw new Error('That library is gone')
        avail = await api.request('/Libraries/AvailableOptions', { query: { libraryContentType: lib.CollectionType || '', isNewLibrary: false } })
    } catch (e) { return body.replaceChildren(h('a.pill.glass.small.srv-back', { href: '#/server/libraries' }, icon('back'), ' Libraries'), h('p.muted.srv-empty', e.message)) }
    const o = structuredClone(lib.LibraryOptions)
    const show = saveBar(() => api.request('/Library/VirtualFolders/LibraryOptions', { method: 'POST', body: { Id: id, LibraryOptions: o } }))
    const nfoOn = { v: (o.MetadataSavers || []).includes('Nfo') }
    const typeOpts = (avail.TypeOptions || []).map(t => {
        const meta = t.MetadataFetchers.map(f => f.Name), imgs = t.ImageFetchers.map(f => f.Name)
        // no saved entry = Jellyfin's defaults (the ones it marks DefaultEnabled); only stored once something changes
        let mine = (o.TypeOptions || []).find(x => x.Type === t.Type)
        const stored = !!mine
        if (!mine) mine = { Type: t.Type, MetadataFetchers: t.MetadataFetchers.filter(f => f.DefaultEnabled).map(f => f.Name), MetadataFetcherOrder: meta,
            ImageFetchers: t.ImageFetchers.filter(f => f.DefaultEnabled).map(f => f.Name), ImageFetcherOrder: imgs, ImageOptions: t.DefaultImageOptions || [] }
        const keep = () => { if (!stored && !(o.TypeOptions ||= []).includes(mine)) o.TypeOptions.push(mine) }
        return [
            meta.length ? [h('div.group-label', `${KIND[t.Type] || t.Type} info sources`), h('div.group', h('p.muted.small.srv-rank-note', 'Checked ones are used, top first. Lower ones only fill in what’s missing.'),
                rankList(meta, mine.MetadataFetchers || [], mine.MetadataFetcherOrder || [], (en, ord) => { keep(); mine.MetadataFetchers = en; mine.MetadataFetcherOrder = ord; show() }))] : [],
            imgs.length ? [h('div.group-label', `${KIND[t.Type] || t.Type} image sources`), h('div.group',
                rankList(imgs, mine.ImageFetchers || [], mine.ImageFetcherOrder || [], (en, ord) => { keep(); mine.ImageFetchers = en; mine.ImageFetcherOrder = ord; show() }))] : []]
    })
    const scan = h('button.pill.glass.small', { onclick: async () => {
        scan.disabled = true
        try { await api.request(`/Items/${id}/Refresh`, { method: 'POST', query: { Recursive: true, MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ReplaceAllMetadata: false, ReplaceAllImages: false } }); toast(`Scanning ${lib.Name}`) }
        catch (e) { toast(e.message) }
        setTimeout(() => scan.disabled = false, 5000)
    } }, 'Scan Library')
    const tv = lib.CollectionType === 'tvshows'
    body.replaceChildren(
        h('a.pill.glass.small.srv-back', { href: '#/server/libraries' }, icon('back'), ' Libraries'),
        h('div.srv-users-head', h('div.srv-title', lib.Name, h('span.level.member', TYPE_LABEL[lib.CollectionType] || 'Mixed')), scan),
        h('div.group-label', 'Folders'),
        h('div.group', (lib.Locations || []).map(p => h('div.list-row', h('div', h('div', winPath(p)), h('div.muted.small', p))))),
        h('div.group-label', 'Library settings'),
        h('div.group',
            selectRow(o, 'PreferredMetadataLanguage', 'Info language', [['', 'Server default (English)'], ['en', 'English'], ['es', 'Spanish'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean']], null, show),
            selectRow(o, 'MetadataCountryCode', 'Rating country', [['', 'Server default (US)'], ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['MX', 'Mexico'], ['CN', 'China']], 'Which rating system (PG-13, TV-14…)', show),
            swRow(o, 'EnableEmbeddedTitles', 'Prefer titles inside the files', 'Only when nothing is found online or in an .nfo', show),
            swRow(o, 'EnableRealtimeMonitor', 'Watch the folders for changes', 'Docker on Windows doesn’t pass these through; Sonarr and Radarr tell Jellyfin instead', show),
            tv ? swRow(o, 'EnableAutomaticSeriesGrouping', 'Merge a show spread across folders', null, show) : null,
            selectRow(o, 'AutomaticRefreshIntervalDays', 'Refresh info from the internet', [[0, 'Never'], [30, 'Every 30 days'], [60, 'Every 60 days'], [90, 'Every 90 days']], 'Longer scans when on', show, v => +v),
            swRow(o, 'EnableChapterImageExtraction', 'Chapter pictures', tv ? 'TV shows have no plain chapters on purpose (our skip markers instead)' : null, show),
            swRow(o, 'EnableTrickplayImageExtraction', 'Preview pictures while scrubbing', 'Takes hours and disk space the first time', show)),
        h('div.group-label', 'Saving'),
        h('div.group',
            swRow(o, 'SaveLocalMetadata', 'Save artwork into the media folders', 'Writes posters next to the files on G:', show),
            (() => { const r = swRow(nfoOn, 'v', 'Save info as .nfo files', 'Next to the files, readable by other apps', () => { o.MetadataSavers = nfoOn.v ? ['Nfo'] : []; show() }); return r })()),
        ...typeOpts.flat(2),
        h('div.group-label', 'More library options'),
        h('div.group',
            swRow(o, 'Enabled', 'Library turned on', 'Off hides it everywhere without deleting anything', show),
            swRow(o, 'EnableInternetProviders', 'Get info from the internet', null, show),
            swRow(o, 'EnablePhotos', 'Include photos', null, show),
            swRow(o, 'EnableLUFSScan', 'Measure loudness', 'For volume leveling in apps that support it', show),
            swRow(o, 'ExtractChapterImagesDuringLibraryScan', 'Make chapter pictures during scans', 'Otherwise the nightly task does it', show),
            swRow(o, 'ExtractTrickplayImagesDuringLibraryScan', 'Make preview pictures during scans', null, show),
            swRow(o, 'SaveTrickplayWithMedia', 'Save preview pictures next to the files', null, show),
            swRow(o, 'EnableEmbeddedExtrasTitles', 'Use titles inside extras files', null, show),
            swRow(o, 'EnableEmbeddedEpisodeInfos', 'Use episode info inside the files', null, show),
            tv ? textRow(o, 'SeasonZeroDisplayName', 'Name for season 0', null, show, 'Specials') : null,
            swRow(o, 'AutomaticallyAddToCollection', 'Add to collections on its own', 'Using TMDb collection info', show),
            selectRow(o, 'AllowEmbeddedSubtitles', 'Built-in subtitles', [['AllowAll', 'Allow all'], ['AllowText', 'Text only'], ['AllowImage', 'Pictures only'], ['AllowNone', 'None']], 'The library is external .srt only, so this rarely matters', show)),
        h('div.group-label', 'Jellyfin’s subtitle downloader (off, Bazarr does this)'),
        h('div.group',
            swRow(o, 'SkipSubtitlesIfEmbeddedSubtitlesPresent', 'Skip if the file has built-in subtitles', null, show),
            swRow(o, 'SkipSubtitlesIfAudioTrackMatches', 'Skip if the audio is already in that language', null, show),
            swRow(o, 'RequirePerfectSubtitleMatch', 'Only exact matches', null, show),
            swRow(o, 'SaveSubtitlesWithMedia', 'Save next to the video', null, show)),
        h('div.group-label', 'Skip markers'),
        h('div.group', h('div.list-row', h('div', h('div', host.markersPlugin || 'Skip markers plugin'), h('div.muted.small', 'Our own intro, recap, preview and credits markers, pushed daily at 10:15')), icon('check'))),
        h('div.group-label', 'Subtitles'),
        h('div.group', h('div.list-row', h('div', h('div', 'Bazarr'), h('div.muted.small', 'External .srt files only, next to the video. Jellyfin’s own downloader stays off so they don’t fight.')))),
        h('div.srv-save-space'))
}

// ------------------------------------------------------------------ transcoding + tone mapping (Jellyfin's EncodingOptions)
const CODECS = [['h264', 'H.264'], ['hevc', 'HEVC (H.265)'], ['av1', 'AV1'], ['vp9', 'VP9'], ['vp8', 'VP8'], ['mpeg2video', 'MPEG-2'], ['vc1', 'VC-1']]
async function transcodingTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let enc
    try { enc = await api.request('/System/Configuration/encoding') } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const o = structuredClone(enc)
    const show = saveBar(async () => {
        const fresh = await api.request('/System/Configuration/encoding')
        const keep = { HardwareAccelerationType: fresh.HardwareAccelerationType, TranscodingTempPath: fresh.TranscodingTempPath, EncoderAppPath: fresh.EncoderAppPath }
        await api.request('/System/Configuration/encoding', { method: 'POST', body: { ...o, ...keep } })
    })
    const dec = h('div.srv-folders')
    const drawDec = () => dec.replaceChildren(...CODECS.map(([c, n]) => {
        const on = (o.HardwareDecodingCodecs || []).includes(c)
        return h('button.srv-check' + (on ? '.on' : ''), { onclick: () => { const s = new Set(o.HardwareDecodingCodecs || []); on ? s.delete(c) : s.add(c); o.HardwareDecodingCodecs = [...s]; show(); drawDec() } }, h('span.srv-box', on ? icon('check') : null), n)
    }))
    drawDec()
    body.replaceChildren(
        h('div.group-label', 'Hardware'),
        h('div.group',
            h('div.list-row', h('div', h('div', 'NVIDIA NVENC on the RTX 4090'), h('div.muted.small', 'Locked: it’s the only kind that works in this Docker setup')), icon('check')),
            h('div.list-row.srv-sw', h('div', h('div', 'Decode on the 4090'), h('div.muted.small', 'Video types the graphics card reads'))), dec,
            swRow(o, 'EnableHardwareEncoding', 'Encode on the 4090', null, show),
            swRow(o, 'EnableEnhancedNvdecDecoder', 'Enhanced NVDEC decoder', null, show),
            swRow(o, 'EnableDecodingColorDepth10Hevc', '10-bit HEVC decoding', null, show),
            swRow(o, 'EnableDecodingColorDepth10Vp9', '10-bit VP9 decoding', null, show),
            swRow(o, 'AllowHevcEncoding', 'Allow HEVC output', 'Smaller streams for devices that play HEVC', show),
            swRow(o, 'AllowAv1Encoding', 'Allow AV1 output', null, show)),
        h('div.group-label', 'Quality and speed'),
        h('div.group',
            selectRow(o, 'EncoderPreset', 'Encoding speed', [['auto', 'Auto'], ['veryfast', 'Very fast'], ['faster', 'Faster'], ['fast', 'Fast'], ['medium', 'Medium'], ['slow', 'Slow (better quality)']], null, show),
            numRow(o, 'H264Crf', 'H.264 quality (lower = better)', 'CRF', show),
            numRow(o, 'H265Crf', 'HEVC quality (lower = better)', 'CRF', show),
            swRow(o, 'EnableThrottling', 'Throttle', 'Slows converting once it’s far enough ahead of you', show),
            swRow(o, 'EnableSegmentDeletion', 'Delete old pieces while playing', 'Saves temp space on long movies', show),
            numRow(o, 'DownMixAudioBoost', 'Audio boost when downmixing to stereo', '×', show),
            swRow(o, 'EnableSubtitleExtraction', 'Pull text subtitles out on the fly', null, show)),
        h('div.group-label', 'Tone mapping (HDR to SDR)'),
        h('div.group',
            swRow(o, 'EnableTonemapping', 'Tone mapping on the 4090', 'Uses CUDA; the other methods don’t work in Docker', show),
            selectRow(o, 'TonemappingAlgorithm', 'Method', [['bt2390', 'BT.2390 (Jellyfin’s pick)'], ['hable', 'Hable'], ['mobius', 'Mobius (your Emby pick)'], ['reinhard', 'Reinhard'], ['clip', 'Clip'], ['linear', 'Linear'], ['none', 'None']], null, show),
            selectRow(o, 'TonemappingRange', 'Range', [['auto', 'Auto'], ['tv', 'TV'], ['pc', 'PC']], null, show),
            numRow(o, 'TonemappingPeak', 'Peak brightness', 'nits', show),
            numRow(o, 'TonemappingDesat', 'Desaturation', null, show)),
        h('div.group-label', 'Folders'),
        h('div.group', h('div.list-row', h('div', h('div', 'Converting folder'), h('div.muted.small', (o.TranscodingTempPath || 'Inside the jellyfin-cache volume (E: drive)') + '. Changing it needs a Docker change, so it’s shown only.')))),
        h('div.srv-save-space'))
}

// ------------------------------------------------------------------ plugins + catalog + API keys
async function pluginsTab(body, sub = 'mine') {
    const seg = h('div.seg-row.srv-subseg', h('div.seg', [['mine', 'My Plugins'], ['catalog', 'Catalog'], ['keys', 'API Keys']].map(([k, l]) =>
        h('button', { class: k === sub ? 'on' : '', onclick: () => pluginsTab(body, k) }, l))))
    const box = h('div', h('div.loading-page', h('div.spinner')))
    body.replaceChildren(seg, box)
    const restartNote = () => h('div.srv-note-card', 'Jellyfin needs a restart to finish. ', h('button.pill.glass.small', { onclick: () => restartSheet() }, 'Restart Jellyfin'))
    try {
        if (sub === 'mine') {
            const list = await api.request('/Plugins')
            const needs = list.some(p => /Restart/i.test(p.Status))
            box.replaceChildren(needs ? restartNote() : null, h('div.group.srv-list', list.map(p => h('div.list-row',
                h('div', h('div', p.Name), h('div.muted.small', `${p.Version} · ${p.Status}${p.CanUninstall ? '' : ' · built in'}`)),
                h('span.srv-rank-btns',
                    p.Status === 'Active' ? h('button.pill.glass.small', { onclick: () => pluginAct(p, 'Disable') }, 'Turn Off')
                        : p.Status === 'Disabled' ? h('button.pill.glass.small', { onclick: () => pluginAct(p, 'Enable') }, 'Turn On') : null,
                    p.CanUninstall ? h('button.pill.glass.small', { onclick: () => uninstall(p) }, 'Remove') : null)))))
        } else if (sub === 'catalog') {
            const [pkgs, mine] = await Promise.all([api.request('/Packages'), api.request('/Plugins')])
            const have = new Set(mine.map(p => p.Id.replace(/-/g, '')))
            const q = h('input.srv-search', { type: 'search', placeholder: 'Search plugins', oninput: () => draw() })
            const listBox = h('div.group.srv-list')
            const draw = () => listBox.replaceChildren(...pkgs.filter(p => !q.value || `${p.name} ${p.overview} ${p.category}`.toLowerCase().includes(q.value.toLowerCase()))
                .map(p => h('div.list-row',
                    h('div', h('div', p.name, h('span.muted.small', ' · ' + p.category)), h('div.muted.small', p.overview || (p.description || '').slice(0, 140))),
                    have.has((p.guid || '').replace(/-/g, '')) ? h('span.srv-tag', 'Installed') : h('button.pill.glass.small', { onclick: () => install(p) }, 'Install'))))
            draw()
            box.replaceChildren(h('p.muted.small.srv-note', 'From Jellyfin’s official catalog. Installing downloads the plugin onto this server, then Jellyfin restarts when nobody’s watching.'), h('div.srv-search-wrap', q), listBox)
        } else {
            const keys = (await api.request('/Auth/Keys')).Items || []
            box.replaceChildren(
                h('div.srv-users-head', h('p.muted.small', 'Keys let scripts and apps use the server without a password.'), h('button.pill.glass.small', { onclick: () => newKey() }, icon('plus'), ' New Key')),
                h('div.group.srv-list', keys.map(k => h('div.list-row',
                    h('div', h('div', k.AppName), h('div.muted.small', `${k.AccessToken.slice(0, 4)}•••• · made ${new Date(k.DateCreated).toLocaleDateString()}${k.AppName === host.protectedApiKey ? ' · ' + (host.machineName || 'This computer') + '’s scripts use this one' : ''}`)),
                    k.AppName === host.protectedApiKey ? h('span.srv-tag', 'In use') : h('button.pill.glass.small', { onclick: () => revoke(k) }, 'Revoke')))))
        }
    } catch (e) { box.replaceChildren(h('p.muted.srv-empty', e.message)) }
    async function pluginAct(p, act) {
        try { await api.request(`/Plugins/${p.Id}/${p.Version}/${act}`, { method: 'POST' }); toast(`${p.Name}: ${act === 'Enable' ? 'on' : 'off'} after a restart`); pluginsTab(body, 'mine') } catch (e) { toast(e.message) }
    }
    function uninstall(p) {
        const s = sheet([h('div.form-pad', h('p', `Remove ${p.Name}?`), h('p.muted.small', 'Jellyfin needs a restart to finish removing it.'),
            h('button.pill.white.block', { onclick: async () => { try { await api.request(`/Plugins/${p.Id}/${p.Version}`, { method: 'DELETE' }); s.close(); toast(`${p.Name} removed`); pluginsTab(body, 'mine') } catch (e) { toast(e.message) } } }, 'Remove Plugin'))], { title: 'Remove Plugin' })
    }
    function install(p) {
        const v = (p.versions || [])[0]
        const s = sheet([h('div.form-pad', h('p', `Install ${p.name} ${v?.version || ''}?`), h('p.muted.small', (p.description || p.overview || '').slice(0, 400)),
            h('p.muted.small', 'It downloads from Jellyfin’s official catalog onto this server. Jellyfin needs a restart to load it.'),
            h('button.pill.white.block', { onclick: async () => {
                try { await api.request(`/Packages/Installed/${encodeURIComponent(p.name)}`, { method: 'POST', query: { assemblyGuid: p.guid, version: v?.version } }); s.close(); toast(`Installing ${p.name}`); setTimeout(() => pluginsTab(body, 'mine'), 2500) }
                catch (e) { toast(e.message) }
            } }, 'Install'))], { title: 'Install Plugin' })
    }
    function newKey() {
        const name = h('input', { type: 'text', placeholder: 'What is it for? (e.g. Kodi at work)' })
        const s = sheet([h('div.form-pad', h('div.field-group', name),
            h('button.pill.white.block', { onclick: async () => {
                if (!name.value.trim()) return
                try {
                    const before = new Set(((await api.request('/Auth/Keys')).Items || []).map(k => k.AccessToken))
                    await api.request('/Auth/Keys', { method: 'POST', query: { app: name.value.trim() } })
                    const made = ((await api.request('/Auth/Keys')).Items || []).find(k => !before.has(k.AccessToken))
                    s.close()
                    const shown = sheet([h('div.form-pad', h('p.muted.small', 'Copy it now. Cove only shows the first characters after this.'), h('div.invite-link', made?.AccessToken || '(made, but couldn’t read it back)'),
                        h('button.pill.glass', { onclick: async () => { try { await navigator.clipboard.writeText(made.AccessToken); toast('Copied') } catch { toast('Couldn’t copy') } } }, 'Copy'))], { title: name.value.trim(), onClose: () => pluginsTab(body, 'keys') })
                } catch (e) { toast(e.message) }
            } }, 'Make Key'))], { title: 'New API Key' })
        setTimeout(() => name.focus(), 80)
    }
    function revoke(k) {
        const s = sheet([h('div.form-pad', h('p', `Revoke the key for ${k.AppName}?`), h('p.muted.small', 'Anything using it stops working right away.'),
            h('button.pill.white.block', { onclick: async () => { try { await api.request(`/Auth/Keys/${k.AccessToken}`, { method: 'DELETE' }); s.close(); toast('Revoked'); pluginsTab(body, 'keys') } catch (e) { toast(e.message) } } }, 'Revoke'))], { title: 'Revoke Key' })
    }
}
async function restartSheet() {
    let watching = []
    try { watching = (await api.request('/Sessions', { query: { activeWithinSeconds: 960 } })).filter(s => s.NowPlayingItem) } catch {}
    const s = sheet([h('div.form-pad',
        watching.length ? h('p', `${watching.map(w => w.UserName).join(', ')} ${watching.length === 1 ? 'is' : 'are'} watching right now. A restart stops their video for about 20 seconds.`)
            : h('p', 'Nobody’s watching. Jellyfin will be back in about 20 seconds.'),
        h('button.pill.white.block', { onclick: async () => { try { await api.request('/System/Restart', { method: 'POST' }); s.close(); toast('Restarting Jellyfin…', 4000) } catch (e) { toast(e.message) } } }, watching.length ? 'Restart Anyway' : 'Restart Now'))], { title: 'Restart Jellyfin' })
}

// ------------------------------------------------------------------ scheduled tasks
async function tasksTab(body) {
    const box = h('div', h('div.loading-page', h('div.spinner')))
    body.replaceChildren(box)
    const draw = async () => {
        let tasks
        try { tasks = (await api.request('/ScheduledTasks')).filter(t => !t.IsHidden) } catch (e) { return box.replaceChildren(h('p.muted.srv-empty', e.message)) }
        const cats = [...new Set(tasks.map(t => t.Category))].sort()
        box.replaceChildren(...cats.flatMap(c => [h('div.group-label', c), h('div.group.srv-list', tasks.filter(t => t.Category === c).map(t => {
            const r = t.LastExecutionResult
            const took = r && r.EndTimeUtc ? Math.max(0, Math.round((Date.parse(r.EndTimeUtc) - Date.parse(r.StartTimeUtc)) / 1000)) : null
            const status = t.State === 'Running' ? `Running ${Math.round(t.CurrentProgressPercentage || 0)}%`
                : r ? `Last ran ${ago(r.EndTimeUtc || r.StartTimeUtc)}${took != null ? `, took ${took < 90 ? took + ' s' : Math.round(took / 60) + ' min'}` : ''}${r.Status && r.Status !== 'Completed' ? ' · ' + r.Status : ''}` : 'Hasn’t run yet'
            return h('div.list-row',
                h('div', h('div', t.Name), h('div.muted.small', status), t.Description ? h('div.muted.small.srv-desc', t.Description) : null),
                t.State === 'Running' ? h('button.pill.glass.small', { onclick: async () => { await api.request(`/ScheduledTasks/Running/${t.Id}`, { method: 'DELETE' }).catch(() => {}); draw() } }, 'Stop')
                    : h('button.pill.glass.small', { 'aria-label': 'Run ' + t.Name, onclick: async () => { try { await api.request(`/ScheduledTasks/Running/${t.Id}`, { method: 'POST' }); toast(`Started ${t.Name}`); setTimeout(draw, 800) } catch (e) { toast(e.message) } } }, icon('play'), ' Run'))
        }))]),
            ...(host.jobs?.length ? [h('div.group-label', `${host.machineName || 'This computer'}’s own jobs`),
                h('div.group', host.jobs.map(([n, d]) => h('div.list-row', h('div', h('div', n), h('div.muted.small', d))))),
                host.jobsNote ? h('p.muted.small.srv-note', host.jobsNote) : ''] : []))
    }
    draw()
    timer = setInterval(() => { if (document.visibilityState === 'visible') draw() }, 8000)
}

// ------------------------------------------------------------------ logs
async function logsTab(body, name) {
    if (name) return logView(body, name)
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let logs
    try { logs = await api.request('/System/Logs') } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    logs.sort((a, b) => Date.parse(b.DateModified) - Date.parse(a.DateModified))
    body.replaceChildren(h('p.muted.small.srv-note', `${logs.length} logs. Tap one to read it.`),
        h('div.group.srv-list', logs.map(l => h('a.list-row', { href: '#/server/logs/' + encodeURIComponent(l.Name) },
            h('div', h('div.srv-mono', l.Name), h('div.muted.small', `${when(l.DateModified)} · ${(l.Size / 1024 / 1024).toFixed(1)} MB`)), icon('chevron')))))
}
async function logView(body, name) {
    name = decodeURIComponent(name)
    body.replaceChildren(h('a.pill.glass.small.srv-back', { href: '#/server/logs' }, icon('back'), ' Logs'), h('div.loading-page', h('div.spinner')))
    let text
    try { text = await (await api.request('/System/Logs/Log', { query: { name }, raw: true })).text() } catch (e) { return body.append(h('p.muted.srv-empty', e.message)) }
    const lines = text.split('\n')
    const q = h('input.srv-search', { type: 'search', placeholder: 'Search this log', oninput: () => draw() })
    let errorsOnly = false
    const errBtn = h('button.pill.glass.small', { onclick: () => { errorsOnly = !errorsOnly; errBtn.textContent = errorsOnly ? 'Show Everything' : 'Errors Only'; draw() } }, 'Errors Only')
    const pre = h('pre.srv-log-text')
    const count = h('span.muted.small')
    const draw = () => {
        const ql = q.value.toLowerCase()
        const shown = lines.filter(l => (!errorsOnly || /\[(ERR|WRN|FTL)\]|error|exception/i.test(l)) && (!ql || l.toLowerCase().includes(ql)))
        count.textContent = `${shown.length} of ${lines.length} lines`
        pre.textContent = shown.slice(-3000).join('\n')
        pre.scrollTop = pre.scrollHeight
    }
    body.replaceChildren(h('a.pill.glass.small.srv-back', { href: '#/server/logs' }, icon('back'), ' Logs'),
        h('div.srv-users-head', h('div.srv-mono', name), count), h('div.srv-search-wrap.row', q, errBtn), pre)
    draw()
}

// ------------------------------------------------------------------ backup + database
async function backupTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let d, tasks = []
    try {
        const r = await fetch('/cove-api/admin/backups', { headers: { Authorization: api.authHeaderValue() } })
        d = await r.json(); if (!r.ok) throw new Error(d.error)
        tasks = await api.request('/ScheduledTasks').catch(() => [])
    } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const mb = n => n > 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB'
    const last = d.lastRun || []
    const failed = last.find(l => /FAILED|with FAILURES/.test(l))
    const done = last.find(l => /=== backup done/.test(l))
    const opt = tasks.find(t => t.Name === 'Optimize database')
    body.replaceChildren(
        h('div.group-label', 'Last nightly backup'),
        h('div.srv-card',
            h('div.srv-title', last[0] ? new Date(last[0].slice(0, 19).replace(' ', 'T')).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No run found',
                h('span.' + (failed ? 'srv-bad' : done ? 'srv-ok' : 'srv-bad'), failed ? 'Something failed' : done ? 'All good' : 'Didn’t finish')),
            failed ? h('div.muted.small', failed.slice(20)) : null,
            host.backupNote ? h('div.muted.small', host.backupNote) : ''),
        h('div.group-label', 'What’s saved'),
        h('div.group.srv-list', d.items.map(i => h('div.list-row',
            h('div', h('div', i.name), h('div.muted.small', i.latest ? `${mb(i.latest.size)} · ${when(i.latest.at * 1000)}` : 'no copy yet')),
            i.previous ? h('span.muted.small', 'previous ' + new Date(i.previous.at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })) : null))),
        h('div.group-label', 'Database'),
        h('div.group', h('div.list-row',
            h('div', h('div', 'Tidy the database'), h('div.muted.small', opt?.LastExecutionResult ? `Jellyfin does this on its own. Last ran ${ago(opt.LastExecutionResult.EndTimeUtc)}.` : 'Jellyfin does this on its own.')),
            opt ? h('button.pill.glass.small', { onclick: async () => {
                let watching = []
                try { watching = (await api.request('/Sessions', { query: { activeWithinSeconds: 960 } })).filter(s => s.NowPlayingItem) } catch {}
                if (watching.length) return toast(`${watching.map(w => w.UserName).join(', ')} ${watching.length === 1 ? 'is' : 'are'} watching. Try again when nobody is.`, 4000)
                try { await api.request(`/ScheduledTasks/Running/${opt.Id}`, { method: 'POST' }); toast('Tidying the database') } catch (e) { toast(e.message) }
            } }, 'Tidy Now') : null)),
        h('p.muted.small.srv-note', host.restoreNote || 'Restoring is a by-hand job for now.'))
}

// ------------------------------------------------------------------ network (shown, not edited: ports, certificates and addresses live in Docker and nginx)
// The server's name and the addresses the apps use (owner, Nov 20, 2026, Cove Server phase 2)
function addressSheet(redraw) {
    const info = api.cachedServerInfo()
    const name = h('input', { type: 'text', value: info.name || 'Cove', placeholder: 'Server name', maxlength: 40 })
    const local = h('input', { type: 'text', inputmode: 'url', value: host.addresses?.local || '', placeholder: 'At home, like http://192.168.1.20:5050', autocapitalize: 'none', spellcheck: false })
    const pub = h('input', { type: 'text', inputmode: 'url', value: host.addresses?.public || '', placeholder: 'From outside (https), optional', autocapitalize: 'none', spellcheck: false })
    const err = h('div.login-err', { role: 'alert' })
    const go = h('button.pill.white.block', { onclick: async () => {
        go.disabled = true; err.textContent = ''
        try {
            const r = await fetch('/cove-api/admin/addresses', { method: 'POST', headers: { Authorization: api.authHeaderValue(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.value, localUrl: local.value, publicUrl: pub.value }) })
            const j = await r.json(); if (!r.ok) throw new Error(j.error)
            host.addresses = j.addresses; await api.serverInfo()
            s.close(); toast('Saved'); redraw()
        } catch (e) { err.textContent = e.message; go.disabled = false }
    } }, 'Save')
    const s = sheet([h('div.form-pad', h('p.muted.small', 'The apps use these to find this server. The outside address needs HTTPS in front of Cove; Face ID sign-in works there.'),
        h('div.field-group', name, local, pub), err, go)], { title: 'Name and addresses', className: 'menu' })
}

async function networkTab(body) {
    let n = {}
    try { n = await api.request('/System/Configuration/network') } catch {}
    body.replaceChildren(
        h('div.group-label', 'Addresses'),
        h('div.srv-card',
            ...addrRows(host, true),
            h('div.srv-row', h('span'), h('span', h('button.pill.glass.small', { onclick: pairSheet }, 'Connect an app'), api.role() === 'owner' ? ' ' : '', api.role() === 'owner' ? h('button.pill.glass.small', { onclick: () => addressSheet(() => networkTab(body)) }, 'Change') : ''))),
        h('div.group-label', 'How it’s reached'),
        h('div.srv-card',
            ...(host.network || []).map(([k, v]) => row(k, v)),
            row('Password sign-in from away', 'Through Cove only (5 wrong tries = 1 min wait); Jellyfin apps use Quick Connect'),
            row('Remote connections', n.EnableRemoteAccess === false ? 'Off' : 'On'),
            row('IPv6', n.EnableIPv6 ? 'On' : 'Off')),
        h('p.muted.small.srv-note', 'Ports and certificates live in Docker and nginx, so they’re shown here, not edited. Per-person limits (streams at once, quality away from home) are on each user’s page.'))
}

// ------------------------------------------------------------------ Live TV (Jellyfin's Live TV settings + tuner status, Nov 20, 2026)
async function liveTvTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let cfg, tasks, chans
    try {
        ;[cfg, tasks, chans] = await Promise.all([api.request('/System/Configuration/livetv'), api.request('/ScheduledTasks'),
            api.request('/LiveTv/Channels', { query: { userId: api.userId(), addCurrentProgram: true, limit: 1000, enableImages: false } }).catch(() => ({ Items: [] }))])
    } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const tuner = structuredClone(cfg.TunerHosts?.[0] || null)
    const guide = cfg.ListingProviders?.[0] || null
    const rec = { sub: cfg.EnableRecordingSubfolders, nfo: cfg.SaveRecordingNFO, img: cfg.SaveRecordingImages, audio: cfg.EnableOriginalAudioWithEncodedRecordings,
        pre: Math.round((cfg.PrePaddingSeconds || 0) / 60), post: Math.round((cfg.PostPaddingSeconds || 0) / 60) }
    const show = saveBar(async () => {
        const fresh = await api.request('/System/Configuration/livetv')   // keep the guide login and anything else as it is now
        if (tuner && fresh.TunerHosts?.length) fresh.TunerHosts[0] = { ...fresh.TunerHosts[0], ...tuner }
        Object.assign(fresh, { EnableRecordingSubfolders: rec.sub, SaveRecordingNFO: rec.nfo, SaveRecordingImages: rec.img,
            EnableOriginalAudioWithEncodedRecordings: rec.audio, PrePaddingSeconds: rec.pre * 60, PostPaddingSeconds: rec.post * 60 })
        await api.request('/System/Configuration/livetv', { method: 'POST', body: fresh })
    })
    // ---- tuners, live
    const tunerBox = h('div.srv-card', h('div.muted.small', 'Checking the tuners…'))
    const drawTuners = async () => {
        if (!location.hash.startsWith('#/server/livetv')) return clearInterval(timer)
        try {
            const r = await fetch('/cove-api/admin/tuners', { headers: { Authorization: api.authHeaderValue() } }).then(x => x.json())
            if (r.error) return tunerBox.replaceChildren(h('div.srv-bad', 'Can’t reach the HDHomeRun: ' + r.error))
            const d = r.device || {}
            tunerBox.replaceChildren(
                h('div.srv-row', h('span', h('b', d.FriendlyName || 'HDHomeRun')), h('span.muted.small', `${d.ModelNumber || ''} · firmware ${d.FirmwareVersion || '?'}${d.UpgradeAvailable ? ' · update ' + d.UpgradeAvailable + ' available (HDHomeRun app)' : ''}`)),
                ...r.tuners.map((t, i) => h('div.srv-row',
                    h('span', `Tuner ${i + 1}`),
                    t.VctNumber
                        ? h('span', h('span.lt-rec'), ` ${t.VctNumber} ${t.VctName || ''}`, h('span.muted.small', ` · signal ${t.SignalStrengthPercent ?? '?'}% · quality ${t.SignalQualityPercent ?? '?'}%${t.TargetIP ? ' · to ' + t.TargetIP : ''}`))
                        : h('span.muted', 'Free'))),
                h('p.muted.small', 'Shared with Emby. Updates every 5 seconds.'))
        } catch (e) { tunerBox.replaceChildren(h('div.srv-bad', e.message)) }
    }
    drawTuners(); clearInterval(timer); timer = setInterval(drawTuners, 5000)
    // ---- guide
    const refreshTask = tasks.find(t => t.Key === 'RefreshGuide')
    const last = refreshTask?.LastExecutionResult
    const items = chans.Items || []
    const withGuide = items.filter(c => c.CurrentProgram).length
    const runBtn = h('button.pill.glass.small', { onclick: async () => {
        if (!refreshTask) return
        runBtn.disabled = true
        try { await api.request(`/ScheduledTasks/Running/${refreshTask.Id}`, { method: 'POST' }); toast('Downloading the guide. Takes a few minutes.') } catch (e) { toast(e.message) }
        setTimeout(() => runBtn.disabled = false, 8000)
    } }, 'Refresh Guide')
    const jfLive = (host.jellyfinDirect || '') + '/web/#/dashboard/livetv'
    body.replaceChildren(
        h('div.group-label', 'Tuners right now'), tunerBox,
        h('div.group-label', 'Tuner settings'),
        tuner ? h('div.group',
            h('div.list-row', h('div', h('div', tuner.FriendlyName || 'Tuner'), h('div.muted.small', `${tuner.Url} · ${tuner.TunerCount} tuners · ${items.length} channels`))),
            swRow(tuner, 'AllowHWTranscoding', 'Convert on the 4090 when needed', 'Antenna video is MPEG-2, so browsers always need this', show),
            swRow(tuner, 'AllowStreamSharing', 'Share a tuner', 'Two people on the same channel use one tuner', show),
            swRow(tuner, 'ImportFavoritesOnly', 'Only the HDHomeRun’s favorite channels', 'Favorites are set in the HDHomeRun app', show),
            swRow(tuner, 'IgnoreDts', 'Ignore broadcast timestamps', 'Helps with stutter on some stations', show),
            swRow(tuner, 'ReadAtNativeFramerate', 'Read at native frame rate', 'Off for antenna tuners', show),
            swRow(tuner, 'EnableStreamLooping', 'Loop the stream', 'Only for M3U sources that end', show),
            swRow(tuner, 'AllowFmp4TranscodingContainer', 'Allow fMP4 when converting', 'Keep off: Cove’s live player expects TS', show),
            numRow(tuner, 'TunerCount', 'Tuners', null, show),
            selectRow(tuner, 'FallbackMaxStreamingBitrate', 'Quality when a device doesn’t say', [[8000000, '8 Mbps'], [15000000, '15 Mbps'], [30000000, '30 Mbps'], [60000000, '60 Mbps']], null, show, v => +v))
            : h('p.muted.srv-empty', 'No tuner set up.'),
        h('div.group-label', 'Guide'),
        h('div.group',
            guide ? h('div.list-row', h('div', h('div', guide.Type === 'SchedulesDirect' ? 'Schedules Direct' : guide.Type),
                h('div.muted.small', `${guide.ListingsId || ''} · zip ${guide.ZipCode || '?'} · ${guide.EnableAllTuners ? 'all tuners' : 'some tuners'}`))) : h('div.list-row', h('div.muted', 'No guide source yet')),
            h('div.list-row', h('div', h('div', `${withGuide} of ${items.length} channels have listings`),
                h('div.muted.small', last ? `Last download ${new Date(last.EndTimeUtc).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ${last.Status}` : 'Not downloaded yet')), runBtn),
            h('a.list-row', { href: jfLive, target: '_blank', rel: 'noopener' }, h('div', h('div', 'Change the login, lineup or channel matching'), h('div.muted.small', 'In Jellyfin’s dashboard (home network only), since it needs the Schedules Direct password')), icon('chevron'))),
        h('div.group-label', 'Recording'),
        h('div.group',
            h('div.list-row', h('div', h('div', 'Saved to'), h('div.muted.small', (host.recordingsLabel ? host.recordingsLabel + ' (' : '') + (cfg.RecordingPath || '/recordings') + (host.recordingsLabel ? ' inside Jellyfin)' : ' inside Jellyfin')))),
            numRow(rec, 'pre', 'Start early', 'min', show),
            numRow(rec, 'post', 'Keep going after', 'min', show),
            swRow(rec, 'sub', 'A folder per show', null, show),
            swRow(rec, 'nfo', 'Save info files (.nfo)', null, show),
            swRow(rec, 'img', 'Save artwork', null, show),
            swRow(rec, 'audio', 'Keep the original audio when converting', null, show),
            h('div.list-row', h('div', h('div', 'Who can record'), h('div.muted.small', 'Per person: Users → their page → Manage Live TV recordings')), h('a.pill.glass.small', { href: '#/server/users' }, 'Users'))),
        h('p.muted.small.srv-note', 'Watching and the guide are in the Live TV tab. Recordings follow Jellyfin’s own rules; Cove only shows them.'),
        h('div.srv-save-space'))
}

const textRow = (obj, key, label, note, changed, placeholder = '') => {
    const i = h('input.srv-text', { value: obj[key] ?? '', placeholder, oninput: () => { obj[key] = i.value; changed() } })
    return h('div.list-row.srv-sw', h('div', h('div', label), note ? h('div.muted.small', note) : null), i)
}
const areaRow = (obj, key, label, note, changed) => {
    const t = h('textarea.text-input.srv-area', { rows: 6, spellcheck: false, oninput: () => { obj[key] = t.value; changed() } })
    t.value = obj[key] ?? ''
    return h('div.list-row.srv-col', h('div', h('div', label), note ? h('div.muted.small', note) : null), t)
}
// several Jellyfin config sections, each re-read fresh at save time so only the fields shown here change
function multiSave(parts) {
    return saveBar(async () => {
        for (const [path, obj, keys] of parts) {
            const fresh = await api.request(path)
            const patch = Object.fromEntries(keys.map(k => [k, obj[k]]))
            await api.request(path, { method: 'POST', body: { ...fresh, ...patch } })
        }
    })
}

// ---------------- General (Jellyfin: Dashboard → General, Branding, Metadata, NFO)
async function generalTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let sys, brand, meta, nfo, langs, countries
    try {
        ;[sys, brand, meta, nfo, langs, countries] = await Promise.all([api.request('/System/Configuration'), api.request('/System/Configuration/branding'),
            api.request('/System/Configuration/metadata'), api.request('/System/Configuration/xbmcmetadata'),
            api.request('/Localization/Cultures'), api.request('/Localization/Countries')])
    } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const S = structuredClone(sys), B = structuredClone(brand), M = structuredClone(meta), N = structuredClone(nfo)
    const SK = ['ServerName', 'UICulture', 'PreferredMetadataLanguage', 'MetadataCountryCode', 'QuickConnectAvailable', 'EnableFolderView',
        'EnableGroupingMoviesIntoCollections', 'EnableGroupingShowsIntoCollections', 'DisplaySpecialsWithinSeasons', 'EnableExternalContentInSuggestions',
        'SaveMetadataHidden', 'ImageSavingConvention', 'LibraryMonitorDelay', 'LibraryUpdateDuration', 'LibraryScanFanoutConcurrency',
        'LibraryMetadataRefreshConcurrency', 'ParallelImageEncodingLimit', 'ChapterImageResolution', 'DummyChapterDuration', 'ImageExtractionTimeoutMs',
        'ActivityLogRetentionDays', 'LogFileRetentionDays', 'EnableSlowResponseWarning', 'SlowResponseThresholdMs', 'AllowClientLogUpload', 'CacheSize']
    const show = multiSave([['/System/Configuration', S, SK], ['/System/Configuration/branding', B, ['LoginDisclaimer', 'CustomCss', 'SplashscreenEnabled']],
        ['/System/Configuration/metadata', M, ['UseFileCreationTimeForDateAdded']],
        ['/System/Configuration/xbmcmetadata', N, ['ReleaseDateFormat', 'SaveImagePathsInNfo', 'EnablePathSubstitution', 'EnableExtraThumbsDuplication']]])
    const partsBox = h('div.parts-box')
    drawServices(partsBox)
    const langOpts = langs.filter(l => l.TwoLetterISOLanguageName).map(l => [l.TwoLetterISOLanguageName, l.DisplayName]).sort((a, b) => a[1].localeCompare(b[1]))
    const countryOpts = countries.map(c => [c.TwoLetterISORegionName, c.DisplayName]).sort((a, b) => a[1].localeCompare(b[1]))
    const uiOpts = [['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['es', 'Spanish'], ['es-MX', 'Spanish (Mexico)'], ['zh-CN', 'Chinese (Simplified)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['fr', 'French'], ['de', 'German']]
    const cores = [[0, 'Automatic'], [1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']]
    body.replaceChildren(
        partsBox,
        h('div.group-label', 'Server'),
        h('div.group',
            textRow(S, 'ServerName', 'Server name', 'Shown in Jellyfin’s apps', show),
            selectRow(S, 'UICulture', 'Jellyfin’s own language', uiOpts, 'For Jellyfin’s dashboard and messages', show),
            swRow(S, 'QuickConnectAvailable', 'Quick Connect (sign in with a code)', 'Cove’s code sign-in and the Jellyfin apps need this', show)),
        h('div.group-label', 'Info about movies and shows'),
        h('div.group',
            selectRow(S, 'PreferredMetadataLanguage', 'Language', langOpts, 'Titles and descriptions from the internet', show),
            selectRow(S, 'MetadataCountryCode', 'Country', countryOpts, 'Which ratings (PG-13, TV-14…)', show),
            swRow(M, 'UseFileCreationTimeForDateAdded', '“Date added” = when the file was made', 'Off = when Jellyfin first saw it', show),
            swRow(S, 'SaveMetadataHidden', 'Hide saved info files', null, show),
            selectRow(S, 'ImageSavingConvention', 'Artwork file names', [['Legacy', 'Legacy (poster.jpg…)'], ['Compatible', 'Compatible (Kodi/Emby)']], null, show)),
        h('div.group-label', 'Info files (.nfo)'),
        h('div.group',
            textRow(N, 'ReleaseDateFormat', 'Date format', null, show, 'yyyy-MM-dd'),
            swRow(N, 'SaveImagePathsInNfo', 'Save artwork paths in .nfo', null, show),
            swRow(N, 'EnablePathSubstitution', 'Use path substitution', null, show),
            swRow(N, 'EnableExtraThumbsDuplication', 'Copy extrafanart into extrathumbs', null, show)),
        h('div.group-label', 'Browsing in Jellyfin’s apps'),
        h('div.group',
            swRow(S, 'EnableFolderView', 'Show a Folders view', null, show),
            swRow(S, 'EnableGroupingMoviesIntoCollections', 'Group movies into collections', 'In movie lists', show),
            swRow(S, 'EnableGroupingShowsIntoCollections', 'Group shows into collections', null, show),
            swRow(S, 'DisplaySpecialsWithinSeasons', 'Show specials inside the season they aired in', null, show),
            swRow(S, 'EnableExternalContentInSuggestions', 'Suggest things from other sources', 'Like Live TV in suggestions', show)),
        h('div.group-label', 'Library scans'),
        h('div.group',
            numRow(S, 'LibraryMonitorDelay', 'Wait after a file changes', 'sec', show),
            numRow(S, 'LibraryUpdateDuration', 'Group library updates for', 'sec', show),
            selectRow(S, 'LibraryScanFanoutConcurrency', 'Scan at once', cores, null, show, v => +v),
            selectRow(S, 'LibraryMetadataRefreshConcurrency', 'Info refreshes at once', cores, null, show, v => +v),
            selectRow(S, 'ParallelImageEncodingLimit', 'Image jobs at once', cores, null, show, v => +v),
            selectRow(S, 'ChapterImageResolution', 'Chapter picture size', [['MatchSource', 'Same as the video'], ['P2160', '2160p'], ['P1440', '1440p'], ['P1080', '1080p'], ['P720', '720p'], ['P480', '480p'], ['P360', '360p'], ['P240', '240p'], ['P144', '144p']], null, show),
            numRow(S, 'DummyChapterDuration', 'Make chapters every', 'sec (0 = off)', show),
            numRow(S, 'ImageExtractionTimeoutMs', 'Give up on a picture after', 'ms (0 = default)', show),
            numRow(S, 'CacheSize', 'Cache size', 'items', show)),
        h('div.group-label', 'Logs'),
        h('div.group',
            numRow(S, 'ActivityLogRetentionDays', 'Keep the activity list', 'days', show),
            numRow(S, 'LogFileRetentionDays', 'Keep log files', 'days', show),
            swRow(S, 'AllowClientLogUpload', 'Let apps send their logs', null, show),
            swRow(S, 'EnableSlowResponseWarning', 'Warn about slow responses', null, show),
            numRow(S, 'SlowResponseThresholdMs', 'Slow means over', 'ms', show)),
        h('div.group-label', 'Branding (Jellyfin’s own apps)'),
        h('div.group',
            textRow(B, 'LoginDisclaimer', 'Message on the sign-in screen', null, show),
            swRow(B, 'SplashscreenEnabled', 'Splash screen', null, show),
            areaRow(B, 'CustomCss', 'Custom CSS', 'ElegantFin lives here. Careful: this changes how every Jellyfin app looks.', show)),
        h('div.group-label', 'Where things live'),
        h('div.srv-card',
            ...(host.paths || []).map(([k, v]) => row(k, v))),
        h('p.muted.small.srv-note', 'Folder locations are set in Docker, so they’re shown here, not edited. Plugin repositories are under Plugins.'),
        h('div.srv-save-space'))
}

// ---------------- Playback (Jellyfin: Resume, Streaming, Trickplay)
async function playbackTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let sys
    try { sys = await api.request('/System/Configuration') } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const S = structuredClone(sys), T = S.TrickplayOptions
    const lim = { mbps: S.RemoteClientBitrateLimit ? Math.round(S.RemoteClientBitrateLimit / 1e6) : 0 }
    const width = { w: (T.WidthResolutions || [320])[0] }
    const show = saveBar(async () => {
        const fresh = await api.request('/System/Configuration')
        await api.request('/System/Configuration', { method: 'POST', body: { ...fresh,
            MinResumePct: S.MinResumePct, MaxResumePct: S.MaxResumePct, MinResumeDurationSeconds: S.MinResumeDurationSeconds,
            MinAudiobookResume: S.MinAudiobookResume, MaxAudiobookResume: S.MaxAudiobookResume,
            RemoteClientBitrateLimit: Math.round(lim.mbps * 1e6), TrickplayOptions: { ...fresh.TrickplayOptions, ...T, WidthResolutions: [+width.w] } } })
    })
    body.replaceChildren(
        h('div.group-label', 'Resume'),
        h('div.group',
            numRow(S, 'MinResumePct', 'Counts as not started before', '%', show),
            numRow(S, 'MaxResumePct', 'Counts as watched after', '%', show),
            numRow(S, 'MinResumeDurationSeconds', 'Shortest video that can be resumed', 'sec', show),
            numRow(S, 'MinAudiobookResume', 'Audiobooks: not started before', 'min', show),
            numRow(S, 'MaxAudiobookResume', 'Audiobooks: finished with less than', 'min left', show)),
        h('div.group-label', 'Streaming'),
        h('div.group',
            numRow(lim, 'mbps', 'Quality limit for everyone away from home', 'Mbps (0 = none)', show),
            h('div.list-row', h('div.muted.small', 'Per-person limits are on each user’s page. Cove’s own away-from-home quality is per device.'))),
        h('div.group-label', 'Scrub previews (trickplay)'),
        h('div.group',
            h('div.list-row', h('div', h('div', 'Turned on per library'), h('div.muted.small', 'Libraries → a library → Preview pictures while scrubbing')), h('a.pill.glass.small', { href: '#/server/libraries' }, 'Libraries')),
            swRow(T, 'EnableHwAcceleration', 'Decode on the 4090', null, show),
            swRow(T, 'EnableHwEncoding', 'Make the pictures on the 4090', null, show),
            swRow(T, 'EnableKeyFrameOnlyExtraction', 'Key frames only', 'Much faster, a little less exact', show),
            selectRow(T, 'ScanBehavior', 'During library scans', [['NonBlocking', 'Keep scanning, make them after'], ['Blocking', 'Wait for them']], null, show),
            selectRow(T, 'ProcessPriority', 'Priority', [['Idle', 'Idle'], ['BelowNormal', 'Below normal'], ['Normal', 'Normal'], ['AboveNormal', 'Above normal'], ['High', 'High']], null, show),
            numRow(T, 'Interval', 'One picture every', 'ms', show),
            selectRow(width, 'w', 'Picture width', [[240, '240 px'], [320, '320 px'], [480, '480 px'], [640, '640 px']], null, show, v => +v),
            numRow(T, 'TileWidth', 'Pictures per row in a sheet', null, show),
            numRow(T, 'TileHeight', 'Rows per sheet', null, show),
            numRow(T, 'Qscale', 'Quality (2 best, 31 worst)', null, show),
            numRow(T, 'JpegQuality', 'JPEG quality', '%', show),
            numRow(T, 'ProcessThreads', 'Threads', null, show)),
        h('p.muted.small.srv-note', 'Transcoding settings are in the Transcoding tab.'),
        h('div.srv-save-space'))
}

// ---------------- Activity (Jellyfin: Dashboard → Activity)
async function activityTab(body, start = 0) {
    const per = 50
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    let d, users = []
    const onlyPeople = new URLSearchParams(location.hash.split('?')[1] || '').get('people') === '1'
    try {
        ;[d, users] = await Promise.all([api.request('/System/ActivityLog/Entries', { query: { startIndex: start, limit: per, ...(onlyPeople ? { hasUserId: true } : {}) } }), api.request('/Users').catch(() => [])])
    } catch (e) { return body.replaceChildren(h('p.muted.srv-empty', e.message)) }
    const name = id => users.find(u => u.Id === id)?.Name
    const sev = s => s === 'Error' ? '.srv-bad' : s === 'Warning' ? '.srv-warn' : ''
    body.replaceChildren(
        h('div.srv-users-head',
            h('div.ss-seg', h('button' + (onlyPeople ? '' : '.on'), { onclick: () => { location.hash = '#/server/activity' } }, 'Everything'),
                h('button' + (onlyPeople ? '.on' : ''), { onclick: () => { location.hash = '#/server/activity?people=1' } }, 'People only')),
            h('span.muted.small', `${d.TotalRecordCount} entries`)),
        h('div.group.srv-list', (d.Items || []).map(e => h('div.list-row',
            h('div', h('div' + sev(e.Severity), e.Name), h('div.muted.small', [when(e.Date), e.ShortOverview, e.Type, name(e.UserId) && !e.Name.includes(name(e.UserId)) ? name(e.UserId) : null].filter(Boolean).join(' · ')))))),
        h('div.srv-pager',
            start > 0 ? h('button.pill.glass.small', { onclick: () => activityTab(body, Math.max(0, start - per)) }, 'Newer') : null,
            h('span.muted.small', `${start + 1}–${Math.min(start + per, d.TotalRecordCount)}`),
            start + per < d.TotalRecordCount ? h('button.pill.glass.small', { onclick: () => activityTab(body, start + per) }, 'Older') : null))
}

// "admins can approve movie requests... another page for requests? or something on here to automatically approve?")
const seerrGet = async path => {
    const r = await fetch('/cove-api' + path, { headers: { Authorization: api.authHeaderValue() } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || r.status)
    return d
}
async function requestsTab(body) {
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    const pend = h('div'), auto = h('div'), all = h('div')
    const reqLine = r => [r.by, r.mediaType === 'tv' ? (r.seasons?.length ? 'Seasons ' + r.seasons.join(', ') : 'Show') : 'Movie', r.is4k ? '4K' : null].filter(Boolean).join(' · ')
    const poster = r => r.poster ? h('img.srv-req-art', { src: r.poster, alt: '', loading: 'lazy' }) : h('div.srv-req-art')
    const drawPending = async () => {
        let d
        try { d = await seerrGet('/seerr/pending') } catch (e) { return pend.replaceChildren(h('p.muted.srv-empty', e.message)) }
        pend.replaceChildren(h('div.group-label', `Waiting for your OK (${d.requests.length})`),
            d.requests.length ? h('div.group.srv-list', d.requests.map(r => h('div.list-row', poster(r),
                h('div', { style: { flex: '1' } }, h('div', r.title || 'Unknown'), h('div.muted.small', reqLine(r) + ' · ' + when(r.added))),
                h('button.pill.white.small', { onclick: () => decide(r.id, true) }, icon('check'), ' Approve'),
                h('button.pill.glass.small', { onclick: () => decide(r.id, false) }, 'Decline'))))
                : h('p.muted.srv-empty', 'Nothing waiting.'))
    }
    const decide = async (id, approve) => {
        try { await api.helper('/seerr/decide', { id, approve }); toast(approve ? 'Approved. It’ll download now.' : 'Declined'); drawPending(); drawAll() }
        catch (e) { toast('Couldn’t do that: ' + e.message) }
    }
    const drawAuto = async () => {
        let d
        try { d = await seerrGet('/seerr/autoapprove') } catch (e) { return auto.replaceChildren(h('p.muted.srv-empty', e.message)) }
        const chips = (who, f) => h('span.srv-aa', [['movie', 'Movies'], ['tv', 'Shows'], ['fourk', '4K']].map(([k, label]) => {
            const b = h('button.srv-check' + (f[k] ? '.on' : ''), { onclick: async () => {
                const next = { movie: f.movie, tv: f.tv, fourk: f.fourk, [k]: !f[k] }
                b.disabled = true
                try { await api.helper('/seerr/autoapprove', { id: who, ...next }); Object.assign(f, next); toast('Saved') } catch (e) { toast(e.message) }
                drawAuto()
            } }, h('span.srv-box', f[k] ? icon('check') : null), label)
            return b
        }))
        auto.replaceChildren(h('div.group-label', 'Approve automatically'),
            h('div.group.srv-list',
                h('div.list-row', h('div', { style: { flex: '1' } }, h('div', 'New people'), h('div.muted.small', 'What anyone added later starts with')), chips('default', d.default)),
                ...d.users.map(u => h('div.list-row', h('div', { style: { flex: '1' } }, h('div', u.name), u.admin ? h('div.muted.small', 'Admin: always approved') : null),
                    u.admin ? h('span.muted.small', 'Always') : chips(u.id, u)))),
            h('p.muted.small.srv-note', 'Uses Seerr’s own settings, so it also counts for requests made on Seerr’s own site. Owners and admins never wait. Kids and teens can’t request at all.'))
    }
    const drawAll = async () => {
        let d
        try { d = await seerrGet('/seerr/requests?all=1') } catch (e) { return all.replaceChildren(h('p.muted.srv-empty', e.message)) }
        all.replaceChildren(h('div.group-label', 'Everyone’s requests'),
            h('div.group.srv-list', d.requests.map(r => h('div.list-row', poster(r),
                h('div', { style: { flex: '1' } }, h('div', r.title || 'Unknown'), h('div.muted.small', reqLine(r) + ' · ' + when(r.added)),
                    r.progress?.length ? h('div.lt-bar', h('div', { style: { width: r.progress[0].pct + '%' } })) : null),
                h('span.srv-req-state.' + (r.status === 'here' ? 'ok' : r.request === 'declined' ? 'bad' : 'wait'),
                    r.status === 'here' ? 'Here' : r.request === 'waiting for approval' ? 'Waiting' : r.request === 'declined' ? 'Declined' : r.progress?.length ? `Downloading ${r.progress[0].pct}%` : r.status === 'partly here' ? 'Partly here' : 'On the way')))))
    }
    body.replaceChildren(pend, auto, all)
    await Promise.all([drawPending(), drawAuto(), drawAll()])
    clearInterval(timer)
    timer = setInterval(() => { if (!location.hash.startsWith('#/server/requests')) return clearInterval(timer); drawPending(); drawAll() }, 20000)
}
