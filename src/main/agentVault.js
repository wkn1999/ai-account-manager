'use strict'
// Trae 自定义智能体导出/导入
// 为什么：currentAgentData_<uid> 是「当前选中的智能体」单键单值，本机只缓存到客户端实际用过的那一份；
//        云端全量列表要登录态调接口，本模块不触网，只处理本机已缓存的 custom 智能体。
// 为什么：多个自定义智能体无法塞进同一个单值键，merge 模式下遇到不同 agentId 时不覆盖现有项，
//        而是追加到我们自己的存档键 aam.customAgents.<uid>，做到「只补不删」且零数据丢失。

const fs = require('fs')
const path = require('path')
const {
  CLIENTS,
  clientMeta,
  globalDbPath,
  workspaceDbPaths,
  appPaths,
  openVscdb,
  readKeys,
  writeKeys,
  safeParse,
  toText
} = require('./util/vscdb')
const { exists, readJson, writeJsonAtomic } = require('./util/core')

const FORMAT_AGENTS = 'ai-account-manager/agents'
const VERSION = 1
const AGENT_NOTE =
  '重要：本机归档只写本地缓存键，Trae 客户端的「自定义智能体」列表由云端按账号下发，不会因归档而出现；' +
  '如需在客户端内使用，请生成可粘贴清单后在 Trae 中逐个创建。' +
  '仅能导出本机已缓存的自定义智能体（type=custom）；内置 solo_agent 不导出，' +
  '云端全量列表需在 Trae 客户端内查看，本模块不触网、不保证拉到云端全量。'

let injectedStore = null

function setStore(store) {
  injectedStore = store || null
}

function currentUid(platform) {
  if (!injectedStore || typeof injectedStore.list !== 'function') return null
  try {
    const list = injectedStore.list(platform) || []
    const acc = list.find((a) => a.isCurrent) || list[0] || null
    return acc && acc.uid != null ? String(acc.uid) : null
  } catch {
    return null
  }
}

/** 无仓库注入时，从本机 currentAgentData_<uid> 键里挑一个 uid 作为当前登录 uid */
function detectUid(vscdb) {
  const uids = readKeys(vscdb, (key) => /^currentAgentData_\d+$/.test(key))
    .map((item) => ({ uid: item.key.slice('currentAgentData_'.length), value: item.value }))
  const custom = uids.find((u) => {
    const obj = safeParse(toText(u.value))
    return obj && obj.type === 'custom'
  })
  return custom ? custom.uid : uids.length ? uids[0].uid : null
}

/** 扫描 globalStorage + 所有 workspaceStorage，按 agentId 去重，globalStorage 优先 */
async function scanAgents() {
  const found = []
  const metas = Object.keys(CLIENTS)
    .map((k) => CLIENTS[k])
    .filter((m) => m.kind === 'trae')
  for (const meta of metas) {
    const sources = [
      { file: globalDbPath(meta), source: `${meta.platform}:globalStorage` },
      ...workspaceDbPaths(meta)
    ]
    for (const target of sources) {
      const opened = await openVscdb(target.file)
      if (!opened.ok) continue
      try {
        for (const item of readKeys(opened, (key) => /^currentAgentData_\d+$/.test(key))) {
          const raw = safeParse(toText(item.value))
          if (!raw || typeof raw !== 'object') continue
          if (raw.type !== 'custom') continue
          const agentId = String(raw.agent_id || '')
          if (!agentId) continue
          const text = toText(item.value)
          found.push({
            key: item.key,
            platform: meta.platform,
            source: target.source,
            uid: String(item.key.slice('currentAgentData_'.length)),
            agentId,
            uniqueName: raw.unique_name == null ? '' : String(raw.unique_name),
            name: raw.name == null ? '未命名智能体' : String(raw.name),
            type: String(raw.type),
            prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
            description: raw.description == null ? '' : String(raw.description),
            tools: Array.isArray(raw.built_in_tool_list) ? raw.built_in_tool_list : [],
            mcpList: Array.isArray(raw.mcp_list) ? raw.mcp_list : [],
            size: Buffer.byteLength(text, 'utf8'),
            raw
          })
        }
      } finally {
        if (opened.db) opened.db.close()
      }
    }
  }
  const byId = new Map()
  for (const entry of found) {
    const prev = byId.get(entry.agentId)
    if (!prev) {
      byId.set(entry.agentId, entry)
      continue
    }
    const prevGlobal = prev.source.endsWith(':globalStorage')
    const nowGlobal = entry.source.endsWith(':globalStorage')
    // globalStorage 是规范副本；同层级时取字节更完整的一份
    if ((nowGlobal && !prevGlobal) || (nowGlobal === prevGlobal && entry.size > prev.size)) {
      byId.set(entry.agentId, entry)
    }
  }
  return [...byId.values()]
}

