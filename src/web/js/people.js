// People (owner; admins can look): everyone who can sign in to Cove, their level, setup, passwords, Emby history.
// The email is only their sign-in name; nobody is emailed. Levels: owner, admin, member, teen (Kids + Teens tags),
// kid (Kids tag only).
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'
import { markTile, PART_NAMES } from './marks.js'

const LEVELS = [['admin', 'Admin', 'Everything; requests go through right away'], ['member', 'Member', 'Everything; requests wait for your OK'],
    ['teen', 'Teen', 'Only titles tagged Kids or Teens; no requests'], ['kid', 'Kid', 'Only titles tagged Kids; no requests']]
const label = r => ({ owner: 'Owner', admin: 'Admin', member: 'Member', teen: 'Teen', kid: 'Kid' }[r] || r)

async function call(path, body) {
    const r = await fetch('/cove-api/people' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: api.authHeaderValue() }, body: JSON.stringify(body) }
        : { headers: { Authorization: api.authHeaderValue() } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `failed (${r.status})`)
    return d
}

// Users tab of Server (Nov 19, 2026: People merged into Users): the same cards, plus Edit for the Emby-style switches
export function usersInto(body) {
    const owner = api.role() === 'owner'
    const list = h('div.people-list', h('div.loading-page', h('div.spinner')))
    body.replaceChildren(
        h('div.srv-users-head', h('p.muted.small', 'Their email is just what they type to sign in. Nobody gets an email.'),
            owner ? h('button.pill.glass.small', { onclick: () => addSheet(draw) }, icon('plus'), ' Add Person') : null),
        list)
    async function draw() {
        let people, free, links = null
        try { [{ people, kavitaFree: free }, links] = await Promise.all([call(''), call('/links').catch(() => null)]) } catch (e) { return list.replaceChildren(h('div.empty', e.message)) }
        list.classList.add('full-width')
        list.replaceChildren(...people.map(p => card(p, owner, draw, free || [], links)))
    }
    draw()
}

