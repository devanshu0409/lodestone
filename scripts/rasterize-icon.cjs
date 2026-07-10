/**
 * Rasterize build/icon.svg into the icon assets, using the already-installed
 * Electron binary (no native image deps):
 *
 *   build/icon.png       1024² PNG with transparent corners (electron-builder
 *                        derives macOS/Linux icons from this)
 *   build/icon@512.png   512² PNG (Linux/dev convenience)
 *   build/icon.ico       true multi-size Windows icon:
 *                          16/24/32/48px  — SIMPLIFIED mark (magnifier only,
 *                                           thicker strokes) so the title bar /
 *                                           taskbar icon stays legible
 *                          64/128px       — full design (BMP entries)
 *                          256px          — full design (PNG entry)
 *
 * Windows renders title-bar icons at 16px; the full design (document lines +
 * magnifier) turns to mush there, which is why the small entries use the
 * simplified mark. Run with: npm run make-icons
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const buildDir = join(root, 'build')
mkdirSync(buildDir, { recursive: true })
const fullSvg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')

// Small-size variant: same gradient tile, magnifier only, oversized strokes.
const simpleSvg = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1b9e94;stop-opacity:1"></stop>
      <stop offset="100%" style="stop-color:#2a6fdb;stop-opacity:1"></stop>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#grad)"></rect>
  <circle cx="118" cy="112" r="58" fill="none" stroke="white" stroke-width="26"></circle>
  <line x1="160" y1="154" x2="204" y2="198" stroke="white" stroke-width="30" stroke-linecap="round"></line>
</svg>`

// The GPU stack on this environment is unreliable; software compositing keeps
// the offscreen render deterministic.
app.disableHardwareAcceleration()

async function renderPngBuffer(win, svg, size) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${size}; canvas.height = ${size};
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, ${size}, ${size});
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return canvas.toDataURL('image/png');
  })()`)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

async function renderRgba(win, svg, size) {
  const arr = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${size}; canvas.height = ${size};
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, ${size}, ${size});
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return Array.from(ctx.getImageData(0, 0, ${size}, ${size}).data);
  })()`)
  return Buffer.from(arr)
}

/** One 32bpp BMP (BITMAPINFOHEADER) ICO entry: XOR pixels bottom-up + empty AND mask. */
function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  const maskRowBytes = ((size + 31) >> 5) * 4
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4
      const dst = ((size - 1 - y) * size + x) * 4 // bottom-up
      xor[dst] = rgba[src + 2] // B
      xor[dst + 1] = rgba[src + 1] // G
      xor[dst + 2] = rgba[src] // R
      xor[dst + 3] = rgba[src + 3] // A
    }
  }
  const and = Buffer.alloc(maskRowBytes * size) // all 0 — transparency comes from alpha
  header.writeUInt32LE(xor.length + and.length, 20) // biSizeImage
  return Buffer.concat([header, xor, and])
}

/** Assemble an .ico from [{size, data, isPng}] entries. */
function buildIco(entries) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dirEntries = []
  for (const e of entries) {
    const d = Buffer.alloc(16)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0) // width (0 = 256)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1) // height
    d.writeUInt8(0, 2) // color count
    d.writeUInt8(0, 3) // reserved
    d.writeUInt16LE(1, 4) // planes
    d.writeUInt16LE(32, 6) // bit count
    d.writeUInt32LE(e.data.length, 8) // bytes in resource
    d.writeUInt32LE(offset, 12) // image offset
    offset += e.data.length
    dirEntries.push(d)
  }
  return Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await win.loadURL('about:blank')

    writeFileSync(join(buildDir, 'icon.png'), await renderPngBuffer(win, fullSvg, 1024))
    writeFileSync(join(buildDir, 'icon@512.png'), await renderPngBuffer(win, fullSvg, 512))

    const entries = []
    for (const size of [16, 24, 32, 48]) {
      entries.push({ size, data: bmpEntry(await renderRgba(win, simpleSvg, size), size), isPng: false })
    }
    for (const size of [64, 128]) {
      entries.push({ size, data: bmpEntry(await renderRgba(win, fullSvg, size), size), isPng: false })
    }
    entries.push({ size: 256, data: await renderPngBuffer(win, fullSvg, 256), isPng: true })
    writeFileSync(join(buildDir, 'icon.ico'), buildIco(entries))

    // Eyeball previews for the small sizes (not shipped).
    writeFileSync(join(buildDir, '_preview-simple-32.png'), await renderPngBuffer(win, simpleSvg, 32))

    console.log('Wrote build/icon.png, build/icon@512.png, build/icon.ico (16/24/32/48 simplified + 64/128/256 full)')
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
