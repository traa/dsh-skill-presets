// The browser stage: a fake shell that mounts the REAL built client bundle.
//
// `test/client.test.mjs` proves what the bundle REGISTERS with a fake React and
// no DOM. It cannot prove a popover is visible, that it escapes a clipped
// header, or that an outside click closes it — which is how the header chip
// shipped broken with every unit test green. This serves `lib/client.js`
// exactly as the page does (`window.__ModuleLoader__.load({ id, factory })`),
// real React 18 from node_modules, DOM regions named like the shell's slots,
// and a fixture-driven RPC stub, so Playwright can click and screenshot.
//
//   node stage/server.mjs [--port 4173] [--fixture green]
//
// The fixture may also be chosen per page with `?fixture=<name>`; the RPC stub
// reads it from the `x-stage-fixture` header the shell sets on every call, so
// two tabs can run two fixtures against one server.
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, 'stage')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1] }
const PORT = Number(flag('port', process.env.STAGE_PORT ?? '4173'))
const DEFAULT_FIXTURE = flag('fixture', 'green')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8' }

/** Every RPC the client half calls, answered from the fixture; `calls` is what the tests assert on. */
const calls = []

async function fixture(name) {
  const safe = /^[a-z0-9-]+$/u.test(name) ? name : DEFAULT_FIXTURE
  return JSON.parse(await readFile(join(STAGE, 'fixtures', `${safe}.json`), 'utf8'))
}

async function rpc(method, body, fixtureName) {
  const fx = await fixture(fixtureName)
  calls.push({ method, body, fixture: fixtureName, t: Date.now() })
  // Mutations echo the fixture back so the UI has something consistent to show;
  // the tests assert on `calls`, not on state transitions.
  if (method in fx.rpc) return fx.rpc[method]
  if (method.startsWith('presets/') || method.startsWith('suggestion/') || method.startsWith('practice/') || method.startsWith('session/') || method.startsWith('flows/')) return { ok: true }
  return { error: `stage: no fixture answer for ${method}` }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

async function serveFile(res, path) {
  try {
    const data = await readFile(path)
    send(res, 200, data, MIME[extname(path)] ?? 'application/octet-stream')
  } catch {
    send(res, 404, 'not found', 'text/plain')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const p = url.pathname
  if (p === '/' || p === '/index.html') return serveFile(res, join(STAGE, 'shell.html'))
  if (p === '/shell.js') return serveFile(res, join(STAGE, 'shell.js'))
  if (p === '/shell.css') return serveFile(res, join(STAGE, 'shell.css'))
  if (p === '/vendor/react.js') return serveFile(res, join(ROOT, 'node_modules/react/umd/react.development.js'))
  if (p === '/vendor/react-dom.js') return serveFile(res, join(ROOT, 'node_modules/react-dom/umd/react-dom.development.js'))
  if (p === '/plugins/dsh-skill-presets/client.js') return serveFile(res, join(ROOT, 'lib/client.js'))
  if (p === '/plugins/dsh-skill-presets/client.js.map') return serveFile(res, join(ROOT, 'lib/client.js.map'))
  if (p.startsWith('/plugins/dsh-skill-presets/rpc/')) {
    const method = p.slice('/plugins/dsh-skill-presets/rpc/'.length)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw.length > 0 ? JSON.parse(raw) : {}
    const fixtureName = String(req.headers['x-stage-fixture'] ?? DEFAULT_FIXTURE)
    try {
      const answer = await rpc(method, body, fixtureName)
      return send(res, 'error' in (answer ?? {}) ? 500 : 200, JSON.stringify(answer))
    } catch (error) {
      return send(res, 500, JSON.stringify({ error: error.message }))
    }
  }
  // Test-only introspection.
  if (p === '/__stage/calls') return send(res, 200, JSON.stringify(calls))
  if (p === '/__stage/reset') { calls.length = 0; return send(res, 200, '{"ok":true}') }
  if (p === '/__stage/fixtures') return send(res, 200, JSON.stringify((await readdir(join(STAGE, 'fixtures'))).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))))
  send(res, 404, 'not found', 'text/plain')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stage: http://127.0.0.1:${PORT}/?fixture=${DEFAULT_FIXTURE}`)
})
