// Per-person playback choices (Nov 20, 2026): skip intros/recaps, what happens at the credits, autoplay next.
// Saved in Jellyfin display prefs (client "cove", id "cove-play", CustomPrefs = strings) so the Apple app can read them;
// a device copy makes the player start instantly.
import * as api from './api.js'
import * as store from './prefs.js'

export const DEFAULT = {
    intro: 'button',      // button | auto | off
    recap: 'button',      // button | auto | off
    credits: 'card',      // card (Up next card at the credits) | auto (go straight to next) | off (play the credits)
    autoplay: 'on',       // on | off  (when the video ends)
    countdown: '8',       // seconds before the next one starts
    stillWatching: '0',   // ask "Still watching?" after this many episodes in a row with no touch (0 = never)
}
const key = () => 'cove.play.' + (api.userId() || '')
let cur = null
export function get() {
    if (cur) return cur
    try { cur = { ...DEFAULT, ...(JSON.parse(localStorage.getItem(key())) || {}) } } catch { cur = { ...DEFAULT } }
    return cur
}
export async function refresh() {
    try {
        const p = await store.get('play')
        cur = { ...DEFAULT, ...Object.fromEntries(Object.entries(p).filter(([k]) => k in DEFAULT)) }
        try { localStorage.setItem(key(), JSON.stringify(cur)) } catch {}
    } catch {}
    return get()
}
export async function set(k, v) {
    cur = { ...get(), [k]: String(v) }
    try { localStorage.setItem(key(), JSON.stringify(cur)) } catch {}
    await store.update('play', c => { c[k] = String(v) })
}

// audio language lives in Jellyfin's own user settings (it also drives Jellyfin's apps), not in Cove's store
export const AUDIO_LANGS = [['', 'Original language'], ['eng', 'English'], ['spa', 'Spanish'], ['jpn', 'Japanese'], ['zho', 'Chinese'], ['kor', 'Korean'], ['fre', 'French']]
export async function audioPref() {
    const me = await api.request('/Users/Me')
    return { lang: me.Configuration?.AudioLanguagePreference || '', config: me.Configuration }
}
export async function setAudioPref(lang) {
    const me = await api.request('/Users/Me')
    const c = { ...me.Configuration, AudioLanguagePreference: lang || null, PlayDefaultAudioTrack: !lang }
    await api.request('/Users/Configuration', { method: 'POST', query: { userId: api.userId() }, body: c })
}
