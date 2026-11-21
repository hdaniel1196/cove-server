// Face ID / Touch ID sign-in (passkeys). Only works on the HTTPS address (Apple allows passkeys on secure sites only).
// Setup: Settings -> Face ID. Sign-in: the device starts a Quick Connect code, Face ID signs cove-api's challenge,
// cove-api approves the code for that person, and Cove finishes signing in with it. No password involved.
import * as api from './api.js'

const enc = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0))
const dec = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const supported = () => !!window.PublicKeyCredential && !!api.cachedServerInfo().signIn?.rpId && location.hostname === api.cachedServerInfo().signIn.rpId && isSecureContext

async function post(path, body, signedIn = true) {
    const headers = { 'Content-Type': 'application/json' }
    if (signedIn) headers.Authorization = api.authHeaderValue()
    const r = await fetch('/cove-api/passkey/' + path, { method: 'POST', headers, body: JSON.stringify(body || {}) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `failed (${r.status})`)
    return d
}
function deviceName() {
    const ua = navigator.userAgent
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
    if (/Macintosh/.test(ua)) return 'Mac'
    return 'This device'
}

export async function setup() {
    const o = await post('register/options')
    const cred = await navigator.credentials.create({ publicKey: {
        ...o, challenge: enc(o.challenge), user: { ...o.user, id: enc(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: enc(c.id) })),
    } })
    await post('register/verify', {
        id: dec(cred.rawId), clientDataJSON: dec(cred.response.clientDataJSON),
        attestationObject: dec(cred.response.attestationObject), device: deviceName(),
    })
}
export const list = () => post('list').then(d => d.passkeys)
export const remove = id => post('remove', { id })

export async function signIn() {
    const { Code, Secret } = await api.codeStart()
    const o = await post('login/options', null, false)
    const a = await navigator.credentials.get({ publicKey: { challenge: enc(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeout, allowCredentials: [] } })
    await post('login/verify', {
        id: dec(a.rawId), clientDataJSON: dec(a.response.clientDataJSON), authenticatorData: dec(a.response.authenticatorData),
        signature: dec(a.response.signature), code: Code,
    }, false)
    for (let i = 0; i < 20; i++) {
        const st = await api.codeCheck(Secret).catch(() => null)
        if (st?.Authenticated) return api.codeFinish(Secret)
        await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Sign-in didn’t finish. Try again.')
}
