// Live TV: On Now, Guide, Recordings. Antenna (HDHomeRun) + Schedules Direct guide in Jellyfin (Nov 20, 2026).
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'

const HOUR_PX = () => innerWidth < 700 ? 200 : 300
const SHOPPING = /^(QVC|HSN|ShopLC|Jewelry|ShopHQ|JTV|Shop)/i
let canRecord = null, timer = null

const pref = (k, d) => { try { return JSON.parse(localStorage.getItem('cove.live.' + k)) ?? d } catch { return d } }
const setPref = (k, v) => { try { localStorage.setItem('cove.live.' + k, JSON.stringify(v)) } catch {} }
const tm = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = d => {
    const x = new Date(d), t = new Date()
    const same = (a, b) => a.toDateString() === b.toDateString()
    if (same(x, t)) return 'Today'
    if (same(x, new Date(t.getTime() + 864e5))) return 'Tomorrow'
    return x.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
const num = c => parseFloat(c.ChannelNumber || c.Number || 0) || 0
const epLine = p => [p.ParentIndexNumber && p.IndexNumber ? `S${p.ParentIndexNumber} E${p.IndexNumber}` : null, p.EpisodeTitle].filter(Boolean).join(' · ')

async function loadChannels() {
    const d = await api.request('/LiveTv/Channels', { query: { userId: api.userId(), addCurrentProgram: true, enableImages: true, limit: 1000, fields: 'Overview' } })
    return (d.Items || []).sort((a, b) => num(a) - num(b))
}
async function mayRecord() {
    if (canRecord != null) return canRecord
    try { canRecord = !!(await api.request('/Users/Me')).Policy?.EnableLiveTvManagement } catch { canRecord = false }
    return canRecord
}

export async function liveTvPage(main, tab = 'now') {
    clearInterval(timer)
    const tabs = [['now', 'On Now'], ['guide', 'Guide'], ['recordings', 'Recordings']]
    const body = h('div.lt-body')
    const hideShop = pref('hideShop', true)
    const shopBtn = h('button.pill.glass.small', { onclick: () => { setPref('hideShop', !pref('hideShop', true)); liveTvPage(main, tab) } }, hideShop ? 'Show shopping' : 'Hide shopping')
    main.replaceChildren(
        h('header.page-head', h('h1', 'Live TV')),
        h('div.seg-row', h('div.seg', tabs.map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => location.hash = '#/livetv/' + k }, l))), tab !== 'recordings' ? shopBtn : null),
        body)
    body.replaceChildren(h('div.loading-page', h('div.spinner')))
    try {
        if (tab === 'guide') await guide(body)
        else if (tab === 'recordings') await recordings(body)
        else { await onNow(body); timer = setInterval(() => { if (location.hash.startsWith('#/livetv') && !location.hash.includes('/guide') && !location.hash.includes('/recordings')) onNow(body, true) ; else clearInterval(timer) }, 60_000) }
    } catch (e) { body.replaceChildren(h('p.muted.srv-empty', e.message)) }
}
const visible = chs => pref('hideShop', true) ? chs.filter(c => !SHOPPING.test(c.Name)) : chs

// ------------------------------------------------------------------ On Now
async function onNow(body, quiet) {
    const chs = visible(await loadChannels())
    if (!chs.length) return body.replaceChildren(h('p.muted.srv-empty', 'No channels yet.'))
    const now = Date.now()
    body.replaceChildren(h('div.lt-now', chs.map(c => {
        const p = c.CurrentProgram
        const pct = p ? Math.max(0, Math.min(100, (now - new Date(p.StartDate)) / (new Date(p.EndDate) - new Date(p.StartDate)) * 100)) : 0
        const logo = api.img(c, 'Primary', { h: 80 })
        return h('button.lt-card', { onclick: () => location.hash = '#/play/' + c.Id, 'aria-label': `Watch ${c.Name}` },
            h('div.lt-logo', logo ? h('img', { src: logo, alt: '', loading: 'lazy' }) : h('span', c.Name)),
            h('div.lt-info',
                h('div.lt-ch', h('span.lt-num', c.ChannelNumber || c.Number), ' ', c.Name, p?.TimerId ? h('span.lt-rec', { 'aria-label': 'Recording' }) : null),
                h('div.lt-prog', p?.Name || 'No guide info'),
                p ? h('div.muted.small', `${tm(p.StartDate)} to ${tm(p.EndDate)}${epLine(p) ? ' · ' + epLine(p) : ''}`) : null,
                p ? h('div.lt-bar', h('div', { style: { width: pct + '%' } })) : null),
            p ? h('span.icon-btn.lt-more', { onclick: e => { e.stopPropagation(); programSheet(p, c) }, 'aria-label': 'Details' }, icon('info')) : null)
    })))
}