async function listAgents() {
  const all = await scanAgents()
  const agents = all.map((a) => ({
    key: a.key,
    uid: a.uid,
    name: a.name,
    uniqueName: a.uniqueName,
    agentId: a.agentId,
    type: a.type,
    prompt: a.prompt,
    tools: a.tools,
    mcpList: a.mcpList,
    source: a.source,
    size: a.size,
    platform: a.platform
  }))
  return { ok: true, agents, note: AGENT_NOTE }
}

function rebuildAgent(entry, uid) {
  const raw =
    entry && entry.raw && typeof entry.raw === 'object'
      ? { ...entry.raw }
      : {
          agent_id: entry && entry.agentId,
          user_id: uid,
          name: (entry && entry.name) || '未命名智能体',
          unique_name: (entry && entry.uniqueName) || '',
          type: 'custom',
          prompt: (entry && entry.prompt) || '',
          description: (entry && entry.description) || '',
          built_in_tool_list: (entry && entry.tools) || [],
          mcp_list: (entry && entry.mcpList) || [],
          avatar_id: null,
          created_at: 0,
          updated_at: 0,
          members: [],
          can_be_sub_agent: false,
          is_enterprise: false
        }
  // user_id 决定云端归属，必须改成目标账号，否则客户端会按旧账号校验
  raw.user_id = uid
  return raw
}

function dedupeDefs(list) {
  const seen = new Set()
  const out = []
  for (const def of list) {
    if (!def || typeof def !== 'object') continue
    const id = String(def.agent_id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(def)
  }
  return out
}

/** scanAgents 的条目 → 导出条目（JSON 包、可粘贴清单、一键全部归档共用同一套字段） */
function toExportEntry(a) {
  return {
    key: a.key,
    platform: a.platform,
    source: a.source,
    uid: a.uid,
    agentId: a.agentId,
    uniqueName: a.uniqueName,
    name: a.name,
    type: a.type,
    prompt: a.prompt,
    description: a.description,
    builtInToolList: a.tools,
    mcpList: a.mcpList,
    raw: a.raw
  }
}

function listField(items, pick) {
  const list = Array.isArray(items) ? items : []
  const values = list
    .map((x) => (typeof x === 'string' ? x : pick(x)))
    .filter((x) => x != null && String(x) !== '')
    .map(String)
  return values.length ? values.map((v) => `- \`${v}\``).join('\n') : '- （无）'
}

/**
 * 人类可读清单：Trae 的自定义智能体列表在云端，本机归档不会让它出现，
 * 所以给一份能直接在客户端「创建」页逐段复制的配置（提示词全文 + 工具 + MCP）。
 */
function manifestText(agents) {
  const lines = [
    '# Trae 自定义智能体 · 可粘贴创建清单',
    '',
    `共 ${agents.length} 个 · 生成时间 ${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 为什么要手动创建',
    '',
    'Trae 客户端的「自定义智能体」列表由云端按账号下发，本机归档（一键全部归档）只写本地缓存键，',
    '不会让这些智能体出现在客户端。要让它们真正可用，请在 Trae 的「智能体」页点「创建」，',
    '按下面每一节填写名称、提示词、工具与 MCP；提示词在代码块里可整段复制。',
    ''
  ]
  agents.forEach((a, i) => {
    lines.push('---', '', `## ${i + 1}. ${a.name || '未命名智能体'}`, '')
    lines.push(`- 唯一名：\`${a.uniqueName || '无'}\``)
    lines.push(`- 智能体 ID：\`${a.agentId || '无'}\``)
    lines.push(`- 来源：${a.platform || '未知'} · ${a.source || '未知'} · uid ${a.uid || '未知'}`)
    if (a.description) lines.push(`- 描述：${a.description}`)
    lines.push('', '### 提示词（整段复制）', '', '```text')
    lines.push(String(a.prompt || '（无提示词）'))
    lines.push('```', '', '### 内置工具（在 Trae 中勾选）', '')
    lines.push(listField(a.builtInToolList, (t) => t && (t.value || t.name || t.id)))
    lines.push('', '### MCP 服务（在 Trae 中勾选同名服务）', '')
    lines.push(listField(a.mcpList, (m) => m && (m.name || m.id)))
    lines.push('')
  })
  lines.push('---', '', '> 由 AI账号管家生成：只含智能体定义，不含登录态、token 或密钥。', '')
  return lines.join('\n')
}