// servers. or match it", "same for emby"): one Cove person = one account in each connected service.
const SVC = { jellyfin: ['Jellyfin', 'Movies and shows'], emby: ['Emby', 'Old server: history and tags'], kavita: ['Kavita', 'Books'], seerr: ['Seerr', 'Requests'] }
async function drawLinks(box, owner, redraw) {
    let d
    try { d = await call('/links') } catch (e) { return box.replaceChildren(h('p.muted.small', e.message)) }
    const cell = (p, sv) => {
        const l = p.links[sv], sug = p.suggest[sv]
        if (sv === 'jellyfin' && p.pending) return h('span.link-chip', 'Made at setup')
        if (l) return h('button.link-chip.on' + (l.missing ? '.bad' : ''), { disabled: !owner, title: l.missing ? 'Linked, but that account is gone' : 'Linked',
            onclick: () => linkSheet(p, sv, d, redraw) }, l.missing ? '! ' : '✓ ', l.name)
        if (!owner) return h('span.muted.small', 'Not linked')
        if (sug) return h('button.link-chip.suggest', { onclick: async () => {
            try { await call('/link', { email: p.email, service: sv, account: sug.name }); toast(`Linked ${p.name} to ${SVC[sv][0]} “${sug.name}”`); redraw() } catch (e) { toast(e.message) }
        } }, 'Match: ', sug.name)
        return h('button.link-chip.add', { onclick: () => linkSheet(p, sv, d, redraw) }, '+ Link or create')
    }
    box.replaceChildren(
        h('div.group-label', 'Linked accounts'),
        h('p.muted.small.links-note', 'Each person’s account in every service Cove is connected to. “Match” links the account with the same name. Cove signs in to these for them; they only ever sign in to Cove.'),
        h('div.links-scroll', h('table.links-table',
            h('thead', h('tr', h('th', 'Person'), ...d.services.map(sv => h('th', h('div', SVC[sv]?.[0] || sv), h('div.muted.small', SVC[sv]?.[1] || ''))))),
            h('tbody', d.people.map(p => h('tr',
                h('td', h('div', p.name), h('div.muted.small', label(p.role) + (p.pending ? ' · not set up yet' : '') + (p.autoCreate.length ? ' · will get ' + p.autoCreate.map(x => SVC[x]?.[0] || x).join(', ') : ''))),
                ...d.services.map(sv => h('td', cell(p, sv)))))))))
}
function linkSheet(p, sv, d, redraw) {
    const name = SVC[sv]?.[0] || sv
    const l = p.links[sv]
    const sel = h('select.srv-select', h('option', { value: '' }, 'Pick an account…'), (d.free[sv] || []).map(n => h('option', { value: n }, n)))
    const act = async (fn, ok) => { try { await fn(); toast(ok); s.close(); redraw() } catch (e) { toast(e.message) } }
    const s = sheet([h('div.form-pad',
        l ? h('p', `Linked to ${name} account “${l.name}”.`) : h('p.muted', `${p.name} has no ${name} account linked yet.`),
        h('div.link-row', sel, h('button.pill.glass.small', { onclick: () => { if (!sel.value) return toast('Pick an account'); act(() => call('/link', { email: p.email, service: sv, account: sel.value }), `Linked to ${sel.value}`) } }, l ? 'Switch' : 'Link')),
        sv !== 'jellyfin' && !l ? h('button.pill.white.block', { onclick: () => act(() => call('/create-account', { email: p.email, service: sv }), `Made ${p.name}’s ${name} account`) },
            `Create a ${name} account for ${p.name}`) : null,
        sv !== 'jellyfin' && !l ? h('p.muted.small', sv === 'kavita' ? 'Made with the right age limit for their level. They never sign in to Kavita themselves.'
            : sv === 'emby' ? 'Made with their level’s limits (kids and teens only see tagged titles) and a random password nobody needs.'
            : 'Made from their Jellyfin account; only members and up can request.') : null,
        l && sv !== 'jellyfin' ? h('button.pill.glass.block', { onclick: () => act(() => call('/link', { email: p.email, service: sv, account: null }), 'Unlinked') }, 'Unlink (keeps the account and its history)') : null)],
        { title: `${p.name} · ${name}`, className: 'menu' })
}
// choice for emby, plex, or jellyfin etc. right at the top")
const LOGOS = { jellyfin: 'jellyfin', kavita: 'kavita', seerr: 'seerr', emby: 'emby' }
// Change where a part's service lives (Nov 20, 2026, Cove Server phase 2): address + key, checked before saving.
// Saving restarts Cove's helper for a moment so the new address takes effect.
function connectionSheet(pt, redraw) {
    const kind = pt.service
    const what = { jellyfin: 'Jellyfin', kavita: 'Kavita', seerr: 'Seerr' }[kind]
    const url = h('input', { type: 'text', inputmode: 'url', value: pt.savedAddress || '', placeholder: kind === 'kavita' ? 'http://192.168.1.20:5000' : kind === 'seerr' ? 'http://192.168.1.20:5055' : 'http://192.168.1.20:8096', autocapitalize: 'none', spellcheck: false })
    const key = h('input', { type: 'text', placeholder: pt.savedAddress ? 'Key (leave empty to keep the current one)' : (kind === 'kavita' ? 'Kavita admin’s auth key' : kind === 'seerr' ? 'Seerr API key' : 'Jellyfin API key'), autocapitalize: 'none', spellcheck: false, autocomplete: 'off' })
    const err = h('div.login-err', { role: 'alert' })
    const go = h('button.pill.white.block', { onclick: async () => {
        go.disabled = true; go.textContent = 'Checking…'; err.textContent = ''
        try {
            const r = await fetch('/cove-api/admin/connection', { method: 'POST', headers: { Authorization: api.authHeaderValue(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, url: url.value, key: key.value }) })
            const j = await r.json(); if (!r.ok) throw new Error(j.error)
            s.close(); toast(`Saved. ${pt.name} uses ${what} at ${url.value.trim()}`, 4000)
            setTimeout(redraw, 2500)
        } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Check and Save' }
    } }, 'Check and Save')
    const hint = { jellyfin: 'Cove keeps using its own Jellyfin key unless you paste a new one.',
        kavita: 'Kavita: your profile → 3rd Party Clients → Auth Keys.', seerr: 'Seerr: Settings → General → API Key.' }[kind]
    const s = sheet([h('div.form-pad', h('p.muted.small', `Where ${pt.name} finds ${what}. ${hint}`), h('div.field-group', url, key), err, go)],
        { title: `${pt.name} · ${what} address`, className: 'menu' })
    setTimeout(() => url.focus(), 80)
}

