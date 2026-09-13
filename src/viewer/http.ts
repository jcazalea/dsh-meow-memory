/**
 * meow-memory 记忆查看器 — HTTP 小工具（JSON 响应、ETag/304、请求体解析）。
 *
 * 走 dsh 的 webServer 原始 node:http 路由（与既有 /meow-memory/* 路由同机制），
 * 因此这里自己管响应生命周期；任何写响应失败都吞掉（客户端可能已断开）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiErr, ApiErrorCode, ApiMeta, ApiOk } from './types.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const

export function metaOf(etag: string, partial: readonly string[] = []): ApiMeta {
  return { generatedAt: Date.now(), etag, partial: [...partial] }
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  try {
    res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders })
    res.end(JSON.stringify(body))
  } catch {
    /* 客户端断开/已响应：忽略 */
  }
}

export function writeOk<T>(res: ServerResponse, data: T, meta: ApiMeta, req?: IncomingMessage): void {
  // 条件请求：ETag 命中直接 304（前端 60s 轮询几乎零成本）。
  const inm = req?.headers?.['if-none-match']
  const etagValue = `"${meta.etag}"`
  if (typeof inm === 'string' && inm.split(',').map((s) => s.trim()).includes(etagValue)) {
    try {
      res.writeHead(304, { etag: etagValue, 'cache-control': 'no-store' })
      res.end()
    } catch {
      /* 忽略 */
    }
    return
  }
  const body: ApiOk<T> = { ok: true, data, meta }
  send(res, 200, body, { etag: etagValue })
}

export function writeError(res: ServerResponse, status: number, code: ApiErrorCode, message: string, meta: ApiMeta): void {
  const body: ApiErr = { ok: false, error: { code, message }, meta }
  send(res, status, body)
}

/** 读请求体（默认 64KB 上限；空体 = {}）。 */
export function readJsonBody(req: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
  })
}

/** 把若干片段揉成一个短 etag（FNV-1a base36，够用且零依赖）。 */
export function etagOf(parts: readonly (string | number | null | undefined)[]): string {
  const text = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\u0001')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `v${h.toString(36)}-${parts.length}`
}
