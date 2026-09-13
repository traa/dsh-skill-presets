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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderHookFile, parseHookStdin } from '../host/hooks.ts'
import { readGitFacts } from '../host/practices/git.ts'
import { DETECTORS, isMutatingCommand } from '../host/practices/detectors.ts'
import { PRACTICE_INFO } from '../host/curated.ts'
import type { PracticeId } from '../host/types.ts'
import { runEvals } from '../host/evals.ts'
import { applyImport, exportBundle, planImport, readLocalSkill, validateBundle } from '../host/bundle.ts'
import { diagnose, probe, worstSeverity } from '../host/doctor.ts'
import { lintLibrary } from '../host/lint.ts'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    case 'check-updates': {
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
    case 'worktrees': {
      const cwd = rest.find(a => !a.startsWith('--')) ?? process.cwd()
      const clean = rest.includes('--clean')
      const dryRun = rest.includes('--dry-run')
      if (clean || dryRun) {
        const r = await service.cleanupWorktrees(cwd, { dryRun: dryRun && !clean ? true : dryRun })
        for (const x of r.removed) console.log(`${r.dryRun ? 'would remove' : 'removed'}  ${x.path}${x.branch !== undefined ? ` [${x.branch}]` : ''} — ${x.reason}`)
        for (const x of r.attention) console.log(`attention  ${x.path} — ${x.reason}`)
        for (const x of r.kept) console.log(`kept       ${x.path} — ${x.reason}`)
        for (const x of r.errors) console.error(`error      ${x.path} — ${x.error}`)
        return r.errors.length > 0 ? 1 : 0
      }
      const scan = await service.worktrees(cwd)
      const { classify } = await import('../host/practices/worktrees.ts')
      console.log(`default branch: ${scan.defaultBranch}`)
      for (const w of scan.worktrees) {
        const v = classify(w, scan.defaultBranch)
        console.log(`${v.kind.padEnd(10)} ${w.path}${w.branch !== undefined ? ` [${w.branch}]` : ''}${w.dirty === true ? ' dirty' : ''}${w.nodeModulesSymlink !== undefined ? ' node_modules→symlink' : ''} — ${v.reason}`)
      }
      return 0
    }
    case 'hooks': {
      // hooks generate [dir]  → writes <dir>/skill-presets.claude-code.json and .codex.json
      const out = rest[1] ?? join(service.paths().root, 'hooks')
      if (rest[0] !== 'generate') { console.error('usage: hooks generate [dir]'); return 2 }
      await mkdir(out, { recursive: true })
      for (const dialect of ['claude-code', 'codex'] as const) {
        const file = join(out, `skill-presets.${dialect}.json`)
        await writeFile(file, renderHookFile(dialect), 'utf8')
        console.log(`wrote ${file}`)
      }
      console.log('Mount with: - name: @deepseek-ai/dsh-hooks-claude-code (or -codex), config.configPath: <file above>')
      return 0
    }
    case 'check': {
      // check <practice> [--cwd dir] [--json] [--hook <dialect>]
      // Exit 0 = fine/advisory, 2 = red AND hard (blocks in a hook bridge), 1 = usage.
      const id = rest[0] as PracticeId | undefined
      if (id === undefined || !(id in DETECTORS)) { console.error(`usage: check <${Object.keys(DETECTORS).join('|')}> [--cwd dir] [--json] [--hook <dialect>]`); return 1 }
      const hookMode = rest.includes('--hook')
      const stdin = hookMode ? parseHookStdin(await readStdin()) : {}
      const cwdFlag = rest.indexOf('--cwd')
      const cwd = cwdFlag !== -1 ? rest[cwdFlag + 1] : stdin.cwd ?? process.cwd()
      const doc = await service.practices()
      const cfg = doc.practices.find(p => p.id === id)
      const facts = await readGitFacts(cwd, { instructionFiles: doc.instructionFiles })
      // In hook mode the pending call is the one being gated; model it as a mutating call.
      const pending = hookMode && stdin.toolName !== undefined
        ? [{ t: new Date().toISOString(), turn: 1, name: stdin.toolName.toLowerCase(), target: stdin.filePath ?? stdin.command, isError: false }]
        : []
      const isMutating = pending.length > 0 && (['write', 'edit'].includes(pending[0].name) || isMutatingCommand(pending[0].target))
      const stage = await service.activeStage(stdin.sessionId !== undefined ? { id: stdin.sessionId } : undefined)
      const result = DETECTORS[id]({
        calls: isMutating ? pending : [],
        facts,
        teamAttached: false,
        userTurns: [1],
        protectedBranches: doc.protectedBranches,
        ended: id === 'pull-request',
        ...(stage !== undefined ? { activeStage: stage } : {}),
      })
      const block = result.status === 'red' && cfg?.mode === 'hard'
      if (rest.includes('--json')) console.log(JSON.stringify({ practice: id, ...result, mode: cfg?.mode ?? 'off', block }))
      else console.log(`${PRACTICE_INFO[id].title}: ${result.status}${result.evidence[0] !== undefined ? ` — ${result.evidence[0]}` : ''}${block ? ' (BLOCK)' : ''}`)
      if (block) {
        console.error(`practice "${PRACTICE_INFO[id].title}" is enforced: ${result.evidence[0] ?? result.status}. Load the \`${PRACTICE_INFO[id].skill}\` skill.`)
        return 2
      }
      return 0
    }
    case 'eval': {
      // eval [dir] [--update] [--only name]   default dir: <plugin>/evals/fixtures, then <workbench>/skills/evals
      const update = rest.includes('--update')
      const onlyIdx = rest.indexOf('--only')
      const only = onlyIdx !== -1 ? rest[onlyIdx + 1] : undefined
      const explicit = rest.find(a => !a.startsWith('--') && a !== only)
      const dirs = explicit !== undefined ? [explicit] : [join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'fixtures'), join(service.paths().skills, 'evals')]
      let failed = 0
      let total = 0
      for (const dir of dirs) {
        const results = await runEvals(dir, { update, ...(only !== undefined ? { only } : {}) })
        for (const r of results) {
          total += 1
          if (!r.pass) failed += 1
          console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.diffs.length > 0 ? `\n      ${r.diffs.join('\n      ')}` : ''}`)
        }
      }
      console.log(`${total - failed}/${total} fixtures pass`)
      return failed > 0 ? 1 : 0
    }
    case 'export': {
      // export <file> [preset…]
      const file = rest[0]
      if (file === undefined) { console.error('usage: export <file.json> [preset…]'); return 2 }
      await service.ensure()
      const [presets, overlays, sources, lock] = await Promise.all([service.presets(), service.overlays(), service.sources(), service.library.lock()])
      const ids = rest.slice(1).length > 0 ? rest.slice(1) : presets.map(p => p.id)
      const bundle = await exportBundle({ presetIds: ids, presets, overlays, sources, lock, readLocal: dir => readLocalSkill(service.paths().library, dir) })
      await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
      console.log(`wrote ${file}: ${bundle.presets.length} preset(s), ${bundle.lock.length} pinned skill(s), ${Object.keys(bundle.localSkills).length} local skill(s)`)
      return 0
    }
    case 'import': {
      // import <file> [--replace|--rename] [--dry-run]
      const file = rest[0]
      if (file === undefined) { console.error('usage: import <file.json> [--replace|--rename] [--dry-run]'); return 2 }
      await service.ensure()
      const bundle = validateBundle(JSON.parse(await readFile(file, 'utf8')))
      const [presets, sources, lock] = await Promise.all([service.presets(), service.sources(), service.library.lock()])
      const onCollision = rest.includes('--replace') ? 'replace' : rest.includes('--rename') ? 'rename' : 'skip'
      const plan = planImport(bundle, { presets, sources, lock, onCollision })
      for (const p of plan.presets) console.log(`preset ${p.action.padEnd(7)} ${p.id}${p.from !== p.id ? ` (from ${p.from})` : ''}`)
      for (const s of plan.newSources) console.log(`source  add     ${s.id} (disabled)`)
      for (const t of plan.toInstall) console.log(`install         ${t.source}/${t.dir}${t.pinnedCommit !== undefined ? ` @${t.pinnedCommit.slice(0, 7)}` : ''}`)
      for (const l of plan.localSkills) console.log(`local   ${l.action.padEnd(7)} ${l.dir}`)
      for (const x of plan.problems) console.error(`problem         ${x}`)
      if (plan.collisions.length > 0 && onCollision === 'skip') console.log(`collisions kept as ours: ${plan.collisions.join(', ')} (use --replace or --rename)`)
      if (rest.includes('--dry-run') || plan.problems.length > 0) return plan.problems.length > 0 ? 1 : 0
      const result = await applyImport(bundle, plan, {
        savePreset: p => service.savePreset(p), saveSources: s => service.saveSources(s), libraryRoot: service.paths().library,
        sync: (source, dirs) => service.library.sync(source, { dirs }), sources,
      })
      const local = (await service.sources()).find(s => s.id === 'local')
      if (local !== undefined) await service.library.sync(local)
      console.log(`written: ${result.written.join(', ') || '-'}; installed: ${result.installed.join(', ') || '-'}; skipped: ${result.skipped.join(', ') || '-'}`)
      return 0
    }
    case 'doctor': {
      // doctor [--profile name] [--json]
      const pi = rest.indexOf('--profile')
      const profile = pi !== -1 ? rest[pi + 1] : undefined
      const results = await probe({
        ...(profile !== undefined ? { profile } : {}),
        paths: service.paths(),
        runEvals: async () => {
          const shipped = await runEvals(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'fixtures'))
          return { total: shipped.length, failed: shipped.filter(r => !r.pass).length }
        },
      })
      const findings = diagnose(results)
      if (rest.includes('--json')) console.log(JSON.stringify({ findings, worst: worstSeverity(findings) }, null, 2))
      else {
        for (const f of findings) console.log(`${f.severity === 'ok' ? '  ok ' : f.severity === 'warn' ? 'WARN ' : 'FAIL '} ${f.id.padEnd(14)} ${f.message}${f.fix !== undefined && f.severity !== 'ok' ? `\n                    → ${f.fix}` : ''}`)
        console.log(worstSeverity(findings) === 'ok' ? 'all clear' : worstSeverity(findings) === 'warn' ? 'degraded (warnings only)' : 'NOT HEALTHY')
      }
      return worstSeverity(findings) === 'fail' ? 1 : 0
    }
    case 'lint': {
      // lint [ref] [--json]
      await service.ensure()
      const lint = await lintLibrary(await service.library.lock(), service.paths())
      const only = rest.find(a => !a.startsWith('--'))
      const entries = Object.entries(lint.byRef).filter(([ref]) => only === undefined || ref === only || ref.endsWith(`/${only}`))
      if (rest.includes('--json')) { console.log(JSON.stringify({ ...lint, byRef: Object.fromEntries(entries) }, null, 2)); return lint.counts.error > 0 ? 1 : 0 }
      for (const [ref, findings] of entries) {
        console.log(ref)
        for (const f of findings) console.log(`  ${f.severity.padEnd(5)} ${f.rule.padEnd(16)} ${f.message}`)
      }
      console.log(`${lint.counts.error} error(s), ${lint.counts.warn} warning(s), ${lint.counts.info} note(s)`)
      return lint.counts.error > 0 ? 1 : 0
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
        '  check-updates [source…] compare upstream with the lock, no download',
        '  activate <id|none>     set the active preset',
        '  summary <usage.jsonl>  fold one session log',
        '  rollup                 rebuild usage-rollup.json',
        '  worktrees [cwd] [--dry-run|--clean]   list worktrees; remove merged+clean ones (and their branch)',
        '  export <file> [preset…]              write a shareable bundle (presets, overlays, pinned lock, local skill bodies)',
        '  import <file> [--replace|--rename] [--dry-run]   plan and apply a bundle; collisions kept as ours by default',
        '  lint [ref] [--json]    provider-neutrality + routing quality of installed skills; exit 1 on errors',
        '  doctor [--profile name] [--json]   is the running plugin the source? seams present? store sane?',
        '  eval [dir] [--update] [--only name]   replay recorded sessions through the detectors',
        '  hooks generate [dir]   write hook files for dsh-hooks-claude-code and dsh-hooks-codex',
        '  check <practice> [--cwd d] [--json] [--hook <dialect>]   replay one detector; exit 2 when red AND hard',
      ].join('\n'))
      return command === undefined ? 0 : 2
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

main().then(code => { process.exitCode = code }, (error) => { console.error((error as Error).message); process.exitCode = 1 })