export async function drawServices(box) {
    let d
    try {
        const r = await fetch('/cove-api/admin/services', { headers: { Authorization: api.authHeaderValue() } })
        d = await r.json(); if (!r.ok) throw new Error(d.error)
    } catch (e) { return box.replaceChildren(h('p.muted.small', e.message)) }
    const owner = api.role() === 'owner'
    const pick = async (part, provider, name) => {
        try {
            const r = await fetch('/cove-api/admin/services', { method: 'POST', headers: { Authorization: api.authHeaderValue(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ part, provider }) })
            const j = await r.json(); if (!r.ok) throw new Error(j.error)
            toast(provider === 'off' ? `${name} is off for everyone` : `${name} now uses ${provider}`)
            drawServices(box)
        } catch (e) { toast(e.message) }
    }
    box.replaceChildren(
        h('div.group-label', 'Where’s the media coming from?'),
        h('div.parts-list', d.parts.map(pt => {
            const status = pt.current === 'off' ? h('span.parts-status.off', 'Off for everyone')
                : pt.reachable === false ? h('span.parts-status.bad', 'Can’t reach it') : h('span.parts-status.ok', 'Connected')
            const chip = (id, label, ready, logo) => {
                const on = pt.current === id
                return h('button.parts-chip' + (on ? '.on' : '') + (ready ? '' : '.soon'), { disabled: !owner || on || !ready,
                    title: ready ? '' : 'Coming later', onclick: () => pick(pt.part, id, pt.name) },
                    logo ? h('img', { src: `icons/services/${logo}.png`, alt: '' }) : null, label, ready ? null : h('span.soon-tag', 'soon'))
            }
            return h('div.parts-row',
                h('div.parts-name', h('span', { html: markTile(pt.part, 40, { off: pt.current === 'off' }) }),
                    h('div', { title: pt.address || '' }, h('div.parts-title', pt.name), status)),
                h('div.parts-chips',
                    ...pt.options.map(o => chip(o.id, o.name, o.ready, LOGOS[o.id])),
                    pt.canOff ? chip('off', 'Off', true, null) : '',
                    owner && pt.editable ? h('button.parts-chip', { onclick: () => connectionSheet(pt, () => drawServices(box)) }, 'Address') : ''))
        })),
        owner ? '' : h('p.muted.small', 'Only the owner can change these.'))
}

export const peopleCall = call
export { levelSheet as peopleLevelSheet, label as levelLabel }

export async function peoplePage(main) {
    if (!api.atLeast('admin')) return main.replaceChildren(h('div.empty', 'Only the owner can manage people.'))
    const owner = api.role() === 'owner'
    const list = h('div.people-list', h('div.loading-page', h('div.spinner')))
    main.replaceChildren(
        h('header.page-head.row', h('h1', 'People'), owner ? h('button.pill.glass', { onclick: () => addSheet(draw) }, icon('plus'), ' Add Person') : null),
        h('p.muted.page-sub', 'Their email is just what they type to sign in. Nobody gets an email.'),
        list)
    async function draw() {
        let people, free
        try { ({ people, kavitaFree: free } = await call('')) } catch (e) { return list.replaceChildren(h('div.empty', e.message)) }
        list.replaceChildren(...people.map(p => card(p, owner, draw, free || [])))
    }
    draw()
}