// ------------------------------------------------------------------ Guide
async function guide(body) {
    const px = HOUR_PX(), start = new Date(Math.floor(Date.now() / 18e5) * 18e5), hours = 6
    const end = new Date(start.getTime() + hours * 36e5)
    const [all, progs] = await Promise.all([loadChannels(), api.request('/LiveTv/Programs', { query: {
        userId: api.userId(), minEndDate: start.toISOString(), maxStartDate: end.toISOString(), sortBy: 'StartDate', fields: 'Overview', enableImages: false, limit: 5000 } })])
    const chs = visible(all)
    const by = new Map(chs.map(c => [c.Id, []]))
    for (const p of progs.Items || []) by.get(p.ChannelId)?.push(p)
    const x = d => Math.max(0, (new Date(d) - start) / 36e5 * px)
    const slots = Array.from({ length: hours * 2 }, (_, i) => new Date(start.getTime() + i * 18e5))
    const nowLine = h('div.lt-nowline', { style: { left: x(new Date()) + 'px' } })
    const grid = h('div.lt-grid', { style: { '--w': hours * px + 'px' } },
        h('div.lt-times', h('div.lt-corner', day(start)), h('div.lt-track', slots.map(s => h('div.lt-slot', { style: { left: x(s) + 'px', width: px / 2 + 'px' } }, tm(s))))),
        chs.map(c => {
            const logo = api.img(c, 'Primary', { h: 60 })
            return h('div.lt-row',
                h('button.lt-chan', { onclick: () => location.hash = '#/play/' + c.Id, 'aria-label': `Watch ${c.Name}` },
                    logo ? h('img', { src: logo, alt: '', loading: 'lazy' }) : null, h('span', h('b', c.ChannelNumber || c.Number), h('span.muted.small', c.Name))),
                h('div.lt-track', by.get(c.Id).map(p => {
                    const l = x(p.StartDate), w = Math.min(x(p.EndDate), hours * px) - l
                    if (w < 2) return null
                    const airing = new Date(p.StartDate) <= new Date() && new Date(p.EndDate) > new Date()
                    return h('button.lt-p' + (airing ? '.on' : '') + (p.TimerId ? '.rec' : ''), { style: { left: l + 'px', width: w + 'px' }, onclick: () => programSheet(p, c) },
                        h('span.lt-p-t', p.Name), w > 120 ? h('span.lt-p-s', epLine(p) || `${tm(p.StartDate)} to ${tm(p.EndDate)}`) : null)
                })))
        }), nowLine)
    body.replaceChildren(h('div.lt-scroll', grid))
}

// ------------------------------------------------------------------ program details + recording
async function programSheet(p, c) {
    const rec = await mayRecord()
    const airing = new Date(p.StartDate) <= new Date() && new Date(p.EndDate) > new Date()
    const done = new Date(p.EndDate) <= new Date()
    const actions = h('div.lt-actions')
    const s = sheet(h('div.lt-sheet',
        h('div.muted.small', `${day(p.StartDate)} · ${tm(p.StartDate)} to ${tm(p.EndDate)} · ${c?.ChannelNumber || ''} ${c?.Name || p.ChannelName || ''}`),
        epLine(p) ? h('div.lt-ep', epLine(p)) : null,
        p.Overview ? h('p.lt-ov', p.Overview) : null,
        h('div.muted.small', [p.OfficialRating, p.IsNew ? 'New' : null, p.IsLive ? 'Live' : null, p.IsMovie ? 'Movie' : null, p.IsSports ? 'Sports' : null].filter(Boolean).join(' · ')),
        actions), { title: p.Name })
    const draw = () => actions.replaceChildren(
        airing ? h('button.pill.white', { onclick: () => { s.close(); location.hash = '#/play/' + p.ChannelId } }, icon('play'), ' Watch Now') : null,
        rec && !done ? (p.TimerId
            ? h('button.pill.glass', { onclick: () => act(() => api.request('/LiveTv/Timers/' + p.TimerId, { method: 'DELETE' }), 'Recording canceled', () => { p.TimerId = null }) }, 'Cancel Recording')
            : h('button.pill.glass', { onclick: () => act(async () => {
                const d = await api.request('/LiveTv/Timers/Defaults', { query: { programId: p.Id } })
                await api.request('/LiveTv/Timers', { method: 'POST', body: d })
            }, 'Will record', () => { p.TimerId = 'new' }) }, h('span.lt-dot'), ' Record')) : null,
        rec && p.IsSeries ? (p.SeriesTimerId
            ? h('button.pill.glass', { onclick: () => act(() => api.request('/LiveTv/SeriesTimers/' + p.SeriesTimerId, { method: 'DELETE' }), 'Series recording canceled', () => { p.SeriesTimerId = null }) }, 'Cancel Series')
            : h('button.pill.glass', { onclick: () => act(async () => {
                const d = await api.request('/LiveTv/Timers/Defaults', { query: { programId: p.Id } })
                await api.request('/LiveTv/SeriesTimers', { method: 'POST', body: { ...d, RecordAnyChannel: false, RecordAnyTime: true, RecordNewOnly: true, SkipEpisodesInLibrary: true, KeepUpTo: 0 } })
            }, 'Recording new episodes', () => { p.SeriesTimerId = 'new'; p.TimerId = p.TimerId || 'new' }) }, 'Record Series')) : null)
    async function act(fn, ok, after) {
        actions.querySelectorAll('button').forEach(b => b.disabled = true)
        try { await fn(); after(); toast(ok) } catch (e) { toast(e.message) }
        draw()
    }
    draw()
}

