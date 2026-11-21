// device (Switch Account, and the "On this device" list on the sign-in screen). Checked by cove-api (hashed there,
// 5 wrong tries = 1 minute wait). Your own account never asks you while you're in it.
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'

const has = new Map()
export async function hasPins(ids) {
    try { const r = await api.helper('/pin/status', { ids }); for (const [k, v] of Object.entries(r)) has.set(k, !!v) } catch {}
    return has
}

// big number pad, works with a keyboard too; resolves the typed PIN or null if closed
function padSheet(title, note) {
    return new Promise(done => {
        let v = ''
        const dots = h('div.pin-dots')
        const msg = h('p.muted.small.pin-note', note || '')
        const draw = () => dots.replaceChildren(...Array.from({ length: Math.max(4, v.length) }, (_, i) => h('span' + (i < v.length ? '.on' : ''))))
        const press = k => {
            if (k === 'del') v = v.slice(0, -1)
            else if (k === 'ok') { if (v.length >= 4) { finished = true; s.close(); done(v) } return }
            else if (v.length < 8) v += k
            draw()
        }
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']
        const pad = h('div.pin-pad', keys.map(k => h('button.pin-key' + (k === 'ok' ? '.ok' : ''), { onclick: () => press(k), 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Done' : k },
            k === 'del' ? '⌫' : k === 'ok' ? icon('check') : k)))
        const onKey = e => { if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('ok') }
        let finished = false
        const s = sheet([h('div.pin-wrap', msg, dots, pad)], { title, className: 'menu.pin-sheet', onClose: () => { removeEventListener('keydown', onKey); if (!finished) done(null) } })
        addEventListener('keydown', onKey)
        draw()
    })
}

// before switching to an account: true = go ahead
export async function pinGate(account) {
    if (account.userId === api.userId()) return true
    await hasPins([account.userId])
    if (!has.get(account.userId)) return true
    for (;;) {
        const pin = await padSheet(`${account.name}’s PIN`, 'This account has a PIN.')
        if (pin == null) return false
        try { await api.helper('/pin/check', { userId: account.userId, pin }); return true }
        catch (e) { toast(e.message, 3000); if (/Wait/.test(e.message)) return false }
    }
}

// Settings → Account → Profile PIN
export function pinRow() {
    const row = h('div.list-row')
    const draw = async () => {
        let mine = false
        try { mine = (await api.helper('/pin/me', {})).has } catch {}
        const set = async () => {
            const current = mine ? await padSheet('Current PIN') : ''
            if (mine && current == null) return
            const a = await padSheet(mine ? 'New PIN' : 'Pick a PIN', '4 to 8 digits')
            if (a == null) return
            const b = await padSheet('Type it again')
            if (b == null) return
            if (a !== b) return toast('Those didn’t match. Try again.')
            try { await api.helper('/pin/set', { pin: a, current }); toast('PIN saved'); draw() } catch (e) { toast(e.message, 3000) }
        }
        const remove = async () => {
            const current = await padSheet('Current PIN', 'To turn the PIN off')
            if (current == null) return
            try { await api.helper('/pin/remove', { current }); toast('PIN turned off'); draw() } catch (e) { toast(e.message, 3000) }
        }
        row.replaceChildren(
            h('div', { style: { flex: '1' } }, h('div', 'Profile PIN'), h('div.muted.small', mine ? 'On. Asked when someone switches to your account on a shared device.' : 'Off. Add one so others on a shared device can’t switch into your account.')),
            h('button.pill.glass.small', { onclick: set }, mine ? 'Change' : 'Add'),
            mine ? h('button.pill.glass.small', { onclick: remove }, 'Turn Off') : '')
    }
    draw()
    return row
}