// movies and shows for watch history from where? maybe even merge them? same with books. and music. that way theres only
// the pills from the services we have?"). Old servers to copy history from (Emby for movies) live inside the pill.
const SERVICES = [
    { sv: 'jellyfin', part: 'reel', mark: 'reel', name: 'Cinema', logo: 'jellyfin', history: [{ sv: 'emby', name: 'Emby', logo: 'emby' }] },
    { sv: 'kavita', part: 'folio', mark: 'folio', name: 'Folio', logo: 'kavita', history: [] },
    { sv: 'seerr', part: 'requests', mark: 'requests', name: 'Requests', logo: 'seerr' },
    // Music shows up once a music service is connected (Vinyl)
]
const SVC_NAME = { jellyfin: 'Jellyfin', kavita: 'Kavita', seerr: 'Seerr', emby: 'Emby' }
function card(p, owner, redraw, free, links) {
    const status = p.role === 'owner' ? 'Owner' : p.setUp ? 'Can sign in' : 'Waiting for setup'
    const lock = p.role === 'kid' ? 'Sees: Kids' : p.role === 'teen' ? 'Sees: Kids + Teens' : 'Sees: everything'
    const lp = links?.people.find(x => x.email === p.email)
    const isOwnerCard = p.role === 'owner'
    return h('div.person-card' + (p.setUp || isOwnerCard ? '' : '.pending'),
        h('div.person-head',
            h('div.avatar', (p.name || '?')[0]),
            h('div.person-info', h('div.ep-title', p.name), h('div.muted.small', p.email)),
            h('span.level.' + p.role, label(p.role))),
        h('div.person-meta', p.disabled ? h('span.warn', 'Disabled') : null, h('span', status), h('span', lock),
            p.historyCopied ? h('span', 'History: ' + p.historyCopied) : null),
        h('div.person-actions',
            p.userId ? h('a.btn', { href: '#/server/user/' + encodeURIComponent(p.email) }, 'Settings') : null,
            ...(owner && !isOwnerCard ? [
                p.setUp ? h('button.btn', { onclick: () => passwordSheet(p, redraw, false) }, 'Reset Password')
                    : h('button.btn.primary', { onclick: () => inviteSheet(p) }, 'Invite'),
                p.setUp ? null : h('button.btn', { onclick: () => passwordSheet(p, redraw, true) }, 'Set Up Myself'),
                h('button.btn', { onclick: () => levelSheet(p, redraw) }, 'Change Level')] : [])),
        h('div.svc-row', SERVICES.filter(x => !links || links.services.includes(x.sv)).map(x => svcPill(p, x, lp, owner, redraw, free, links))))
}
function svcState(p, x, lp) {
    const set = p.partsSet || {}
    if (x.part === 'requests' && (p.role === 'kid' || p.role === 'teen')) return 'nokids'
    if (x.part && p.role !== 'owner' && set[x.part] === false) return 'off'
    const l = lp?.links?.[x.sv]
    if (x.sv === 'jellyfin' && !p.setUp && p.role !== 'owner') return 'setup'
    if (l && !l.missing) return 'on'
    return 'fix'
}
function svcPill(p, x, lp, owner, redraw, free, links) {
    const st = svcState(p, x, lp)
    const l = lp?.links?.[x.sv]
    const hist = (x.history || []).filter(hs => links?.services.includes(hs.sv) && lp?.links?.[hs.sv]).map(hs => hs.name)
    const sub = { on: l?.name || 'Connected',
        fix: lp?.suggest?.[x.sv] ? 'Match ' + lp.suggest[x.sv].name : 'Not matched', setup: 'Waiting for setup',
        off: 'Off', nokids: 'Not for kids and teens' }[st]
    const canTouch = api.atLeast('admin') && st !== 'nokids'
    return h('button.svc-pill.' + st, { disabled: !canTouch, title: `${x.name}: ${sub}`,
        onclick: () => svcSheet(p, x, st, lp, owner, redraw, free, links) },
        h('span.svc-mark', { html: markTile(x.mark, 32, { off: st === 'off' || st === 'nokids' }) }),
        h('span.svc-text', h('span.svc-name', x.name), h('span.svc-sub', sub)))
}
function svcSheet(p, x, st, lp, owner, redraw, free, links) {
    const isOwner = p.role === 'owner'
    const act = async (fn, ok) => { try { const r = await fn(); toast(typeof ok === 'function' ? ok(r) : ok); s.close(); redraw() } catch (e) { toast(e.message) } }
    const row = (title, note, fn, cls = '') => h('button.menu-row' + cls, { onclick: fn }, h('span', h('div', title), note ? h('div.muted.small', note) : null))
    const label2 = t => h('div.menu-label', t)
    // linking block for one service (the main one, or a history source)
    const linkRows = (sv, svName, { create = true } = {}) => {
        const l = lp?.links?.[sv], sug = lp?.suggest?.[sv], out = []
        if (l && !l.missing) {
            out.push(h('p.muted.small.form-pad', `${svName} account: “${l.name}”`))
            if (sv === 'emby' && p.setUp) out.push(row('Copy history again', 'Watched and resume spots; never overwrites newer ones',
                () => act(() => call('/history', { email: p.email }), r => `Copied ${r.watched} watched and ${r.spots} resume spots`)))
            if (owner && sv !== 'jellyfin') out.push(row(`Unlink ${svName}`, 'Keeps the account and its history', () => act(() => call('/link', { email: p.email, service: sv, account: null }), 'Unlinked')))
            return out
        }
        if (!owner) return [h('p.muted.small.form-pad', `Not linked to ${svName}. Only the owner can link accounts.`)]
        if (sug) out.push(row(`Match with ${svName} “${sug.name}”`, sv === 'emby' ? 'Copies their watch history into Cove right away' : 'The account with the same name',
            () => act(() => call('/link', { email: p.email, service: sv, account: sug.name }), sv === 'emby' ? `Matched. Copying ${p.name}’s Emby history in the background.` : `Matched ${p.name} with ${sug.name}`)))
        const others = (links?.free?.[sv] || []).filter(n => n !== sug?.name)
        if (others.length) {
            const sel = h('select.srv-select', h('option', { value: '' }, `Another ${svName} account…`), others.map(n => h('option', { value: n }, n)))
            out.push(h('div.menu-row.link-row', sel, h('button.pill.glass.small', { onclick: () => { if (!sel.value) return toast('Pick an account'); act(() => call('/link', { email: p.email, service: sv, account: sel.value }), `Linked to ${sel.value}`) } }, 'Link')))
        }
        if (create && sv !== 'jellyfin') out.push(row(`Create a ${svName} account`,
            sv === 'kavita' ? 'With the right age limit for their level' : 'Made from their Jellyfin account; only members and up can request',
            () => act(() => call('/create-account', { email: p.email, service: sv }), `Made ${p.name}’s ${svName} account`)))
        if (!out.length) out.push(h('p.muted.small.form-pad', `No free ${svName} accounts to link.`))
        return out
    }
    const rows = []
    if (st === 'off') rows.push(row(`Turn on ${x.name}`, null, () => act(() => call('/parts', { email: p.email, [x.part]: true }), `${x.name} is on for ${p.name}`)))
    else {
        if (st === 'setup') {
            rows.push(row('Invite', 'A link where they pick their own password', () => { s.close(); inviteSheet(p) }))
            rows.push(row('Set Up Myself', 'You pick their password', () => { s.close(); passwordSheet(p, redraw, true) }))
        } else rows.push(...linkRows(x.sv, SVC_NAME[x.sv]))
        for (const hs of (x.history || []).filter(hs => links?.services.includes(hs.sv))) {
            rows.push(label2(`Watch history from ${hs.name}`))
            rows.push(...linkRows(hs.sv, hs.name, { create: false }))
        }
        if (x.part && !isOwner) rows.push(label2(''), row(`Turn off ${x.name}`, x.part === 'reel' ? 'Their movies and shows stop everywhere, Jellyfin’s apps too' : null,
            () => act(() => call('/parts', { email: p.email, [x.part]: false }), `${x.name} is off for ${p.name}`), '.danger'))
    }
    rows.unshift(h('div.svc-from', h('img.svc-logo', { src: `icons/services/${x.logo}.png`, alt: '' }), h('span.muted.small', `Uses ${SVC_NAME[x.sv]} on this server`)))
    const s = sheet(rows, { title: `${p.name} · ${x.name}`, className: 'menu' })
}

