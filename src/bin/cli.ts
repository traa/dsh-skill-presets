#!/usr/bin/env node
/**
 * `dsh-skill-presets` CLI: inspect the store, install/update the library,
 * activate a preset, and replay usage logs — without a running harness.
 *
 * Every command resolves the workbench the way the plugin does
 * ($DSH_WORKBENCH → $DSH_SETTINGS_REPO → $DSH_HOME/settings-repo).
 */
import { SkillPresetsService } from '../host/service.ts'
import { resolveWorkbenchFallback } from '../host/store.ts'
import { Telemetry, summarize, parseEvents } from '../host/telemetry.ts'
import { readFile } from 'node:fs/promises'

const [command, ...rest] = process.argv.slice(2)
const root = process.env.DSH_SKILL_PRESETS_ROOT ?? resolveWorkbenchFallback()
const service = new SkillPresetsService({ root: () => root, log: m => console.error(m) })

async function main(): Promise<number> {
  switch (command) {
    case 'status': {
      const status = await service.status()
      console.log(`store: ${status.root}/skills`)
      console.log(`active: ${status.activePreset?.id ?? 'none'}`)
      console.log(`presets: ${status.presets.map(p => p.id).join(', ')}`)
      console.log(`installed: ${status.lock.skills.length} (${status.foundationInstalled ? 'foundation present' : 'foundation not installed'})`)
      if (status.resolution.unresolved.length > 0) console.log(`unresolved: ${status.resolution.unresolved.map(u => `${u.ref} (${u.reason})`).join('; ')}`)
      return 0
    }
    case 'install':
    case 'update': {
      await service.ensure()
      const sources = (await service.sources()).filter(s => s.enabled && (rest.length === 0 || rest.includes(s.id)))
      for (const source of sources) {
        process.stdout.write(`${source.id}: `)
        try {
          const report = await service.library.sync(source, { onProgress: e => { if (e.step === 'error') console.error(`\n  ${e.dir}: ${e.message}`) } })
          console.log(`+${report.added.length} ~${report.updated.length} =${report.unchanged.length}${report.orphaned.length > 0 ? ` orphaned ${report.orphaned.length}` : ''}${report.failed.length > 0 ? ` failed ${report.failed.length}` : ''}`)
        } catch (error) {
          console.log(`failed: ${(error as Error).message}`)
        }
      }
      return 0
    }
    case 'check': {
      for (const report of await service.check(rest.length > 0 ? rest : undefined)) {
        console.log(`${report.source}: ${report.lockedCommit?.slice(0, 7) ?? '-'} → ${report.upstreamCommit.slice(0, 7)} · changed ${report.changed.length}, new ${report.newUpstream.length}, removed ${report.removedUpstream.length}`)
      }
      return 0
    }
    case 'activate': {
      const id = rest[0] === undefined || rest[0] === 'none' ? null : rest[0]
      const change = await service.activate(id, 'cli')
      console.log(`${change.from ?? 'none'} → ${change.to ?? 'none'}`)
      return 0
    }
    case 'summary': {
      const file = rest[0]
      if (file === undefined) { console.error('usage: summary <usage.jsonl>'); return 2 }
      const summary = summarize(file, parseEvents(await readFile(file, 'utf8')))
      console.log(JSON.stringify(summary, null, 2))
      return 0
    }
    case 'rollup': {
      const telemetry = new Telemetry(service.paths(), m => console.error(m))
      const rollup = await telemetry.rebuildRollup()
      console.log(JSON.stringify(rollup, null, 2))
      return 0
    }
    default:
      console.log([
        'usage: dsh-skill-presets <command>',
        '  status                 store, active preset, install state',
        '  install [source…]      install/update sources (all enabled by default)',
        '  update  [source…]      alias of install',
        '  check   [source…]      compare upstream with the lock, no download',
        '  activate <id|none>     set the active preset',
        '  summary <usage.jsonl>  fold one session log',
        '  rollup                 rebuild usage-rollup.json',
      ].join('\n'))
      return command === undefined ? 0 : 2
  }
}

main().then(code => { process.exitCode = code }, (error) => { console.error((error as Error).message); process.exitCode = 1 })
