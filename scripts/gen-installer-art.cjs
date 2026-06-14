'use strict'
// Generates the NSIS installer-wizard artwork to match the app's look:
//   build/installerSidebar.bmp  (164×314) — the welcome/finish panel
//   build/installerHeader.bmp   (150×57)  — the inner-page header strip
// Warm off-white background + the brand orange logo tile with white code brackets.
// No text (no font engine available) — the wizard prints the product name itself.
// 24-bit BI_RGB BMP (what MUI expects); rendered at 4× and box-downsampled for AA.
const fs = require('node:fs')
const path = require('node:path')

const ORANGE = [0xcf, 0x5b, 0x28]
const WHITE = [0xff, 0xff, 0xff]
const SS = 4

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// A painter over an opaque RGB float canvas (src-over blending). Coordinates are in
// logical (output) pixels; everything is scaled by SS internally.
function makeCanvas(W, H) {
  const hw = W * SS
  const hh = H * SS
  const rgb = new Float32Array(hw * hh * 3)

  const blend = (x, y, c, a) => {
    if (x < 0 || y < 0 || x >= hw || y >= hh || a <= 0) return
    const i = (y * hw + x) * 3
    const ia = 1 - a
    rgb[i] = c[0] * a + rgb[i] * ia
    rgb[i + 1] = c[1] * a + rgb[i + 1] * ia
    rgb[i + 2] = c[2] * a + rgb[i + 2] * ia
  }

  // vertical gradient fill (top → bottom)
  const gradient = (top, bot) => {
    for (let y = 0; y < hh; y++) {
      const t = y / (hh - 1)
      const r = top[0] + (bot[0] - top[0]) * t
      const g = top[1] + (bot[1] - top[1]) * t
      const b = top[2] + (bot[2] - top[2]) * t
      for (let x = 0; x < hw; x++) {
        const i = (y * hw + x) * 3
        rgb[i] = r
        rgb[i + 1] = g
        rgb[i + 2] = b
      }
    }
  }

  // soft radial glow centered at (cx,cy)
  const glow = (cx, cy, radius, c, peak) => {
    const CX = cx * SS
    const CY = cy * SS
    const R = radius * SS
    for (let y = Math.max(0, Math.floor(CY - R)); y < Math.min(hh, Math.ceil(CY + R)); y++) {
      for (let x = Math.max(0, Math.floor(CX - R)); x < Math.min(hw, Math.ceil(CX + R)); x++) {
        const d = Math.hypot(x - CX, y - CY) / R
        if (d >= 1) continue
        const f = (1 - d) * (1 - d) // smooth falloff
        blend(x, y, c, peak * f)
      }
    }
  }

  // filled rounded rectangle (logical units), src-over at alpha
  const roundRect = (x0, y0, w, h, r, c, a = 1) => {
    const X = x0 * SS
    const Y = y0 * SS
    const W2 = w * SS
    const H2 = h * SS
    const R = r * SS
    const cx = X + W2 / 2
    const cy = Y + H2 / 2
    const hw2 = W2 / 2
    const hh2 = H2 / 2
    for (let y = Math.floor(Y); y < Math.ceil(Y + H2); y++) {
      for (let x = Math.floor(X); x < Math.ceil(X + W2); x++) {
        const qx = Math.abs(x + 0.5 - cx) - (hw2 - R)
        const qy = Math.abs(y + 0.5 - cy) - (hh2 - R)
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R
        if (sd <= 0) blend(x, y, c, a)
      }
    }
  }

  // round-capped polyline stroke (logical units)
  const stroke = (pts, halfW, c, a = 1) => {
    const P = pts.map(([x, y]) => [x * SS, y * SS])
    const HWp = halfW * SS
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of P) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    for (let y = Math.max(0, Math.floor(minY - HWp)); y < Math.min(hh, Math.ceil(maxY + HWp)); y++) {
      for (let x = Math.max(0, Math.floor(minX - HWp)); x < Math.min(hw, Math.ceil(maxX + HWp)); x++) {
        let d = Infinity
        for (let k = 0; k + 1 < P.length; k++) {
          const v = segDist(x + 0.5, y + 0.5, P[k][0], P[k][1], P[k + 1][0], P[k + 1][1])
          if (v < d) d = v
        }
        if (d <= HWp) blend(x, y, c, a)
      }
    }
  }

  // the brand logo: orange rounded tile + white `< >` brackets, centered on (cx,cy)
  const logo = (cx, cy, size, opts = {}) => {
    const tile = size
    const r = size * 0.27
    // soft drop shadow (a few expanding low-alpha passes)
    if (opts.shadow !== false) {
      for (let s = 0; s < 3; s++) {
        const grow = 2 + s * 4
        roundRect(cx - tile / 2 - grow, cy - tile / 2 + 6 + s * 2, tile + grow * 2, tile + grow * 2, r + grow, [0x6b, 0x2c, 0x12], 0.06)
      }
    }
    roundRect(cx - tile / 2, cy - tile / 2, tile, tile, r, ORANGE)
    // brackets authored in a 24-unit box (svg: <9,8 5,12 9,16> / <15,8 19,12 15,16>)
    const g = (size * 0.46) / 8 // glyph spans ~±4 units → ~0.46*size wide
    const sw = 1.3 * g
    const L = [
      [cx - 3 * g, cy - 4 * g],
      [cx - 7 * g, cy],
      [cx - 3 * g, cy + 4 * g]
    ]
    const R = [
      [cx + 3 * g, cy - 4 * g],
      [cx + 7 * g, cy],
      [cx + 3 * g, cy + 4 * g]
    ]
    stroke(L, sw, WHITE)
    stroke(R, sw, WHITE)
  }

  // box-downsample SS×SS → W×H, return 24-bit RGB rows (top-down, [r,g,b])
  const resolve = () => {
    const out = Buffer.alloc(W * H * 3)
    const n = SS * SS
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0
        let g = 0
        let b = 0
        for (let dy = 0; dy < SS; dy++) {
          for (let dx = 0; dx < SS; dx++) {
            const i = ((y * SS + dy) * hw + (x * SS + dx)) * 3
            r += rgb[i]
            g += rgb[i + 1]
            b += rgb[i + 2]
          }
        }
        const o = (y * W + x) * 3
        out[o] = Math.round(r / n)
        out[o + 1] = Math.round(g / n)
        out[o + 2] = Math.round(b / n)
      }
    }
    return out
  }

  return { gradient, glow, roundRect, stroke, logo, resolve, W, H }
}

