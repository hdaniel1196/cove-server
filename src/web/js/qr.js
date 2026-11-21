// QR codes for "Connect an app" (Nov 21, 2026): Cove's own small encoder, no library. Byte mode, error correction
// level M, versions 1 to 10 (up to 213 bytes), best of the 8 masks by the standard penalty rules. Checked module for
// module against the python qrcode library for every version and mask.
const EC_M = {   // version: [ec codewords per block, [[blocks, data codewords per block], ...]]
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
    6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
}
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }

// GF(256) for Reed-Solomon
const EXP = new Array(512), LOG = new Array(256)
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0
function rsRemainder(data, n) {
    let gen = [1]
    for (let i = 0; i < n; i++) {
        const next = new Array(gen.length + 1).fill(0)
        for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]) }
        gen = next
    }
    const rem = new Array(n).fill(0)
    for (const d of data) {
        const f = d ^ rem.shift(); rem.push(0)
        for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f)
    }
    return rem
}

function codewords(bytes, v) {
    const [ecn, groups] = EC_M[v]
    const dataLen = groups.reduce((s, [b, d]) => s + b * d, 0)
    const bits = []
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16)
    for (const b of bytes) put(b, 8)
    put(0, Math.min(4, dataLen * 8 - bits.length))
    while (bits.length % 8) bits.push(0)
    const data = []
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0))
    for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad)
    const blocks = [], ecs = []
    let k = 0
    for (const [b, d] of groups) for (let i = 0; i < b; i++) { const blk = data.slice(k, k + d); k += d; blocks.push(blk); ecs.push(rsRemainder(blk, ecn)) }
    const out = []
    const maxD = Math.max(...blocks.map(b => b.length))
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) out.push(b[i])
    for (let i = 0; i < ecn; i++) for (const e of ecs) out.push(e[i])
    return out
}

function bch(value, poly, polyBits) {
    let v = value << (polyBits - 1)
    for (let i = 31; i >= polyBits - 1; i--) if ((v >> i) & 1) v ^= poly << (i - (polyBits - 1))
    return (value << (polyBits - 1)) | v
}

const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0]

function build(v, cw, mask) {
    const n = 17 + 4 * v
    const m = Array.from({ length: n }, () => new Array(n).fill(null))   // null = free for data
    const set = (r, c, on) => { m[r][c] = on ? 1 : 0 }
    const finder = (r0, c0) => {
        for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
            const rr = r0 + r, cc = c0 + c
            if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
            const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
            set(rr, cc, ring !== 2 && ring !== 4)
        }
    }
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0)
    for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
    const al = ALIGN[v] || []
    const last = al.length - 1
    for (let ai = 0; ai < al.length; ai++) for (let aj = 0; aj < al.length; aj++) {
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === last) || (ai === last && aj === 0)) continue   // finder corners only
        const r = al[ai], c = al[aj]
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
    }
    // reserve format and version areas (filled after masking)
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0 }
    for (let i = 0; i < 8; i++) { if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0; if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0 }
    set(n - 8, 8, true)   // dark module
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][n - 11 + j] = 0; m[n - 11 + j][i] = 0 }
    const isData = m.map(row => row.map(x => x === null))
    // data, zig-zag from the bottom right, two columns at a time
    const bits = []
    for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
    let bi = 0, up = true
    for (let c = n - 1; c > 0; c -= 2) {
        if (c === 6) c--
        for (let k = 0; k < n; k++) {
            const r = up ? n - 1 - k : k
            for (const cc of [c, c - 1]) if (isData[r][cc]) m[r][cc] = bi < bits.length ? bits[bi++] : 0
        }
        up = !up
    }
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (isData[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1
    // format info: level M = 00
    const f = bch((0 << 3) | mask, 0x537, 11) ^ 0x5412
    for (let i = 0; i < 15; i++) {
        const bit = (f >> i) & 1
        if (i < 6) m[i][8] = bit; else if (i < 8) m[i + 1][8] = bit; else m[n - 15 + i][8] = bit
        if (i < 8) m[8][n - 1 - i] = bit; else if (i < 9) m[8][15 - i] = bit; else m[8][14 - i] = bit
    }
    if (v >= 7) {
        const vi = bch(v, 0x1f25, 13)
        for (let i = 0; i < 18; i++) { const bit = (vi >> i) & 1; const a = Math.floor(i / 3), b = i % 3; m[a][n - 11 + b] = bit; m[n - 11 + b][a] = bit }
    }
    return m
}

function penalty(m) {
    const n = m.length
    let p = 0
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
        let run = 1
        for (let j = 1; j < n; j++) {
            const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1]
            if (a === b) run++; else { if (run >= 5) p += run - 2; run = 1 }
        }
        if (run >= 5) p += run - 2
    }
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const x = m[r][c]; if (x === m[r][c + 1] && x === m[r + 1][c] && x === m[r + 1][c + 1]) p += 3 }
    const pat = [1, 0, 1, 1, 1, 0, 1], quiet = [0, 0, 0, 0]
    const at = (line, i, seq) => seq.every((s, k) => line[i + k] === s)
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
        const line = pass ? m.map(row => row[i]) : m[i]
        for (let j = 0; j + 7 <= n; j++) if (at(line, j, pat)) {
            const before = j >= 4 && at(line, j - 4, quiet), after = j + 11 <= n && at(line, j + 7, quiet)
            if (before) p += 40
            if (after) p += 40
        }
    }
    let dark = 0
    for (const row of m) for (const x of row) dark += x
    p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10
    return p
}

export function qrMatrix(text, { mask = null, version = null } = {}) {
    const bytes = Array.from(new TextEncoder().encode(text))
    let v = version
    if (!v) for (v = 1; v <= 10; v++) { const [, g] = EC_M[v]; const cap = g.reduce((s, [b, d]) => s + b * d, 0) - (v < 10 ? 2 : 3); if (bytes.length <= cap) break }
    if (v > 10) throw new Error('Too long for a QR code here')
    const cw = codewords(bytes, v)
    if (mask != null) return build(v, cw, mask)
    let best = null, bestP = Infinity
    for (let k = 0; k < 8; k++) { const mm = build(v, cw, k); const p = penalty(mm); if (p < bestP) { bestP = p; best = mm } }
    return best
}

// SVG string, dark modules on transparent, with the standard 4-module quiet zone
export function qrSvg(text, { dark = '#0b0d14', light = '#ffffff' } = {}) {
    const m = qrMatrix(text), n = m.length, q = 4, size = n + q * 2
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="${light}"/><path fill="${dark}" d="${d}"/></svg>`
}
