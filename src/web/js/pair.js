// "Connect an app" (Nov 21, 2026, phase 3 of the Cove Server plan): a QR code the Cove Media apps scan to add this
// server. Format agreed with the Apple app chat: covemedia://pair?url=<address>&id=<serverId>&name=<server name>.
// The address is the outside (https) one when the server has it, so the app works away from home and Face ID works;
// the app checks serverId and switches between the home and outside addresses by itself.
import * as api from './api.js'
import { h, icon, toast, sheet } from './ui.js'
import { qrSvg } from './qr.js'

export function pairLink(info) {
    const url = info.addresses?.public || info.addresses?.local || location.origin
    const q = new URLSearchParams({ url, id: info.serverId || '', name: info.name || 'Cove' })
    return { url, link: `covemedia://pair?${q.toString().replace(/\+/g, '%20')}` }
}

export async function pairSheet() {
    const info = await api.serverInfo()
    const { url, link } = pairLink(info)
    const tile = h('div.pair-qr', { html: qrSvg(link) })
    sheet([h('div.form-pad.pair',
        h('p.muted.small', 'On an iPhone, iPad, Apple TV or Mac: open Cove Media, choose Add a Server, and scan this. Or scan it with the phone’s camera.'),
        tile,
        h('div.pair-name', info.name || 'Cove'),
        h('div.pair-url.muted.small', url),
        h('div.pair-actions',
            h('button.pill.glass', { onclick: async () => {
                try { await navigator.clipboard.writeText(url); toast('Address copied') } catch { toast(url, 5000) }
            } }, 'Copy address')),
        h('p.muted.small.pair-note', 'The app asks each person to sign in with their own Cove account.'))],
        { title: 'Connect an app', className: 'menu' })
}

export function pairRow() {
    return h('div.group', h('button.list-row', { onclick: pairSheet },
        h('div', h('div', 'Connect an app'), h('div.muted.small', 'A QR code for Cove Media on iPhone, iPad, Apple TV and Mac')), icon('chevron')))
}
