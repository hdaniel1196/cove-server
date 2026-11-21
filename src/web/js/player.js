// The player: picks direct play / remux / transcode out loud, our skip buttons from Media Segments,
// subtitles our way (external SRT only, forced English on by itself), progress back to Jellyfin.
import * as api from './api.js'
import * as subStyle from './subs.js'
import * as playPrefs from './playprefs.js'
import { h, icon, toast, clock, sheet, epNum, epTitle } from './ui.js'

const TICKS = 1e7
const SUBS = 'cove.subs'      // 'smart' (forced only, default) | 'always' (English) | 'off'

// ------------------------------------------------------------------ what this browser can play
const probe = document.createElement('video')
const can = mime => {
    try { if (probe.canPlayType(mime)) return true } catch {}
    try { return !!window.MediaSource?.isTypeSupported?.(mime) } catch { return false }
}
export const nativeHls = () => !!probe.canPlayType('application/vnd.apple.mpegurl')

const forceConvert = () => localStorage.getItem('cove.convert') === 'on'
export function deviceProfile({ live = false } = {}) {
    const hevc = can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')
    const ac3 = can('audio/mp4; codecs="ac-3"'), eac3 = can('audio/mp4; codecs="ec-3"')
    const flac = can('audio/mp4; codecs="flac"'), opus = can('audio/mp4; codecs="opus"')
    const v = ['h264', hevc && 'hevc'].filter(Boolean).join(',')
    const a = ['aac', 'mp3', ac3 && 'ac3', eac3 && 'eac3', flac && 'flac', 'alac', opus && 'opus'].filter(Boolean).join(',')
    // HLS out: AAC first (always works); the source's AC3/EAC3 is copied untouched where the browser takes it
    const hlsA = ['aac', ac3 && 'ac3', eac3 && 'eac3'].filter(Boolean).join(',')
    const direct = [{ Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: v, AudioCodec: a }]
    if (can('video/webm; codecs="vp9, opus"')) direct.push({ Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' })
    return {
        Name: 'Cove',
        // this device's quality choice (Settings → This device); live TV caps at 15 Mbps anyway
        MaxStreamingBitrate: Math.min(live ? 15_000_000 : 120_000_000, +(localStorage.getItem('cove.quality') || 0) || Infinity),
        MaxStaticBitrate: 200_000_000,
        DirectPlayProfiles: direct,
        TranscodingProfiles: [
            // Live TV: the tuner hands out HLS in TS segments (fMP4 is off for the HDHomeRun), H.264 + AAC
            ...(live ? [{ Container: 'ts', Type: 'Video', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '6', MinSegments: 1, BreakOnNonKeyFrames: true }] : []),
            {
            Container: 'mp4', Type: 'Video', Protocol: 'hls', Context: 'Streaming',
            VideoCodec: v, AudioCodec: hlsA, MaxAudioChannels: '6', MinSegments: 1, BreakOnNonKeyFrames: true,
        }],
        CodecProfiles: [
            { Type: 'Video', Codec: 'h264', Conditions: [
                { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
                { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }] },
            // Safari only plays HEVC in MP4 when it's tagged hvc1 (or dvh1 for Dolby Vision)
            { Type: 'Video', Codec: 'hevc', Conditions: [
                { Condition: 'EqualsAny', Property: 'VideoCodecTag', Value: 'hvc1|dvh1', IsRequired: false }] },
        ],
        SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
        ContainerProfiles: [], ResponseProfiles: [],
    }
}

// ------------------------------------------------------------------ why it plays the way it does
const REASONS = {
    ContainerNotSupported: 'this browser can’t open the file type',
    VideoCodecNotSupported: 'this device can’t decode the video',
    VideoProfileNotSupported: 'the video uses a profile this device can’t decode',
    VideoLevelNotSupported: 'the video level is too high for this device',
    VideoBitDepthNotSupported: 'the video is 10-bit, which this device can’t do for that codec',
    VideoRangeTypeNotSupported: 'this device can’t show that HDR type',
    VideoResolutionNotSupported: 'the resolution is too high for this device',
    VideoCodecTagNotSupported: 'the video is tagged in a way Safari won’t open',
    VideoBitrateNotSupported: 'the video bitrate is over the limit',
    ContainerBitrateExceedsLimit: 'the file bitrate is over the limit',
    AudioCodecNotSupported: 'this device can’t play the audio format',
    AudioChannelsNotSupported: 'too many audio channels for this device',
    AudioProfileNotSupported: 'the audio profile isn’t supported here',
    AudioBitrateNotSupported: 'the audio bitrate is over the limit',
    SecondaryAudioNotSupported: 'a second audio track was picked',
    SubtitleCodecNotSupported: 'the subtitle format isn’t supported',
    DirectPlayError: 'direct play failed earlier',
}
// First guess from the file and this device's profile; confirmed from the live session once it plays.
function describe(src, profile, audioIndex) {
    const v = src.MediaStreams.find(s => s.Type === 'Video')
    const a = src.MediaStreams.find(s => s.Type === 'Audio' && s.Index === audioIndex) ?? src.MediaStreams.find(s => s.Type === 'Audio')
    const what = `${(src.Container || '').toUpperCase()} · ${v?.DisplayTitle || v?.Codec || '?'} · ${a?.DisplayTitle || a?.Codec || '?'}`
    if (!src.TranscodingUrl) return { mode: 'direct', label: 'Direct play', detail: 'The file plays exactly as it is. Nothing is converted.', what }
    const tp = profile.TranscodingProfiles[0]
    const q = new URL(src.TranscodingUrl, location.origin).searchParams
    const reasons = (q.get('TranscodeReasons') || '').split(',').filter(Boolean)
    const videoReasons = reasons.filter(r => r.startsWith('Video') || r === 'ContainerBitrateExceedsLimit' || r === 'RefFramesNotSupported')
    const videoCopy = !videoReasons.length && tp.VideoCodec.split(',').includes(v?.Codec)
    const audioCopy = !!a && tp.AudioCodec.split(',').includes(a.Codec) && (a.Channels || 2) <= +tp.MaxAudioChannels
    return verdict({ videoCopy, audioCopy, reasons: videoReasons.length ? videoReasons : reasons.filter(r => r !== 'AudioCodecNotSupported' || !audioCopy), what, audioName: a?.DisplayTitle || a?.Codec })
}
function verdict({ videoCopy, audioCopy, reasons, what, audioName, hw }) {
    const why = reasons.map(r => REASONS[r] || r).filter(Boolean)
    const because = why.length ? ' because ' + why.join(', ') : ''
    if (!videoCopy) return { mode: 'transcode', label: hw ? 'Converting on the 4090' : 'Converting video', detail: 'The server re-encodes the video' + because + '.', what }
    if (!audioCopy) return { mode: 'remux', label: 'Remux, audio converted', detail: `The video is untouched. Only the audio (${audioName || 'this track'}) is converted for this device.`, what }
    return { mode: 'remux', label: 'Remux', detail: 'Same video and audio, just repackaged so this browser can stream it. No quality loss.', what }
}

// ------------------------------------------------------------------ subtitles
export function subLabel(s) {
    const path = (s.Path || '').toLowerCase()
    const lang = s.DisplayTitle?.split(' - ')[0] || s.Language || 'Unknown'
    const base = (s.Language === 'eng' ? 'English' : s.Language === 'spa' ? 'Spanish' : lang).replace(/\s*\(.*\)$/, '')
    if (s.IsForced || /\.forced\./.test(path)) return base + ' (forced)'
    if (s.IsHearingImpaired || /\.(sdh|hi|cc)\./.test(path)) return base + ' SDH'
    return base
}
function pickSub(subs, audioLang) {
    const mode = api.subsMode()
    if (mode === 'off') return -1
    const eng = subs.filter(s => s.Language === 'eng' || /\.en\./.test((s.Path || '').toLowerCase()))
    const forced = eng.find(s => s.label.includes('(forced)'))
    if (mode === 'always') return (eng.find(s => !s.label.includes('(forced)') && !s.label.includes('SDH')) ?? eng[0] ?? forced)?.Index ?? -1
    // smart: forced English for foreign scenes; full English when the audio isn't English
    if (audioLang && audioLang !== 'eng') return (eng.find(s => !s.label.includes('(forced)')) ?? forced)?.Index ?? -1
    return forced?.Index ?? -1
}

// ------------------------------------------------------------------ hls.js for browsers without native HLS
let hlsLoading
function loadHls() {
    hlsLoading ??= new Promise((ok, fail) => {
        const s = document.createElement('script')
        s.src = 'vendor/hls.min.js'
        s.onload = () => ok(window.Hls)
        s.onerror = () => fail(new Error('Could not load hls.js'))
        document.head.append(s)
    })
    return hlsLoading
}

// ------------------------------------------------------------------ the player
export async function play(itemId, { onClose, fromStart = false, audioIndex, subIndex, saga } = {}) {
    const root = h('div.player.loading', h('div.spinner'))
    document.body.append(root)
    document.body.classList.add('playing')
    let state = { closed: false }
    const close = async () => {
        if (state.closed) return
        state.closed = true
        await state.stop?.()
        root.remove()
        document.body.classList.remove('playing')
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
        onClose?.()
    }
    try {
        await start(root, itemId, { fromStart, close, state, audioIndex, subIndex, saga })
    } catch (e) {
        console.error(e)
        root.classList.remove('loading')
        root.replaceChildren(h('div.player-error', h('p', 'This one won’t play: ' + (e.message || e)), h('button.btn', { onclick: close }, 'Close')))
    }
    return close
}

async function start(root, itemId, { fromStart, close, state, audioIndex, subIndex, at, saga }) {
    const item = await api.item(itemId)
    const live = item.Type === 'TvChannel'   // Live TV: no seeking, the tuner is let go on close
    if (live) root.classList.add('live')
    if (live) try { Object.assign(item, await api.request('/LiveTv/Channels/' + itemId, { query: { userId: api.userId() } })) } catch {}
    const profile = deviceProfile({ live })
    const startTicks = live ? 0 : at != null ? Math.round(at * TICKS) : fromStart ? 0 : (item.UserData?.PlaybackPositionTicks || 0)
    const info = await api.request(`/Items/${itemId}/PlaybackInfo`, {
        method: 'POST',
        query: { userId: api.userId() },
        body: {
            DeviceProfile: profile, StartTimeTicks: startTicks, AutoOpenLiveStream: true,
            // antenna video is MPEG-2 (no browser plays it), so live TV is always converted on the 4090
            // "Always convert" (Settings → This device) is for troubleshooting a device that chokes on a file
            EnableDirectPlay: !live && !forceConvert(), EnableDirectStream: !live && !forceConvert(), EnableTranscoding: true,
            AllowVideoStreamCopy: !live && !forceConvert(), AllowAudioStreamCopy: !forceConvert(),
            ...(audioIndex != null ? { AudioStreamIndex: audioIndex } : {}),
        },
    })
    if (info.ErrorCode) throw new Error(info.ErrorCode)
    const src = info.MediaSources[0]
    const playSession = info.PlaySessionId
    const audios = src.MediaStreams.filter(s => s.Type === 'Audio')
    const curAudio = audioIndex ?? src.DefaultAudioStreamIndex ?? audios[0]?.Index
    let how = describe(src, profile, curAudio)
    const audioLang = audios.find(s => s.Index === curAudio)?.Language
    const subs = src.MediaStreams.filter(s => s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl)
        .map(s => ({ ...s, label: subLabel(s) }))
    let activeSub = subIndex ?? pickSub(subs, audioLang)
    let lastSub = null

    const tok = encodeURIComponent(api.token())
    let url
    if (how.mode === 'direct') {
        url = `${api.BASE}/Videos/${itemId}/stream.${(src.Container || 'mp4').split(',')[0]}?static=true&mediaSourceId=${src.Id}&PlaySessionId=${playSession}&ApiKey=${tok}`
    } else {
        url = api.BASE + src.TranscodingUrl
        if (!/[?&]api_?key=/i.test(url)) url += `&ApiKey=${tok}`
    }
    // HLS timelines start at the requested StartTimeTicks for transcodes; direct play seeks itself
    const offset = 0

    // segments (our markers), next episode
    let segs = (await api.segments(itemId)).map(s => ({ type: s.Type, start: s.StartTicks / TICKS, end: s.EndTicks / TICKS }))
    const jfSegs = segs.map(x => ({ ...x }))
    try {
        const r = await fetch('/cove-api/markers?id=' + itemId, { headers: { Authorization: api.authHeaderValue() } })
        const o = r.ok ? await r.json() : null
        if (o?.segments) segs = o.segments
    } catch {}
    let next = null
    // inside a saga, "next" is the saga's next unwatched item (another show, a movie), not the next episode
    if (saga) {
        try { next = await saga.nextAfter(itemId) } catch {}
    } else if (item.Type === 'Episode' && item.SeriesId) {
        try {
            const adj = await api.adjacent(item.SeriesId, itemId)
            const i = adj.findIndex(e => e.Id === itemId)
            next = i >= 0 ? adj[i + 1] ?? null : null
        } catch {}
    }

    // ---------------------------------------------------------------- DOM
    const video = h('video', { playsInline: true, preload: 'auto', crossOrigin: 'anonymous' })
    for (const s of subs) {
        let u = api.BASE + s.DeliveryUrl
        if (!/[?&]api_?key=/i.test(u)) u += (u.includes('?') ? '&' : '?') + `ApiKey=${tok}`
        video.append(h('track', { kind: 'subtitles', label: s.label, srclang: (s.Language || 'und').slice(0, 2), src: u, dataset: { index: s.Index } }))
    }
    const nowOn = live ? item.CurrentProgram : null
    const title = live
        ? [h('div.p-title', nowOn?.Name || item.Name), h('div.p-sub', h('span.p-live', 'LIVE'), ` ${item.ChannelNumber || item.Number || ''} ${item.Name}`)]
        : item.Type === 'Episode'
        ? [h('div.p-title', item.SeriesName), h('div.p-sub', [epNum(item), epTitle(item)].filter(Boolean).join(' · '))]
        : [h('div.p-title', item.Name), h('div.p-sub', [item.ProductionYear, item.OfficialRating].filter(Boolean).join(' · '))]
    const chip = h('button.p-chip.' + how.mode, { onclick: () => showInfo(), 'aria-label': 'How this is playing' }, how.label)
    const playBtn = h('button.p-big', { onclick: () => toggle(), 'aria-label': 'Play/Pause' }, icon('pause'))
    const bar = h('div.p-bar', { role: 'slider', 'aria-label': 'Seek', tabindex: 0 }), fill = h('div.p-fill'), buf = h('div.p-buf'), knob = h('div.p-knob')
    const marks = h('div.p-marks')
    bar.append(buf, fill, marks, knob)
    const tCur = h('span.p-time', '0:00'), tLeft = h('span.p-time', '')
    const skip = h('button.p-skip', { onclick: () => doSkip(), 'aria-live': 'polite' })
    const nextCard = h('div.p-next')
    const canFull = !!(root.requestFullscreen || root.webkitRequestFullscreen)
    const controls = h('div.p-ui',
        h('div.p-top',
            h('button.icon-btn.p-ico', { onclick: () => close(), 'aria-label': 'Close' }, icon('back')),
            h('div.p-titles', title), chip),
        h('div.p-mid',
            h('button.p-ico.p-jump', { onclick: () => seek(video.currentTime - 10), 'aria-label': 'Back 10 seconds' }, icon('back10')),
            playBtn,
            h('button.p-ico.p-jump', { onclick: () => seek(video.currentTime + 10), 'aria-label': 'Forward 10 seconds' }, icon('fwd10'))),
        h('div.p-bottom',
            h('div.p-scrub', tCur, bar, tLeft),
            h('div.p-row',
                h('div.spacer'),
                audios.length > 1 ? h('button.p-ico', { onclick: () => audioMenu(), 'aria-label': 'Audio' }, icon('audio')) : null,
                h('button.p-ico', { onclick: () => subMenu(), 'aria-label': 'Subtitles' }, icon('cc')),
                document.pictureInPictureEnabled || video.webkitSupportsPresentationMode ? h('button.p-ico', { onclick: () => pip(), 'aria-label': 'Picture in picture' }, icon('pip')) : null,
                next ? h('button.p-ico', { onclick: () => goNext(), 'aria-label': 'Next episode' }, icon('next')) : null,
                api.isAdmin() ? h('button.p-ico', { onclick: () => markerMenu(), 'aria-label': 'Fix skip markers' }, icon('flag')) : null,
                canFull ? h('button.p-ico', { onclick: () => full(), 'aria-label': 'Full screen' }, icon('full')) : null)))
    root.classList.remove('loading')
    root.replaceChildren(video, h('div.p-tap'), controls, skip, nextCard)
    const cues = subStyle.renderer(video, root)   // Cove draws the subtitles itself (subs.js)
    subStyle.refresh()

    // ---------------------------------------------------------------- source
    let hls = null
    // Chrome's new built-in HLS won't take live TS segments; there hls.js plays live TV (Safari keeps its own)
    const chromeLike = /Chrome|Edg|Firefox/.test(navigator.userAgent) && !/iPhone|iPad|CriOS|FxiOS/.test(navigator.userAgent)
    if (how.mode !== 'direct' && (!nativeHls() || (live && chromeLike))) {
        const Hls = await loadHls()
        if (!Hls?.isSupported()) throw new Error('This browser can’t play HLS')
        hls = new Hls({ startPosition: startTicks / TICKS, maxBufferLength: 60 })
        hls.loadSource(url)
        hls.attachMedia(video)
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) toast('Playback error: ' + d.details) })
    } else {
        video.src = url
    }
    // Resume: jump to where you left off. iPhone Safari often ignores the first jump on HLS, so keep trying
    // (metadata, data, canplay, playing) until it lands; until then, progress reports say the saved spot,
    // not 0:00 (that used to wipe the resume spot and drop the item from Continue Watching).
    const resumeAt = startTicks / TICKS
    let resumed = resumeAt <= 5
    const tryResume = () => {
        if (resumed) return
        if (Math.abs(video.currentTime - resumeAt) <= 3) { resumed = true; return }
        try { video.currentTime = resumeAt } catch {}
    }
    for (const ev of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'timeupdate']) video.addEventListener(ev, tryResume)
    video.addEventListener('seeking', () => { if (!resumed && Math.abs(video.currentTime - resumeAt) > 3 && video.readyState >= 2) resumed = true })
    video.addEventListener('loadedmetadata', () => { applySub(); drawMarks() }, { once: true })
    video.play().catch(() => { showUi(true); playBtn.replaceChildren(icon('play')) })

    // ---------------------------------------------------------------- progress reporting
    const method = how.mode === 'direct' ? 'DirectPlay' : how.mode === 'remux' ? 'DirectStream' : 'Transcode'
    const report = (path, extra = {}) => api.request('/Sessions/Playing' + path, {
        method: 'POST',
        body: {
            ItemId: itemId, MediaSourceId: src.Id, PlaySessionId: playSession, PlayMethod: method, LiveStreamId: src.LiveStreamId,
            PositionTicks: resumed ? Math.round((video.currentTime + offset) * TICKS) : startTicks, IsPaused: video.paused, CanSeek: true,
            AudioStreamIndex: curAudio, SubtitleStreamIndex: activeSub, ...extra,
        },
    }).catch(() => {})
    report('')
    // what the server is really doing (the reasons list in the URL over-reports audio conversion)
    if (how.mode !== 'direct') setTimeout(async () => {
        try {
            const ss = await api.request('/Sessions', { query: { deviceId: localStorage.getItem('cove.device') } })
            const ti = ss.find(x => x.PlayState?.PlaySessionId === playSession || x.NowPlayingItem?.Id === itemId)?.TranscodingInfo
            if (!ti) return
            how = verdict({ videoCopy: ti.IsVideoDirect, audioCopy: ti.IsAudioDirect, reasons: ti.TranscodeReasons || [], what: how.what,
                audioName: audios.find(x => x.Index === curAudio)?.DisplayTitle, hw: !!ti.HardwareAccelerationType })
            chip.className = 'p-chip ' + how.mode
            chip.textContent = how.label
        } catch {}
    }, 4000)
    const tick = setInterval(() => report('/Progress', { EventName: 'TimeUpdate' }), 10_000)
    video.addEventListener('pause', () => report('/Progress', { EventName: 'Pause' }))
    video.addEventListener('play', () => report('/Progress', { EventName: 'Unpause' }))
    let stopped = false
    state.stop = async () => {
        if (stopped) return
        stopped = true
        clearInterval(tick)
        clearTimeout(hideTimer); clearInterval(countdown)
        removeEventListener('keydown', onKey)
        await report('/Stopped')
        if (saga && dur() && video.currentTime / dur() > 0.9) saga.done(itemId)
        if (how.mode !== 'direct') api.request('/Videos/ActiveEncodings', { method: 'DELETE', query: { deviceId: localStorage.getItem('cove.device'), playSessionId: playSession } }).catch(() => {})
        hls?.destroy()
        cues.destroy()
        video.removeAttribute('src'); video.load()
        if (src.LiveStreamId) api.request('/LiveStreams/Close', { method: 'POST', query: { liveStreamId: src.LiveStreamId } }).catch(() => {})
    }

    // ---------------------------------------------------------------- behavior
    function toggle() { video.paused ? video.play() : video.pause() }
    function seek(t) { if (live) return; resumed = true; video.currentTime = Math.max(0, Math.min(t, (video.duration || 1e9) - 0.5)); showUi() }
    video.addEventListener('play', () => playBtn.replaceChildren(icon('pause')))
    video.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); showUi(true) })
    video.addEventListener('waiting', () => root.classList.add('buffering'))
    video.addEventListener('playing', () => root.classList.remove('buffering'))

    let hideTimer
    function showUi(stay = false) {
        root.classList.add('ui')
        clearTimeout(hideTimer)
        if (!stay && !video.paused) hideTimer = setTimeout(() => root.classList.remove('ui'), 3200)
    }
    root.querySelector('.p-tap').addEventListener('click', () => root.classList.contains('ui') ? root.classList.remove('ui') : showUi())
    root.querySelector('.p-tap').addEventListener('dblclick', e => {
        const r = root.getBoundingClientRect()
        seek(video.currentTime + (e.clientX - r.left < r.width / 2 ? -10 : 10))
    })
    root.addEventListener('mousemove', () => showUi())
    root.addEventListener('pointerdown', () => sessionStorage.setItem('cove.streak', '0'))
    addEventListener('keydown', () => sessionStorage.setItem('cove.streak', '0'))
    showUi()

    const dur = () => video.duration && isFinite(video.duration) ? video.duration : (item.RunTimeTicks || 0) / TICKS
    video.addEventListener('timeupdate', () => {
        const t = video.currentTime, d = dur()
        fill.style.width = (d ? t / d * 100 : 0) + '%'
        knob.style.left = fill.style.width
        tCur.textContent = clock(t)
        tLeft.textContent = '-' + clock(d - t)
        try { const b = video.buffered; if (b.length) buf.style.width = (b.end(b.length - 1) / d * 100) + '%' } catch {}
        segmentCheck(t)
    })
    // scrubbing
    let dragging = false
    const posFrom = e => {
        const r = bar.getBoundingClientRect()
        const x = (e.touches?.[0] ?? e).clientX
        return Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur()
    }
    const onDown = e => { dragging = true; root.classList.add('scrubbing'); onMove(e) }
    const onMove = e => {
        if (!dragging) return
        const t = posFrom(e)
        fill.style.width = knob.style.left = (t / dur() * 100) + '%'
        tCur.textContent = clock(t)
        bar.dataset.t = t
    }
    const onUp = () => {
        if (!dragging) return
        dragging = false; root.classList.remove('scrubbing')
        seek(+bar.dataset.t)
    }
    bar.addEventListener('pointerdown', onDown)
    addEventListener('pointermove', onMove)
    addEventListener('pointerup', onUp)

    function drawMarks() {
        const d = dur()
        if (!d) return
        marks.replaceChildren(...segs.map(s => h('div.p-mark.' + s.type.toLowerCase(), {
            style: { left: (s.start / d * 100) + '%', width: (Math.max(0.4, (Math.min(s.end, d) - s.start) / d * 100)) + '%' },
        })))
    }

    // ---------------------------------------------------------------- skips our way
    const SKIP_LABEL = { Intro: 'Skip Intro', Recap: 'Skip Recap', Preview: 'Skip Preview', Commercial: 'Skip' }
    let current = null, nextShown = false, dismissed = new Set()
    // the person's choices (Settings → Playback): show a button, skip on its own, or do nothing
    const pp = { ...playPrefs.get() }; playPrefs.refresh().then(x => Object.assign(pp, x))
    const skipPref = type => type === 'Recap' ? pp.recap : type === 'Intro' ? pp.intro : 'button'
    function segmentCheck(t) {
        const s = segs.find(s => t >= s.start && t < s.end - 0.5 && !dismissed.has(s))
        if (s?.type === 'Outro') {
            if (!nextShown) {
                if (pp.credits === 'off') { nextShown = true; dismissed.add(s) }
                else if (pp.credits === 'auto' && next) { nextShown = true; goNext() }
                else showNext(s)
            }
            skip.classList.remove('show'); current = null
            return
        }
        if (s && SKIP_LABEL[s.type] && skipPref(s.type) !== 'button') {
            dismissed.add(s)
            // skip on its own only when the video runs into it, not when someone jumps into the middle on purpose
            if (skipPref(s.type) === 'auto' && t - s.start < 3 && !video.paused) { seek(s.end); toast(SKIP_LABEL[s.type].replace('Skip', 'Skipped')) }
            return
        }
        if (s !== current) {
            current = s ?? null
            if (s && SKIP_LABEL[s.type]) { skip.textContent = SKIP_LABEL[s.type]; skip.classList.add('show') }
            else skip.classList.remove('show')
        }
    }
    function doSkip() {
        if (!current) return
        seek(current.end)
        dismissed.add(current)
        skip.classList.remove('show'); current = null
    }
    function showNext(seg) {
        nextShown = true
        if (next) {
            const im = api.img(next, 'Primary', { w: 400 })
            nextCard.replaceChildren(
                im ? h('img', { src: im, alt: '' }) : null,
                h('div.p-next-text',
                    h('div.small.muted', 'Up next'),
                    h('div.p-next-title', next.Type === 'Episode' ? [saga ? next.SeriesName : null, epNum(next), epTitle(next)].filter(Boolean).join(' · ') : next.Name)),
                h('div.p-next-btns',
                    h('button.btn.primary', { onclick: () => goNext() }, icon('next'), saga ? ' Next in Saga' : next.Type === 'Movie' ? ' Next Movie' : ' Next Episode'),
                    h('button.btn', { onclick: () => { dismissed.add(seg); nextCard.classList.remove('show') } }, 'Watch credits')))
        } else {
            nextCard.replaceChildren(h('div.p-next-btns',
                h('button.btn.primary', { onclick: () => finish() }, 'Skip Credits'),
                h('button.btn', { onclick: () => { dismissed.add(seg); nextCard.classList.remove('show') } }, 'Watch credits')))
        }
        nextCard.classList.add('show')
    }
    let countdown
    video.addEventListener('ended', () => {
        if (!next) return finish()
        if (pp.autoplay === 'off') {
            nextShown = true
            nextCard.replaceChildren(h('div.p-next-text', h('div.p-next-title', 'Up next')),
                h('div.p-next-btns', h('button.btn.primary', { onclick: () => goNext() }, 'Play next'), h('button.btn', { onclick: () => finish() }, 'Done')))
            nextCard.classList.add('show')
            return
        }
        // "Still watching?" after N in a row that played on by themselves (any tap on the player resets it)
        const streak = +(sessionStorage.getItem('cove.streak') || 0) + 1
        if (+pp.stillWatching && streak >= +pp.stillWatching) {
            nextShown = true
            nextCard.replaceChildren(h('div.p-next-text', h('div.p-next-title', 'Still watching?')),
                h('div.p-next-btns', h('button.btn.primary', { onclick: () => { sessionStorage.setItem('cove.streak', '0'); goNext() } }, 'Keep watching'), h('button.btn', { onclick: () => finish() }, 'I’m done')))
            nextCard.classList.add('show')
            return
        }
        sessionStorage.setItem('cove.streak', String(streak))
        let n = +pp.countdown || 8
        nextShown = true
        const what = saga ? 'Next in saga' : 'Next episode'
        const label = h('span', `${what} in ${n}`)
        nextCard.replaceChildren(h('div.p-next-text', h('div.p-next-title', label)),
            h('div.p-next-btns', h('button.btn.primary', { onclick: () => goNext() }, 'Play now'),
                h('button.btn', { onclick: () => { clearInterval(countdown); nextCard.classList.remove('show') } }, 'Cancel')))
        nextCard.classList.add('show')
        countdown = setInterval(() => { n -= 1; label.textContent = `${what} in ${n}`; if (n <= 0) goNext() }, 1000)
    })
    async function finish() {
        await api.setPlayed(itemId, true).catch(() => {})
        if (saga) await saga.done(itemId)
        close()
    }
    async function goNext() {
        if (!next) return
        clearInterval(countdown)
        await api.setPlayed(itemId, true).catch(() => {})
        if (saga) await saga.done(itemId)
        await state.stop()
        root.replaceChildren(h('div.spinner')); root.classList.add('loading')
        state.stop = null
        try { await start(root, next.Id, { fromStart: false, close, state, saga }) }
        catch (e) { root.classList.remove('loading'); root.replaceChildren(h('div.player-error', h('p', 'Next episode won’t play: ' + e.message), h('button.btn', { onclick: close }, 'Close'))) }
    }

    // ---------------------------------------------------------------- menus
    function applySub() {
        const el = [...video.querySelectorAll('track')].find(x => +x.dataset.index === activeSub)
        cues.setTrack(el ? el.track : null)
    }
    // size, height and timing while watching; size and height are saved to the person's style
    function subTools() {
        const st = () => subStyle.style()
        const out = (v, f) => h('output', f(v))
        const line = (label, get, f, minus, plus) => {
            const o = out(get(), f)
            const redo = () => { o.textContent = f(get()) }
            return h('div.p-subtools', h('span', label),
                h('button.pill.glass.small', { onclick: () => { minus(); redo() }, 'aria-label': label + ' down' }, '−'), o,
                h('button.pill.glass.small', { onclick: () => { plus(); redo() }, 'aria-label': label + ' up' }, '+'))
        }
        const clampSave = (k, d, lo, hi) => subStyle.save({ ...st(), [k]: Math.max(lo, Math.min(hi, st()[k] + d)) })
        sheet([
            line('Size', () => st().size, v => v + '%', () => clampSave('size', -10, 50, 250), () => clampSave('size', 10, 50, 250)),
            line('Height', () => st().bottom, v => v + '%', () => clampSave('bottom', -2, 0, 40), () => clampSave('bottom', 2, 0, 40)),
            line('Timing', () => cues.delay, v => (v > 0 ? '+' : '') + v.toFixed(1) + ' s', () => { cues.delay -= 0.1 }, () => { cues.delay += 0.1 }),
            h('p.muted.small.form-pad', 'Timing: + if the words come too early, − if too late. Only for this video.'),
            h('a.menu-row', { href: '#/settings/subtitles', onclick: () => close() }, h('span', 'All subtitle styles'), icon('chevron')),
        ], { title: 'Subtitle look', className: 'menu' })
    }
    function subMenu() {
        const cur = api.subsMode()
        const row = (label, on, fn, note) => h('button.menu-row', { onclick: () => { fn(); s.close() } },
            h('span', label, note ? h('span.muted.small', ' ' + note) : null), on ? icon('check') : null)
        const s = sheet([
            row('Off', activeSub === -1, () => { activeSub = -1; applySub() }),
            ...subs.map(x => row(x.label, activeSub === x.Index, () => { activeSub = x.Index; applySub() })),
            h('div.menu-label', 'Default for everything'),
            row('Smart', cur === 'smart', () => api.setSubsMode('smart'), 'forced English only, full English when the audio isn’t English'),
            row('Always English', cur === 'always', () => api.setSubsMode('always')),
            row('Off', cur === 'off', () => api.setSubsMode('off')),
            h('button.menu-row', { onclick: () => { s.close(); subTools() } }, h('span', 'Size, height and timing'), icon('chevron')),
        ], { title: 'Subtitles', className: 'menu' })
    }
    function audioMenu() {
        const s = sheet(audios.map(a => h('button.menu-row', {
            onclick: async () => {
                s.close()
                if (a.Index === curAudio) return
                const pos = video.currentTime
                await state.stop(); state.stop = null
                root.replaceChildren(h('div.spinner')); root.classList.add('loading')
                await start(root, itemId, { close, state, audioIndex: a.Index, subIndex: activeSub, at: pos })
            },
        }, h('span', a.DisplayTitle || a.Language || 'Track ' + a.Index), a.Index === curAudio ? icon('check') : null)),
        { title: 'Audio', className: 'menu' })
    }
    function markerMenu() {
        const name = { Intro: 'Intro', Recap: 'Recap', Outro: 'Credits', Preview: 'Preview', Commercial: 'Ad' }
        const list = h('div.mk-list', ...(segs.length ? segs.slice().sort((a, b) => a.start - b.start).map(x => h('div.mk-row.ro',
            h('span.mk-type', name[x.type] || x.type),
            h('span.mk-time', x.type === 'Outro' ? 'from ' + clock(x.start) : clock(x.start) + ' – ' + clock(x.end)))) : [h('p.muted.small', 'No skip markers on this one.')]))
        const note = h('textarea.text-input.mk-note', { placeholder: 'What’s wrong? (optional) e.g. "skip intro ends too early", "no recap button"', rows: 3 })
        const who = api.cachedServerInfo().reportsTo   // who reads these reports (server setting server.reportsTo)
        const label = who ? `Send to ${who} to fix` : 'Send it to be fixed'
        const send = h('button.pill.white.block', { onclick: async () => {
            send.disabled = true; send.textContent = 'Sending…'
            try {
                await api.helper('/markers', { itemId, report: true, note: note.value, at: Math.round(video.currentTime), jellyfin: jfSegs, segments: segs })
                toast(who ? `Sent to ${who}. The fix will show up here once it’s done.` : 'Sent. The fix will show up here once it’s done.', 3500); m.close()
            } catch (e) { toast('Couldn’t send: ' + e.message); send.disabled = false; send.textContent = label }
        } }, icon('flag'), ' ' + label)
        const m = sheet([h('div.form-pad', h('p.muted.small', `Skip buttons not right on this one? ${who || 'The owner'} will look at it and fix the markers.`), list, note, send)],
            { title: 'Skip markers', className: 'menu' })
    }
    function showInfo() {
        sheet([
            h('div.info-mode.' + how.mode, how.label),
            h('p', how.detail),
            h('p.muted.small', how.what),
            src.Bitrate ? h('p.muted.small', `File bitrate ${(src.Bitrate / 1e6).toFixed(1)} Mbps`) : null,
        ], { title: 'How this is playing', className: 'menu' })
    }
    function pip() {
        if (video.webkitSupportsPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture')
        else if (document.pictureInPictureElement) document.exitPictureInPicture()
        else video.requestPictureInPicture?.()
    }
    function full() {
        if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document)
        else (root.requestFullscreen || root.webkitRequestFullscreen).call(root)
    }
    function onKey(e) {
        if (document.querySelector('.sheet-wrap')) return
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle() }
        else if (e.key === 'ArrowLeft') seek(video.currentTime - 10)
        else if (e.key === 'ArrowRight') seek(video.currentTime + 10)
        else if (e.key === 'j') seek(video.currentTime - 30)
        else if (e.key === 'l') seek(video.currentTime + 30)
        else if (e.key === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; toast(`Volume ${Math.round(video.volume * 100)}%`, 900) }
        else if (e.key === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); toast(`Volume ${Math.round(video.volume * 100)}%`, 900) }
        else if (e.key === 'm') { video.muted = !video.muted; toast(video.muted ? 'Muted' : 'Sound on', 900) }
        else if (e.key === 'c') { if (activeSub !== -1) { lastSub = activeSub; activeSub = -1 } else activeSub = lastSub ?? subs[0]?.Index ?? -1; applySub(); toast(activeSub === -1 ? 'Subtitles off' : 'Subtitles on', 900) }
        else if (e.key === 'n' && next) goNext()
        else if (e.key === 'p') pip()
        else if (e.key === '>' || e.key === '<') { if (live) return; const r = Math.max(0.5, Math.min(2, Math.round((video.playbackRate + (e.key === '>' ? 0.25 : -0.25)) * 100) / 100)); video.playbackRate = r; toast(`Speed ${r}×`, 900) }
        else if (e.key === 'f') full()
        else if (e.key === 's' && current) doSkip()
        else if (e.key === 'Escape' && !document.fullscreenElement) close()
        else return
        showUi()
    }
    addEventListener('keydown', onKey)
    // pause when switching to another tab or app (Settings can turn it off); not while in picture in picture
    const onHide = () => {
        if (!document.hidden || localStorage.getItem('cove.autopause') === 'off') return
        if (document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture') return
        video.pause()
    }
    document.addEventListener('visibilitychange', onHide)
    const prevStop = state.stop
    state.stop = async () => { document.removeEventListener('visibilitychange', onHide); await prevStop() }
}
