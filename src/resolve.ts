/**
 * v2 项目标识解析：project 不再由模型编标签，而是由工作区派生确定性 id。
 *
 * 规则（用户拍板 2026-09-16）：
 *   有 git（沿 cwd 向上找到最近 .git，读取 [remote "origin"] url）
 *     → project id = 归一化 git 地址（剥协议/凭证/端口/尾部 .git，host 小写）
 *   有 git 但无 remote（本地仓库）
 *     → project id = 仓库根规范化路径（同一仓库任意子目录会话 id 一致）
 *   无 git
 *     → project id = cwd 规范化绝对路径（先不考虑迁移：路径变 id 变）
 *
 * git 探测 = 简单优先：只沿 cwd 向上找 .git（与 git rev-parse --show-toplevel 语义一致），
 * 不向下探测子目录（多子仓库无法唯一化，父目录会话走路径 id，确定性可审计）。
 * 纯 fs 实现（零外部命令），沙箱/离线可用；进程级缓存。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

export interface ResolvedProject {
  /** project id（写入记忆 project 字段的值）。 */
  id: string
  /** 标识来源：git 地址 / 规范化路径。 */
  kind: 'git' | 'path'
  /** 找到的 git 仓库根（有 git 时非空）。 */
  repoRoot: string | null
}

/** 自动解析总开关（测试可关）。 */
let enabled = true

export function setProjectResolveEnabled(v: boolean): void {
  enabled = v
}

export function isProjectResolveEnabled(): boolean {
  return enabled
}

const cache = new Map<string, ResolvedProject | null>()

/** 清缓存（测试/配置变更用）。 */
export function clearProjectResolveCache(): void {
  cache.clear()
}

/** git config 里 [remote "origin"] 段的 url（简易 INI 解析，够用即可）。 */
export function readOriginUrl(configText: string): string | null {
  let inOrigin = false
  for (const raw of configText.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = line.match(/^\[([^\]]+)\]\s*$/)
    if (sec) {
      const name = sec[1].trim()
      inOrigin = name === 'remote "origin"' || name === 'remote origin' || name === 'remote.origin'
      continue
    }
    if (!inOrigin) continue
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
    if (kv && kv[1] === 'url') {
      let v = kv[2]
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
      return v || null
    }
  }
  return null
}

/** git 地址 → 稳定可读标识：剥协议/凭证/端口/尾部 .git，host 统一小写。 */
export function normalizeGitUrl(url: string): string | null {
  const s = url.trim()
  if (!s) return null
  let host: string
  let path: string
  // URL 形式：ssh:// / https:// / http://（剥协议、user:pass@ 凭证、:port 端口）
  const proto = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i)
  if (proto) {
    host = proto[1].toLowerCase()
    path = proto[2]
  } else {
    // ssh 简写：git@host:path 或 host:path
    const scp = s.match(/^(?:[^@\s]+@)?([^:\s]+):(.*)$/)
    if (scp && s.includes(':')) {
      host = scp[1].toLowerCase()
      path = scp[2]
    } else {
      // 已是 host/path
      const slash = s.indexOf('/')
      if (slash <= 0) return null
      host = s.slice(0, slash).toLowerCase()
      path = s.slice(slash + 1)
    }
  }
  path = path.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  if (!path) return null
  return host + '/' + path
}

/** 给定 .git 路径，返回其 config 文件路径；.git 是 gitfile（worktree/submodule）时解析 gitdir。 */
function gitConfigPath(gitPath: string): string | null {
  const config = gitPath + sep + 'config'
  if (existsSync(config)) return config
  if (!existsSync(gitPath)) return null
  try {
    const content = readFileSync(gitPath, 'utf8')
    const m = content.match(/^gitdir:\s*(.+)$/m)
    if (m) {
      const abs = resolve(dirname(gitPath), m[1].trim())
      const c1 = abs + sep + 'config'
      if (existsSync(c1)) return c1
      // worktree：gitdir = <主仓库>/.git/worktrees/<name>，config 在主 .git/config
      const wt = abs.match(/^(.*)[/\\]worktrees[/\\][^/\\]+$/)
      if (wt) {
        const c2 = wt[1] + sep + 'config'
        if (existsSync(c2)) return c2
      }
    }
  } catch {
    /* 读取失败按无 config 处理 */
  }
  return null
}

/** 沿 cwd 向上找最近的 .git；返回 { repoRoot, originUrl }。 */
export function probeGit(ws: string): { repoRoot: string; originUrl: string | null } | null {
  let cur = resolve(ws)
  if (!cur) return null
  for (;;) {
    const gitPath = cur + sep + '.git'
    if (existsSync(gitPath)) {
      const cfg = gitConfigPath(gitPath)
      let originUrl: string | null = null
      if (cfg) {
        try {
          originUrl = readOriginUrl(readFileSync(cfg, 'utf8'))
        } catch {
          originUrl = null
        }
      }
      return { repoRoot: cur, originUrl }
    }
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 工作区 → project id。带进程级缓存；异常 → null（调用方归未标记，记忆不丢）。 */
export function resolveProjectId(ws: string): ResolvedProject | null {
  if (!enabled) return null
  const key = ws || ''
  if (cache.has(key)) return cache.get(key) ?? null
  let out: ResolvedProject | null
  try {
    if (!ws) {
      out = null
    } else {
      const probed = probeGit(ws)
      if (probed && probed.originUrl) {
        const id = normalizeGitUrl(probed.originUrl)
        out = id ? { id, kind: 'git', repoRoot: probed.repoRoot } : { id: probed.repoRoot, kind: 'path', repoRoot: probed.repoRoot }
      } else if (probed) {
        // 有 git 无 remote：仓库根路径（同一仓库任意子目录会话 id 一致）
        out = { id: probed.repoRoot, kind: 'path', repoRoot: probed.repoRoot }
      } else {
        out = { id: resolve(ws), kind: 'path', repoRoot: null }
      }
    }
  } catch {
    out = null
  }
  cache.set(key, out)
  return out
}

/**
 * 工作区是否是 git 项目（沿 cwd 向上能找到 .git，含无 remote 的本地仓库）。
 * 与 v2 id 派生解耦：不依赖 enabled 开关、不走缓存——供会话记忆开关的
 * 「git 恒启用 / 非 git 走设置」判定用（每次直探，fs 代价可忽略）。
 */
export function isGitWorkspace(ws: string): boolean {
  if (!ws) return false
  try {
    return probeGit(ws) !== null
  } catch {
    return false
  }
}
