// Folio service worker: app files work offline, covers are cached, Kavita API is never cached here
// (the library snapshot and downloaded books live in IndexedDB).
const VERSION = 'folio-v23'
const SHELL = [
    './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/cove.css',
    'js/app.js', 'js/api.js', 'js/db.js', 'js/library.js', 'js/reader.js', 'js/reader-settings.js', 'js/ui.js', 'js/views.js', 'js/series-info.js', 'js/appearance.js',
    'vendor/foliate/view.js', 'vendor/foliate/epub.js', 'vendor/foliate/epubcfi.js', 'vendor/foliate/paginator.js',
    'vendor/foliate/fixed-layout.js', 'vendor/foliate/progress.js', 'vendor/foliate/overlayer.js',
    'vendor/foliate/text-walker.js', 'vendor/foliate/search.js', 'vendor/foliate/comic-book.js',
    'vendor/foliate/vendor/zip.js', 'vendor/foliate/vendor/fflate.js', 'vendor/foliate/mobi.js', 'vendor/foliate/fb2.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
]

self.addEventListener('install', e => {
    e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        for (const k of await caches.keys())
            if (k.startsWith('folio-v') && k !== VERSION) await caches.delete(k)
        await self.clients.claim()
    })())
})

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url)
    if (e.request.method !== 'GET' || url.origin !== location.origin) return
    if (url.pathname.startsWith('/api/Image/')) return e.respondWith(coverFirst(e.request))
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/folio-api/')) return
    e.respondWith(networkFirst(e.request))
})

async function coverFirst(req) {
    const c = await caches.open('folio-covers')
    const hit = await c.match(req)
    if (hit) return hit
    try {
        const res = await fetch(req)
        if (res.ok) c.put(req, res.clone())
        return res
    } catch {
        return new Response('', { status: 504 })
    }
}

async function networkFirst(req) {
    const c = await caches.open(VERSION)
    try {
        const res = await Promise.race([
            fetch(req, { cache: 'no-cache' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ])
        if (res.ok) c.put(req.mode === 'navigate' ? 'index.html' : req, res.clone())
        return res
    } catch {
        return (await c.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreSearch: true }))
            ?? (await c.match('index.html'))
            ?? new Response('Offline', { status: 503 })
    }
}
