// whatever you think can be collapsable collapsable"). Every .group-label on a Settings or Server page becomes a toggle for
// what follows it (up to the next label). Long technical sections start closed; each page remembers what you opened or
// closed on this device.
const START_CLOSED = new Set([
    'approve automatically', 'everyone’s requests', 'info files (.nfo)', 'browsing in jellyfin’s apps', 'library scans', 'logs',
    'branding (jellyfin’s own apps)', 'where things live', 'scrub previews (trickplay)', 'jellyfin (this server)',
    'jellyfin’s subtitle downloader (off, bazarr does this)', 'more library options', 'activity',
])
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9.5 6 6 6-6"/></svg>'
const pageKey = () => (location.hash.split('?')[0] || '#/').replace(/\/[0-9a-f]{20,}.*$/, '/x')   // one key per kind of page
const storeKey = label => `cove.collapse.${pageKey()}.${label}`

function section(label) {
    const out = []
    for (let el = label.nextElementSibling; el && !el.classList.contains('group-label'); el = el.nextElementSibling) {
        if (el.classList.contains('srv-save-space')) break
        out.push(el)
    }
    return out
}
function setOpen(label, open, save) {
    label.classList.toggle('closed', !open)
    label.setAttribute('aria-expanded', String(open))
    for (const el of section(label)) el.hidden = !open
    if (save) try { localStorage.setItem(storeKey(label.dataset.label), open ? '1' : '0') } catch {}
}
function wire(label) {
    const text = label.textContent.trim()
    if (!text || label.dataset.collapse) return
    label.dataset.collapse = '1'
    label.dataset.label = text.toLowerCase()
    label.setAttribute('role', 'button')
    label.tabIndex = 0
    label.insertAdjacentHTML('beforeend', `<span class="collapse-chev">${CHEV}</span>`)
    const toggle = () => setOpen(label, label.classList.contains('closed'), true)
    label.addEventListener('click', toggle)
    label.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
    let saved = null
    try { saved = localStorage.getItem(storeKey(label.dataset.label)) } catch {}
    setOpen(label, saved != null ? saved === '1' : !START_CLOSED.has(label.dataset.label), false)
}
let timer
export function watchCollapsibles(main) {
    const run = () => {
        if (!/^#\/(settings|server)/.test(location.hash)) return
        for (const label of main.querySelectorAll('.group-label')) {
            if (label.closest('.sheet')) continue
            if (!label.dataset.collapse) wire(label)
            else if (label.classList.contains('closed')) for (const el of section(label)) el.hidden = true   // content redrawn later
        }
    }
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(run, 60) }).observe(main, { childList: true, subtree: true })
}
