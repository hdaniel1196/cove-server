// Cove service worker: app files work offline (network-first), posters cached, Jellyfin API and video never cached.
const VERSION = 'cove-v114'
const SHELL = [
    './', 'index.html', 'manifest.webmanifest', 'css/app.css',
    'js/app.js', 'js/api.js', 'js/ui.js', 'js/views.js', 'js/player.js', 'js/images.js', 'js/sagas.js', 'js/requests.js', 'js/tags.js', 'js/watching.js', 'js/continue.js', 'js/prefs.js', 'js/passkey.js', 'js/people.js', 'js/switcher.js', 'js/server.js', 'js/livetv.js', 'js/subs.js', 'js/subs-page.js', 'js/playprefs.js', 'js/jfuser.js', 'js/pin.js', 'js/keys.js', 'js/marks.js', 'js/collapse.js', 'js/qr.js', 'js/pair.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
]
self.addEventListener('install', e => {
    e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        for (const k of await caches.keys()) if (k.startsWith('cove-v') && k !== VERSION) await caches.delete(k)
        await self.clients.claim()
    })())
})
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url)
    if (e.request.method !== 'GET' || url.origin !== location.origin) return
    if (/^\/jf\/Items\/[^/]+\/Images\//.test(url.pathname)) return e.respondWith(imageFirst(e.request))
    if (/^\/(jf|vendor|books|api|folio-api|cove-api)(\/|$)/.test(url.pathname)) return   // books have their own service worker
    e.respondWith(networkFirst(e.request))
})
async function imageFirst(req) {
    const c = await caches.open('cove-images')
    const hit = await c.match(req)
    if (hit) return hit
    const res = await fetch(req)
    if (res.ok) c.put(req, res.clone())
    return res
}
async function networkFirst(req) {
    try {
        const res = await fetch(req)
        if (res.ok) (await caches.open(VERSION)).put(req, res.clone())
        return res
    } catch {
        return (await caches.match(req)) ?? (await caches.match('index.html'))
    }
}