function canUseRow(p, redraw) {
    const can = api.atLeast('admin') && p.role !== 'owner' && !(p.role === 'admin' && api.role() !== 'owner')
    const set = p.partsSet || {}
    const items = [['reel', 'Cinema', 'Movies and shows'], ['folio', 'Folio', 'Books'], ['vinyl', 'Vinyl', 'Music, coming later']]
    return h('div.can-use', h('span.muted.small', 'Can use'), ...items.map(([k, name, what]) => {
        const on = p.role === 'owner' || set[k] !== false
        const note = k === 'folio' && on && !p.books ? ' (needs Turn On Books)' : k === 'vinyl' ? ' (later)' : ''
        return h('button.srv-check' + (on ? '.on' : ''), { disabled: !can, title: what + note, onclick: async e => {
            e.currentTarget.disabled = true
            try { await call('/parts', { email: p.email, [k]: !on }); toast(`${name} is ${on ? 'off' : 'on'} for ${p.name}`); redraw() } catch (x) { toast(x.message); e.currentTarget.disabled = false }
        } }, h('span.srv-box', on ? icon('check') : null), name, note ? h('span.muted.small', note) : null)
    }))
}

function passwordSheet(p, redraw, first) {
    const a = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'new-password' })
    const b = h('input', { type: 'password', placeholder: 'Password again', autocomplete: 'new-password' })
    const err = h('div.login-err', { role: 'alert' })
    const go = h('button.pill.white.block', { onclick: async () => {
        err.textContent = ''
        if (a.value.length < 6) return (err.textContent = 'Use at least 6 characters')
        if (a.value !== b.value) return (err.textContent = 'The passwords don’t match')
        go.disabled = true; go.textContent = 'Saving…'
        try {
            await call('/setup', { email: p.email, password: a.value })
            s.close(); toast(first ? `${p.name} can sign in now with ${p.email}` : 'Password reset', 4000); redraw()
        } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = first ? 'Set Up' : 'Reset Password' }
    } }, first ? 'Set Up' : 'Reset Password')
    const s = sheet([h('div.form-pad',
        h('p.muted.small', first ? `Pick ${p.name}’s starting password. Tell them, and they sign in with ${p.email}. They can change it in Settings, or set up Face ID.`
            : `A new password for ${p.name}. They stay signed in on devices they’re already on.`),
        h('div.field-group', a, b), err, go)], { title: first ? `Set Up ${p.name}` : `Reset ${p.name}’s Password`, className: 'menu' })
    setTimeout(() => a.focus(), 80)
}