// ------------------------------------------------------------------ Recordings
async function recordings(body) {
    const rec = await mayRecord()
    const [recs, timers, series] = await Promise.all([
        api.request('/LiveTv/Recordings', { query: { userId: api.userId(), fields: 'Overview', enableImages: true, limit: 200 } }).then(d => d.Items || []),
        rec ? api.request('/LiveTv/Timers', { query: { isActive: false } }).then(d => d.Items || []).catch(() => []) : [],
        rec ? api.request('/LiveTv/SeriesTimers').then(d => d.Items || []).catch(() => []) : []])
    const active = rec ? await api.request('/LiveTv/Timers', { query: { isActive: true } }).then(d => d.Items || []).catch(() => []) : []
    const cancel = (path, label) => async btn => {
        btn.disabled = true
        try { await api.request(path, { method: 'DELETE' }); toast(label); recordings(body) } catch (e) { toast(e.message); btn.disabled = false }
    }
    const btn = (label, fn) => { const b = h('button.pill.glass.small', { onclick: () => fn(b) }, label); return b }
    body.replaceChildren(...[
        active.length ? [h('div.group-label', 'Recording now'), h('div.group', active.map(t => h('div.list-row',
            h('div', h('div', h('span.lt-rec'), ' ', t.Name), h('div.muted.small', `${t.ChannelName} · until ${tm(t.EndDate)}`)),
            btn('Stop', cancel('/LiveTv/Timers/' + t.Id, 'Stopped')))))] : null,
        h('div.group-label', 'Recorded'),
        recs.length ? h('div.group', recs.map(r => h('a.list-row', { href: '#/play/' + r.Id },
            h('div', h('div', r.SeriesName || r.Name), h('div.muted.small', [r.SeriesName ? r.EpisodeTitle || r.Name : null, r.StartDate ? `${day(r.StartDate)} ${tm(r.StartDate)}` : null, r.ChannelName].filter(Boolean).join(' · '))),
            icon('play'))))
            : h('p.muted.srv-empty', rec ? 'Nothing recorded yet. Tap a show in the Guide, then Record.' : 'Nothing recorded yet.'),
        rec ? [h('div.group-label', 'Coming up'),
            timers.filter(t => t.Status !== 'InProgress').length ? h('div.group', timers.filter(t => t.Status !== 'InProgress').map(t => h('div.list-row',
                h('div', h('div', t.Name), h('div.muted.small', `${day(t.StartDate)} ${tm(t.StartDate)} · ${t.ChannelName}`)),
                btn('Cancel', cancel('/LiveTv/Timers/' + t.Id, 'Canceled')))))
                : h('p.muted.srv-empty', 'Nothing scheduled.'),
            h('div.group-label', 'Series'),
            series.length ? h('div.group', series.map(t => h('div.list-row',
                h('div', h('div', t.Name), h('div.muted.small', [t.RecordNewOnly ? 'New episodes' : 'All episodes', t.RecordAnyChannel ? 'any channel' : t.ChannelName].filter(Boolean).join(' · '))),
                btn('Cancel', cancel('/LiveTv/SeriesTimers/' + t.Id, 'Series canceled')))))
                : h('p.muted.srv-empty', 'No series recordings.'),
            h('p.muted.small.lt-foot', 'Saved on the server. Starts 1 minute early, runs 3 minutes late.')] : null].flat(Infinity).filter(Boolean))
}