// 24-bit BI_RGB BMP (bottom-up, BGR, 4-byte aligned rows) from top-down RGB.
function bmpEncode(W, H, rgb) {
  const rowSize = Math.floor((24 * W + 31) / 32) * 4
  const pixels = rowSize * H
  const buf = Buffer.alloc(14 + 40 + pixels)
  // BITMAPFILEHEADER
  buf.write('BM', 0, 'latin1')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10) // pixel data offset
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(W, 18)
  buf.writeInt32LE(H, 22) // positive → bottom-up
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(0, 30) // BI_RGB
  buf.writeUInt32LE(pixels, 34)
  buf.writeInt32LE(2835, 38) // 72 DPI
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < H; y++) {
    const srcY = H - 1 - y // flip to bottom-up
    let p = 54 + y * rowSize
    for (let x = 0; x < W; x++) {
      const i = (srcY * W + x) * 3
      buf[p++] = rgb[i + 2] // B
      buf[p++] = rgb[i + 1] // G
      buf[p++] = rgb[i] // R
    }
  }
  return buf
}

const BG_TOP = [0xfd, 0xfb, 0xf8]
const BG_BOT = [0xf3, 0xea, 0xe0]

// ── sidebar 164×314 ──
{
  const c = makeCanvas(164, 314)
  c.gradient(BG_TOP, BG_BOT)
  c.glow(82, 120, 120, ORANGE, 0.13) // warm halo behind the logo
  c.logo(82, 120, 96) // brand tile
  c.roundRect(82 - 22, 200, 44, 4, 2, ORANGE) // accent underline
  // oversized faint bracket watermark near the bottom for subtle texture
  const g = 6
  c.stroke(
    [
      [82 - 3 * g, 268 - 4 * g],
      [82 - 7 * g, 268],
      [82 - 3 * g, 268 + 4 * g]
    ],
    1.3 * g,
    ORANGE,
    0.05
  )
  c.stroke(
    [
      [82 + 3 * g, 268 - 4 * g],
      [82 + 7 * g, 268],
      [82 + 3 * g, 268 + 4 * g]
    ],
    1.3 * g,
    ORANGE,
    0.05
  )
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'installerSidebar.bmp'), bmpEncode(164, 314, c.resolve()))
}

// ── header 150×57 ── (logo on the right; wizard prints the title text on the left)
{
  const c = makeCanvas(150, 57)
  c.gradient([0xfd, 0xfc, 0xfa], [0xfb, 0xf7, 0xf2])
  c.logo(122, 28, 38)
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'installerHeader.bmp'), bmpEncode(150, 57, c.resolve()))
}

console.log('[gen-installer-art] wrote build/installerSidebar.bmp (164×314) + build/installerHeader.bmp (150×57)')