function levelSheet(p, redraw) {
    const s = sheet(LEVELS.map(([v, name, note]) => h('button.menu-row', { onclick: async () => {
        try { await call('/role', { email: p.email, role: v }); s.close(); toast(`${p.name} is ${name} now`); redraw() } catch (e) { toast(e.message) }
    } }, h('span', h('div', name), h('div.muted.small', note)), p.role === v ? icon('check') : null)), { title: `${p.name}’s Level`, className: 'menu' })
}

function addSheet(redraw) {
    let role = 'member'
    const name = h('input', { type: 'text', placeholder: 'Name' })
    const email = h('input', { type: 'text', inputmode: 'email', placeholder: 'Email (their sign-in)', autocapitalize: 'none', spellcheck: false })
    const emby = h('input', { type: 'text', placeholder: 'Their Emby account, to copy history (optional)' })
    const lv = h('div.seg')
    const drawLv = () => lv.replaceChildren(...LEVELS.map(([v, n]) => h('button' + (role === v ? '.on' : ''), { onclick: () => { role = v; drawLv() } }, n)))
    drawLv()
    const err = h('div.login-err', { role: 'alert' })
    // which accounts Cove makes for them once their Cove sign-in is set up (Nov 20, 2026)
    const make = new Set(['kavita', 'seerr'])
    const makeBox = h('div.make-box')
    call('/links').then(d => {
        const opts = d.services.filter(sv => sv !== 'jellyfin')
        const draw = () => makeBox.replaceChildren(h('div.muted.small', 'Also make their accounts in:'), ...opts.map(sv => h('button.srv-check' + (make.has(sv) ? '.on' : ''),
            { onclick: () => { make.has(sv) ? make.delete(sv) : make.add(sv); draw() } }, h('span.srv-box', make.has(sv) ? icon('check') : null), SVC[sv]?.[0] || sv)))
        draw()
    }).catch(() => {})
    const s = sheet([h('div.form-pad', h('div.field-group', name, email, emby), lv, makeBox, err,
        h('button.pill.white.block', { onclick: async () => {
            try { await call('/add', { name: name.value, email: email.value, role, emby: emby.value.trim() || null, create: [...make] }); s.close(); toast('Added. Tap Set Up to give them a password.'); redraw() }
            catch (e) { err.textContent = e.message }
        } }, 'Add'))], { title: 'Add Person', className: 'menu' })
    setTimeout(() => name.focus(), 80)
}

