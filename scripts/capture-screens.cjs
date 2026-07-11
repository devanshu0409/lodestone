/**
 * Capture README screenshots from the renderer's mock preview (no real
 * clusters, no internal hostnames). Requires the renderer dev server:
 *
 *   npm run dev -- --rendererOnly     (in another terminal)
 *   npx electron scripts/capture-screens.cjs [http://localhost:5173]
 *
 * Loads the app WITHOUT the preload bridge, so the renderer falls back to the
 * bundled mock devBridge — exactly what `--rendererOnly` shows in a browser.
 * Writes PNGs to docs/screens/.
 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const URL = process.argv[2] ?? 'http://localhost:5173'
const outDir = join(__dirname, '..', 'docs', 'screens')
mkdirSync(outDir, { recursive: true })

app.disableHardwareAcceleration()
nativeTheme.themeSource = 'dark' // the theme that photographs best

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  await sleep(450) // let layout/Monaco settle
  const img = await win.capturePage()
  writeFileSync(join(outDir, `${name}.png`), img.toPNG())
  console.log(`  ${name}.png`)
}

const js = async (win, label, code) => {
  try {
    const res = await win.webContents.executeJavaScript(
      `(async () => { try { ${code}; return 'ok' } catch (e) { return 'PAGE_ERR: ' + (e && e.message ? e.message : String(e)) } })()`
    )
    if (typeof res === 'string' && res.startsWith('PAGE_ERR:')) console.error(`[${label}] ${res}`)
    return res
  } catch (err) {
    console.error(`[${label}] executeJavaScript rejected: ${err.message}`)
    return null
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { offscreen: true }
  })
  try {
    await win.loadURL(URL)
    await sleep(2500)

    // Hide the mock-data badge (a direct body child) and connect to staging.
    await js(
      win,
      'connect',
      `Array.from(document.body.children)
         .find((el) => el.textContent?.startsWith('UI PREVIEW'))?.remove();
       const items = Array.from(document.querySelectorAll('.cluster-item'));
       (items.find(i => i.textContent.includes('staging')) ?? items[0])?.click();`
    )
    await sleep(1500)
    await shot(win, 'overview')

    const tab = (label) =>
      js(
        win,
        'tab:' + label,
        `Array.from(document.querySelectorAll('.tab')).find(t => t.textContent === '${label}')?.click();`
      )

    await tab('Shards')
    await sleep(1200)
    await shot(win, 'shards')

    // Search: pick the first index via the combobox, run, open results.
    await tab('Search')
    await sleep(800)
    await js(
      win,
      'search-pick',
      `const combo = document.querySelector('.search-head input, .picker input, .combo input');
       if (combo) { combo.focus(); combo.click(); }
       await new Promise(r => setTimeout(r, 400));
       document.querySelector('.combo-opt, .picker-opt, [class*="opt"]')?.click();
       await new Promise(r => setTimeout(r, 300));
       Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Search')?.click();`
    )
    await sleep(1500)
    await shot(win, 'search')

    // Console: set method/path/body, close the path dropdown, run against the
    // mock `app` index so the response pane is populated.
    await tab('Console')
    await sleep(1000)
    await js(
      win,
      'console-path',
      `const verb = document.querySelector('.verb-select');
       if (verb) {
         const setSel = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
         setSel.call(verb, 'POST');
         verb.dispatchEvent(new Event('change', { bubbles: true }));
       }
       const path = document.querySelector('.path-input');
       if (path) {
         const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         set.call(path, '/app/_search');
         path.dispatchEvent(new Event('input', { bubbles: true }));
         path.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         path.blur();
       }
       /* the path dropdown closes on outside mousedown, not click */
       document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));`
    )
    await sleep(800)
    await js(
      win,
      'console-body',
      `const eds = globalThis.__editors ?? [];
       const host = document.querySelector('.req-body .code-editor');
       const ed = eds.filter(e => e.getDomNode() && host?.contains(e.getDomNode())).pop();
       if (ed) ed.setValue('{\\n  "query": {\\n    "bool": {\\n      "filter": [\\n        { "term": { "level": "error" } },\\n        { "range": { "@timestamp": { "gte": "now-1h" } } }\\n      ]\\n    }\\n  },\\n  "size": 20\\n}');`
    )
    await sleep(400)
    await js(
      win,
      'console-run',
      `document.querySelector('.req-bar .btn.primary')?.click();`
    )
    await sleep(1800)
    await shot(win, 'console')

    console.log(`Saved to ${outDir}`)
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
