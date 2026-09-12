/**
 * Browser-facing reads and actions.
 *
 * A plain HTTP route under the plugin's own prefix, mirroring dsh-workbench:
 * the Typert seam needs in-tree codegen a packaged out-of-tree client cannot
 * obtain. Handlers are registered as `skill-presets/<name>` for the flat
 * `harness.handle` transport and looked up by bare name for the HTTP route.
 * @module dsh-skill-presets/host/rpc
 */

import type { Context } from '@deepseek-ai/cordis'

interface HttpRequestLike extends AsyncIterable<Uint8Array> { url?: string | undefined }
interface HttpResponseLike { writeHead(status: number, headers: Record<string, string>): void, end(body?: string): void }

export type Handler = (args: Record<string, unknown>) => Promise<unknown>

export const RPC_PREFIX = '/plugins/dsh-skill-presets/rpc'

export class Rpc {
  private readonly handlers = new Map<string, Handler>()

  constructor(private readonly ctx: Context) {}

  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler)
  }

  /** Bind both transports. */
  install(): void {
    const webServer = this.ctx.get('webServer') as { register(route: unknown): () => void } | undefined
    if (webServer !== undefined) {
      this.ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: RPC_PREFIX,
        handler: async (req: HttpRequestLike, res: HttpResponseLike) => {
          const raw = decodeURIComponent((req.url ?? '').split('?')[0].split('/rpc/')[1] ?? '')
          const handler = this.handlers.get(raw) ?? this.handlers.get(`skill-presets/${raw}`)
          if (handler === undefined) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `unknown method ${raw}` }))
            return
          }
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(Buffer.from(chunk))
            const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '{}'
            const args = body.trim().length > 0 ? JSON.parse(body) as Record<string, unknown> : {}
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(await handler(args) ?? null))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'skill-presets rpc failed' }))
          }
        },
      }), 'skill-presets: http rpc')
    }
    const harnessRef = (globalThis as { harness?: { handle(method: string, handler: (args: unknown) => unknown): () => void } }).harness
    if (harnessRef !== undefined) {
      for (const [method, handler] of this.handlers) {
        const name = method.startsWith('skill-presets/') ? method : `skill-presets/${method}`
        this.ctx.effect(() => harnessRef.handle(name, args => handler((args ?? {}) as Record<string, unknown>)), `skill-presets: ${name}`)
      }
    }
  }
}

/** Read a required string argument. */
export function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} is required`)
  return value.trim()
}

/** Read an optional string argument. */
export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