// Invite: a one-time link (7 days); they open it and pick their own password
async function inviteSheet(p) {
    let code
    try { code = (await call('/invite', { email: p.email })).code } catch (e) { return toast(e.message) }
    const link = `${api.cachedServerInfo().addresses?.public || location.origin}/#/join/${code}`
    const text = `Here’s your Cove invite: ${link}
Open it to pick your password. After that, sign in with ${p.email}.`
    const s = sheet([h('div.form-pad',
        h('p.muted.small', `Send this to ${p.name}. It works once and expires in 7 days. They pick their own password, then sign in with ${p.email}.`),
        h('div.invite-link', link),
        h('div.tag-row',
            h('button.pill.glass', { onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied. Paste it in a text.') } catch { toast('Couldn’t copy, press and hold the link instead') } } }, 'Copy'),
            navigator.share ? h('button.pill.white', { onclick: () => navigator.share({ title: 'Cove invite', text }).catch(() => {}) }, 'Share…') : null),
        h('p.muted.small', 'Making a new invite turns off the old one.'))], { title: `Invite ${p.name}`, className: 'menu' })
}

// the page an invite link opens (works signed out)
export async function joinPage(app, code, done) {
    const box = h('form.login-card', { onsubmit: e => e.preventDefault() }, h('img.login-icon', { src: 'icons/icon-192.png', alt: '' }), h('div.spinner'))
    app.replaceChildren(h('div.login', box))
    let info
    try {
        const r = await fetch('/cove-api/join?code=' + encodeURIComponent(code))
        info = await r.json()
        if (!r.ok) throw new Error(info.error)
    } catch (e) {
        return box.replaceChildren(h('img.login-icon', { src: 'icons/icon-192.png', alt: '' }), h('h1', 'Cove'), h('p.muted', e.message || 'This invite isn’t valid anymore.'),
            h('a.pill.white.block', { href: '#/home' }, 'Go to sign in'))
    }
    const a = h('input', { type: 'password', placeholder: 'Choose a password', autocomplete: 'new-password' })
    const b = h('input', { type: 'password', placeholder: 'Password again', autocomplete: 'new-password' })
    const err = h('div.login-err', { role: 'alert' })
    const go = h('button.pill.white.block', { type: 'submit', onclick: async () => {
        err.textContent = ''
        if (a.value.length < 6) return (err.textContent = 'Use at least 6 characters')
        if (a.value !== b.value) return (err.textContent = 'The passwords don’t match')
        go.disabled = true; go.textContent = 'Setting up…'
        try {
            const r = await fetch('/cove-api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password: a.value }) })
            const d = await r.json()
            if (!r.ok) throw new Error(d.error)
            if (d.setupId) await settingUp(box, info.name, d.setupId)     // bring their history over first
            await api.login(info.email, a.value)
            try { localStorage.setItem('cove.lastUser', info.email) } catch {}
            location.replace('#/home'); done()
        } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Set Up Cove' }
    } }, 'Set Up Cove')
    box.replaceChildren(h('img.login-icon', { src: 'icons/icon-192.png', alt: '' }), h('h1', `Hi, ${info.name}`),
        h('p.muted', `Pick a password for Cove. You’ll sign in with ${info.email}.`), h('div.field-group', a, b), err, go)
    setTimeout(() => a.focus(), 80)
}

async function settingUp(box, name, id) {
    const line = h('p.muted.setup-line', 'Bringing over what you’ve watched…')
    box.replaceChildren(h('img.login-icon.setup-pulse', { src: 'icons/icon-192.png', alt: '' }), h('h1', 'Setting up Cove'),
        h('p.muted', `Getting everything ready for ${name}. This takes a minute.`), h('div.setup-bar', h('div')), line)
    const steps = ['Bringing over what you’ve watched…', 'Finding where you left off…', 'Lining up what’s next…', 'Almost there…']
    let n = 0
    for (let i = 0; i < 240; i++) {
        await new Promise(r => setTimeout(r, 1500))
        if (i % 3 === 2) line.textContent = steps[Math.min(++n, steps.length - 1)]
        const st = await fetch('/cove-api/join/status?id=' + encodeURIComponent(id)).then(r => r.json()).catch(() => ({}))
        if (st.state === 'done') { line.textContent = st.watched ? `Done: ${st.watched} watched, ${st.spots} to pick back up.` : 'Done.'; await new Promise(r => setTimeout(r, 900)); return }
        if (st.state === 'failed' || st.state === 'unknown') return      // don't hold them up; history can be copied later
    }
}

// Turn On Books: a new books account (age limit by level), or link a Kavita account they already have
function booksSheet(p, free, redraw) {
    const limit = p.role === 'kid' ? 'Everyone 10+ books only' : p.role === 'teen' ? 'Teen and younger books only' : 'every book'
    const go = async (body, b) => {
        b.disabled = true; b.querySelector('div').textContent = 'Setting up…'
        try { await call('/books', { email: p.email, ...body }); s.close(); toast(`Books is on for ${p.name}`); redraw() }
        catch (e) { toast(e.message); b.disabled = false; b.querySelector('div').textContent = body.link ? `Use ${body.link}` : 'New books account' }
    }
    const s = sheet([
        h('button.menu-row', { onclick: e => go({}, e.currentTarget) }, h('span', h('div', 'New books account'), h('div.muted.small', `Starts fresh. Sees ${limit}.`))),
        ...free.map(u => h('button.menu-row', { onclick: e => go({ link: u }, e.currentTarget) },
            h('span', h('div', `Use ${u}`), h('div.muted.small', 'Their Kavita account, with everything they’ve read')))),
    ], { title: `Books for ${p.name}`, className: 'menu' })
}
