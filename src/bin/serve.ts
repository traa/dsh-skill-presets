#!/usr/bin/env node
/**
 * Supervisor for the web profile: runs `pnpm dsh web` from the harness
 * checkout, and when the child exits with RESTART_EXIT_CODE (the plugin asked
 * to restart after a self-update) or crashes, starts it again. A clean exit
 * (Ctrl-C, exit 0) stops the supervisor too.
 *
 * Also polls every `--interval` seconds for merged work on the managed
 * plugins and, when the running server is idle (no session mid-turn — read
 * from the restart flag the plugin writes), performs the sync itself and
 * restarts. So "merge the PR" is the last thing a human does.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { RESTART_EXIT_CODE, readRestartFlag, restartFlagPath, writeRestartFlag } from '../host/sync.ts'
import { resolveDshHome } from '../host/store.ts'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback }
const harness = flag('harness', process.env.DSH_HARNESS ?? '/Users/andriistepikov/Documents/bonfire/dsh/deepseek-harness')
const intervalSec = Number(flag('interval', '60'))
const dshHome = resolveDshHome()
const profile = flag('profile', 'web')

let child: ReturnType<typeof spawn> | undefined
let stopping = false
let restarts = 0
/** Set when WE asked the server to stop for a restart; the exit handler then always restarts. */
let restartRequested = false

const log = (m: string): void => { console.log(`[serve ${new Date().toISOString()}] ${m}`) }

function start(): void {
  log(`starting: pnpm dsh ${profile} (cwd ${harness})`)
  child = spawn('pnpm', ['dsh', profile], { cwd: harness, stdio: 'inherit', env: { ...process.env, DSH_SUPERVISED: '1' } })
  child.on('exit', (code, signal) => {
    if (stopping) { log(`server exited (${code ?? signal}); supervisor stopping`); process.exit(code ?? 0) }
    if (restartRequested || code === RESTART_EXIT_CODE) {
      restartRequested = false
      restarts += 1
      log(`restarting server (#${restarts})`)
      void writeRestartFlag(dshHome, { pending: false })
      start()
      return
    }
    if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') { log('server exited on its own; supervisor stopping'); process.exit(0) }
    log(`server crashed (${code ?? signal}); restarting in 3 s`)
    setTimeout(start, 3000)
  })
}

// Poll: the plugin does the fetch/pull/build and writes the flag with pending: true
// once the new build is on disk; we restart when it also says idle (it clears
// `busy` between turns). A stale flag older than 10 min is restarted anyway.
async function poll(): Promise<void> {
  const state = await readRestartFlag(dshHome) as { pending: boolean, since?: string, busy?: boolean }
  if (!state.pending || child === undefined) return
  const age = state.since !== undefined ? Date.now() - Date.parse(state.since) : 0
  if (state.busy === true && age < 10 * 60_000) { log('restart pending but a session is mid-turn; waiting'); return }
  log(`restart pending (${Math.round(age / 1000)} s); stopping the server to relaunch it`)
  restartRequested = true
  child.kill('SIGTERM')
}

process.on('SIGINT', () => { stopping = true; child?.kill('SIGINT') })
process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM') })

await writeFile(restartFlagPath(dshHome), JSON.stringify({ pending: false }), 'utf8').catch(() => {})
start()
setInterval(() => { void poll() }, Math.max(2, intervalSec) * 1000).unref()
log(`watching ${restartFlagPath(dshHome)} every ${intervalSec} s`)