/** 文本文件也走「临时文件 + 重命名」，避免写到一半留下半截清单 */
function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

async function exportAgents(options = {}) {
  const opts = options || {}
  const all = await scanAgents()
  const wanted = Array.isArray(opts.agentIds) && opts.agentIds.length
    ? new Set(opts.agentIds.map(String))
    : null
  const selected = wanted
    ? all.filter((a) => wanted.has(a.agentId) || wanted.has(a.key) || wanted.has(a.uniqueName))
    : all
  const agents = selected.map(toExportEntry)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // manifest：给用户在 Trae 客户端里逐个创建用的人类可读清单，不写客户端数据库
  if (opts.manifest) {
    const file = opts.file ? String(opts.file) : path.join(appPaths().documents, `agents-manifest-${stamp}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeTextAtomic(file, manifestText(agents))
    return { ok: true, file, count: agents.length, manifest: true }
  }
  const file = opts.file ? String(opts.file) : path.join(appPaths().documents, `agents-${stamp}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeJsonAtomic(file, {
    format: FORMAT_AGENTS,
    version: VERSION,
    exportedAt: Date.now(),
    note: AGENT_NOTE,
    agents
  })
  return { ok: true, file, count: agents.length }
}

/**
 * targetUid 支持单个字符串，也支持按变体分别指定的对象 {'trae-cn':'uid', trae:'uid'}。
 * 为什么：listAgents 会同时扫国内版与国际版，一次导出可能跨两个变体，
 *        单个 uid 套到所有变体会把国内版 uid 写进国际版库，必须能分变体指定。
 */
function resolveTargetUid(platform, targetUid, opened) {
  const explicit = targetUid && typeof targetUid === 'object' ? targetUid[platform] : targetUid
  if (explicit) return String(explicit)
  const fromStore = currentUid(platform)
  if (fromStore) return fromStore
  const fromDb = detectUid(opened)
  if (fromDb) return fromDb
  return null
}

async function importAgents(options = {}) {
  const opts = options || {}
  // 一键全部归档：直接扫本机已缓存的定义，跳过「先导出 JSON 再选文件」两步
  const fromLocal = Boolean(opts.all) && !opts.file
  let agents
  if (fromLocal) {
    const scanned = await scanAgents()
    if (scanned.length === 0) throw new Error('本机没有已缓存的自定义智能体，无法一键全部归档')
    agents = scanned.map(toExportEntry)
  } else {
    if (!opts.file) throw new Error('请提供要导入的智能体文件')
    const data = readJson(String(opts.file))
    if (!data || typeof data !== 'object') throw new Error('智能体导出文件为空或格式错误')
    if (data.format !== FORMAT_AGENTS) throw new Error('不是有效的智能体导出文件（format 不匹配）')
    if (Number(data.version) !== VERSION) throw new Error(`智能体导出文件版本不支持：${data.version}`)
    agents = Array.isArray(data.agents) ? data.agents.filter((a) => a && typeof a === 'object') : []
  }
  const mode = String(opts.mode || 'merge')
  if (mode !== 'merge' && mode !== 'replace') throw new Error('mode 只能是 merge 或 replace')
  const dryRun = Boolean(opts.dryRun)
  if (agents.length === 0) throw new Error('没有可导入的自定义智能体')
  // 一键全部归档会同时覆盖 Trae 国内版与国际版，单个 uid 套到两个变体会串账号：
  // 一律走「按变体各自解析当前 uid」，忽略界面上选的单个 targetUid
  const effectiveTargetUid = fromLocal ? '' : opts.targetUid

  const groups = new Map()
  for (const agent of agents) {
    const platform = String(agent.platform || 'trae-cn')
    if (!groups.has(platform)) groups.set(platform, [])
    groups.get(platform).push(agent)
  }

  let imported = 0
  let skipped = 0
  let keysWritten = 0
  const messages = []

  for (const [platform, group] of groups) {
    const meta = clientMeta(platform)
    if (!meta || meta.kind !== 'trae') throw new Error(`导出文件里有不支持的平台：${platform}`)
    const file = globalDbPath(meta)
    if (!exists(file)) throw new Error(`${meta.label} 的 state.vscdb 不存在，无法导入`)
    const opened = await openVscdb(file)
    if (!opened.ok) throw new Error(`${meta.label} 的 state.vscdb 无法打开（可能已损坏）`)
    let uid = null
    try {
      uid = resolveTargetUid(platform, effectiveTargetUid, opened)
      if (!uid) {
        throw new Error(`未能确定 ${meta.label} 的目标账号 uid：请传入 targetUid，或先在客户端登录后再导入`)
      }
      const existingKey = `currentAgentData_${uid}`
      const archiveKey = `aam.customAgents.${uid}`
      const existing = safeParse(toText(opened.rows.get(existingKey)))
      const existingIsCustom = Boolean(existing && existing.type === 'custom' && existing.agent_id)
      const prevRaw = safeParse(toText(opened.rows.get(archiveKey)))
      const prevList = Array.isArray(prevRaw) ? prevRaw.filter((a) => a && typeof a === 'object') : []

      const beforeIds = new Set()
      if (existingIsCustom) beforeIds.add(String(existing.agent_id))
      for (const def of prevList) if (def.agent_id) beforeIds.add(String(def.agent_id))

      const incomingDefs = []
      for (const agent of group) {
        const def = rebuildAgent(agent, uid)
        const id = String(def.agent_id || '')
        if (!id) {
          skipped++
          continue
        }
        if (beforeIds.has(id)) {
          skipped++
          continue
        }
        beforeIds.add(id)
        incomingDefs.push(def)
        imported++
      }

      const primary = group.length ? rebuildAgent(group[0], uid) : null
      // merge 且已有不同 agentId 的自定义智能体时，单键单值无法并存：保留现有，导入项全部进存档键
      const conflict =
        mode === 'merge' && existingIsCustom && primary && String(existing.agent_id) !== String(primary.agent_id)
      const patch = []
      if (primary && !conflict) {
        patch.push({
          key: existingKey,
          value: Buffer.from(JSON.stringify(primary), 'utf8'),
          valueType: 'text'
        })
      }
      const defs = dedupeDefs([
        ...prevList,
        ...incomingDefs,
        ...(conflict && primary ? [primary] : [])
      ]).map((def) => ({ ...def, user_id: uid }))
      if (defs.length > 0) {
        patch.push({
          key: archiveKey,
          value: Buffer.from(JSON.stringify(defs), 'utf8'),
          valueType: 'text'
        })
      }
      const result = await writeKeys(file, patch, { client: meta, dryRun, backup: true })
      keysWritten += result.written
      skipped += result.skipped
      if (conflict) {
        messages.push(
          `${meta.label}：已有不同 agentId 的自定义智能体，merge 模式保留现有项，导入项已存入存档键 ${archiveKey}`
        )
      }
    } finally {
      if (opened.db) opened.db.close()
    }

    // workspaceStorage 里可能各有一份副本，客户端已关闭时同步过去，避免界面仍显示旧智能体
    if (!dryRun && uid) {
      let mirrored = 0
      for (const ws of workspaceDbPaths(meta)) {
        const wsOpened = await openVscdb(ws.file)
        if (!wsOpened.ok) continue
        try {
          const hasAgentKey = readKeys(wsOpened, (key) => /^currentAgentData_/.test(key)).length > 0
          if (!hasAgentKey) continue
          const primary = rebuildAgent(group[0], uid)
          const patch = [
            {
              key: `currentAgentData_${uid}`,
              value: Buffer.from(JSON.stringify(primary), 'utf8'),
              valueType: 'text'
            }
          ]
          if (mode !== 'merge' || !readKeys(wsOpened, (key) => key === `currentAgentData_${uid}`).length) {
            const r = await writeKeys(ws.file, patch, { client: meta, dryRun: false, backup: true })
            mirrored += r.written
          }
        } catch {
          // 单个 workspace 副本同步失败不阻断整体导入
        } finally {
          if (wsOpened.db) wsOpened.db.close()
        }
      }
      if (mirrored > 0) messages.push(`${meta.label}：已同步 ${mirrored} 个 workspace 副本`)
    }
  }

  const total = fromLocal ? agents.length : null
  const head = dryRun
    ? fromLocal
      ? `预演：本机共 ${total} 个自定义智能体，将新增 ${imported} 个、写入 ${keysWritten} 个键，未写盘`
      : `预演：将新增 ${imported} 个自定义智能体、写入 ${keysWritten} 个键，未写盘`
    : fromLocal
      ? `已把本机 ${total} 个自定义智能体全部归档（本次新增 ${imported} 个、写入 ${keysWritten} 个键，已备份原库）`
      : `已导入 ${imported} 个自定义智能体，写入 ${keysWritten} 个键（已备份原库）`
  return {
    ok: true,
    imported,
    skipped,
    dryRun,
    total,
    message: [head, ...messages, AGENT_NOTE].join(' ')
  }
}

module.exports = {
  FORMAT_AGENTS,
  VERSION,
  setStore,
  listAgents,
  exportAgents,
  importAgents
}
