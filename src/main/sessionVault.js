'use strict'
// 会话仓库：Qoder 本地会话表 / Trae 会话索引 的只读列举、导出、导入与切号归档
// 为什么：Qoder 的 chat_sessions 没有 account_id，本地会话库不按账号分区，切号不会删会话但会混号；
//        Trae 会话正文在云端按 user_id 隔离，整体覆盖 state.vscdb 会丢会话，跨账号真迁移会被
//        服务端归属校验拒绝并产生幽灵会话。所以这里一律「只读列举 + 行级/键级合并 + 本地归档」。

const fs = require('fs')
const path = require('path')
const {
  appPaths,
  clientMeta,
  resolveClients,
  globalDbPath,
  qoderDbPath,
  openVscdb,
  openSqlite,
  readKeys,
  writeKeys,
  queryRows,
  atomicWrite,
  assertClientClosed,
  isSensitiveKey,
  safeParse,
  toText,
  escapeRe,
  quoteIdent
} = require('./util/vscdb')
const { exists, readJson, writeJsonAtomic, isProcessRunning } = require('./util/core')

const FORMAT_SESSIONS = 'ai-account-manager/sessions'
const VERSION = 1
const DEFAULT_SETTINGS = { protectOnSwitch: true, autoArchive: true, archiveKeep: 5 }

let injectedStore = null

/** index.js 在 initStore() 里注入仓库，纯 Node 自检时不注入也能跑只读路径 */
function setStore(store) {
  injectedStore = store || null
}

function getSettings() {
  let vault = {}
  if (injectedStore && typeof injectedStore.getSettings === 'function') {
    try {
      vault = injectedStore.getSettings().vault || {}
    } catch {
      vault = {}
    }
  }
  return { ...DEFAULT_SETTINGS, ...vault }
}

function setSettings(patch) {
  const input = patch && typeof patch === 'object' ? patch : {}
  const current = getSettings()
  const next = { ...current }
  if (typeof input.protectOnSwitch === 'boolean') next.protectOnSwitch = input.protectOnSwitch
  if (typeof input.autoArchive === 'boolean') next.autoArchive = input.autoArchive
  if (input.archiveKeep !== undefined) {
    const n = Number(input.archiveKeep)
    // 归档份数必须有限且为正，避免误传把历史全删光
    if (Number.isFinite(n)) next.archiveKeep = Math.min(50, Math.max(1, Math.floor(n)))
  }
  if (injectedStore && typeof injectedStore.setSettings === 'function') {
    const saved = injectedStore.setSettings({ vault: next }) || {}
    return { ...DEFAULT_SETTINGS, ...(saved.vault || next) }
  }
  return next
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

function currentAccount(platform, accountId) {
  if (!injectedStore) return null
  try {
    if (accountId && typeof injectedStore.get === 'function') return injectedStore.get(accountId) || null
    const list = typeof injectedStore.list === 'function' ? injectedStore.list(platform) || [] : []
    return list.find((a) => a.isCurrent) || list[0] || null
  } catch {
    return null
  }
}

/** 会话 preview 只取用户自己数据的前 80 字，解析失败一律给空，绝不抛 */
function extractPreview(raw) {
  const text = toText(raw)
  if (!text) return ''
  let found = ''
  try {
    const obj = JSON.parse(text)
    const parts = Array.isArray(obj && obj.parts) ? obj.parts : []
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.trim()) {
        found = part.text.trim()
        break
      }
    }
    if (!found && obj && typeof obj.text === 'string') found = obj.text.trim()
    if (!found && obj && typeof obj.content === 'string') found = obj.content.trim()
  } catch {
    // payload 可能被 substr 截断或非标准 JSON，只从可见文本片段里取，不给完整会话正文
    const m = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.){1,240})"/)
    if (m) {
      try {
        found = JSON.parse(`"${m[1]}"`)
      } catch {
        found = m[1]
      }
    }
  }
  return String(found).replace(/\s+/g, ' ').slice(0, 80)
}

/** Qoder：只读列举 chat_sessions，关联统计消息条数并抽取首条可见文本 */
async function listQoderSessions(meta) {
  const file = qoderDbPath(meta)
  const opened = await openSqlite(file)
  if (!opened.ok) return { exists: false, sessions: [], total: 0, messageCount: 0 }
  try {
    const hasTable = queryRows(opened.db, "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_sessions'")
    if (!hasTable.length) return { exists: false, sessions: [], total: 0, messageCount: 0 }
    const rows = queryRows(
      opened.db,
      'SELECT session_id, title, created_at, updated_at, archived, deleted_at FROM chat_sessions'
    )
    const counts = queryRows(opened.db, 'SELECT session_id, COUNT(*) AS n FROM chat_session_messages GROUP BY session_id')
    const countMap = new Map(counts.map((r) => [String(r.session_id), Number(r.n) || 0]))
    // 只读前 8000 字符就足够找到首个可见文本，避免把整段会话正文读进内存
    const heads = queryRows(
      opened.db,
      "SELECT session_id, substr(payload_json, 1, 8000) AS head FROM chat_session_messages WHERE role = 'user' ORDER BY session_id, sequence"
    )
    const previewMap = new Map()
    for (const row of heads) {
      const sid = String(row.session_id)
      if (previewMap.has(sid)) continue
      const preview = extractPreview(row.head)
      if (preview) previewMap.set(sid, preview)
    }
    const uid = currentUid(meta.platform)
    let messageCount = 0
    const sessions = []
    for (const row of rows) {
      if (row.deleted_at !== null && row.deleted_at !== undefined && row.deleted_at !== '') continue
      const id = String(row.session_id)
      const n = countMap.get(id) || 0
      messageCount += n
      sessions.push({
        id,
        platform: meta.platform,
        uid,
        title: row.title == null || row.title === '' ? '未命名会话' : String(row.title),
        updatedAt: Number(row.updated_at) || Number(row.created_at) || null,
        messageCount: n,
        preview: previewMap.get(id) || '',
        kind: 'qoder-local'
      })
    }
    return { exists: true, sessions, total: rows.length, messageCount }
  } finally {
    opened.db.close()
  }
}

/** Trae 会话索引键：带会话 id 的本地缓存键，不含登录态与全局键 */
function traeSessionKey(key) {
  return (
    /^all_session_badges_/i.test(key) ||
    /^chat-suggest:cache:/i.test(key) ||
    /draft:session:/i.test(key) ||
    /revert:attachment-meta:v1:session:/i.test(key) ||
    key === 'chat.ChatSessionStore.index' ||
    /^solo-lite:content-map:/i.test(key)
  )
}

/** Trae：归纳本地会话索引，正文在云端，本地拿不到消息条数与正文 */
async function listTraeSessions(meta) {
  const opened = await openVscdb(globalDbPath(meta))
  if (!opened.ok) return { exists: false, sessions: [], total: 0 }
  try {
    const entries = new Map()
    const add = (sid, uid, source, extra = {}) => {
      if (!sid || typeof sid !== 'string' || sid.length < 8) return
      let entry = entries.get(sid)
      if (!entry) {
        entry = { id: sid, uid: uid || null, sources: new Set(), updatedAt: null, title: '', preview: '' }
        entries.set(sid, entry)
      }
      if (uid && !entry.uid) entry.uid = uid
      entry.sources.add(source)
      if (extra.updatedAt && (!entry.updatedAt || extra.updatedAt > entry.updatedAt)) entry.updatedAt = extra.updatedAt
      if (extra.title && !entry.title) entry.title = extra.title
      if (extra.preview && !entry.preview) entry.preview = String(extra.preview).slice(0, 80)
    }
    for (const item of readKeys(opened, () => true)) {
      const key = item.key
      const text = toText(item.value)
      const contentMap = /^solo-lite:content-map:(\d+)$/.exec(key)
      if (contentMap) {
        const obj = safeParse(text)
        if (obj && typeof obj === 'object') {
          for (const sid of Object.keys(obj)) add(sid, contentMap[1], key)
        }
        continue
      }
      if (key === 'chat.ChatSessionStore.index') {
        const obj = safeParse(text)
        const idx = obj && obj.entries && typeof obj.entries === 'object' ? obj.entries : {}
        for (const [sid, val] of Object.entries(idx)) {
          const extra = {}
          if (val && typeof val === 'object') {
            if (val.title || val.name) extra.title = String(val.title || val.name)
            if (val.updatedAt || val.lastModified) extra.updatedAt = Number(val.updatedAt || val.lastModified) || null
          }
          add(sid, null, key, extra)
        }
        continue
      }
      const badge = /^all_session_badges_([a-z0-9]+)$/i.exec(key)
      if (badge) {
        add(badge[1], null, key)
        continue
      }
      const suggest = /^chat-suggest:cache:([a-z0-9]+)$/i.exec(key)
      if (suggest) {
        const obj = safeParse(text)
        add(suggest[1], null, key, { updatedAt: Number(obj && obj.savedAt) || null })
        continue
      }
      const draft = /draft:session:([a-z0-9]+):/i.exec(key)
      if (draft) {
        add(draft[1], null, key)
        continue
      }
      const revert = /revert:attachment-meta:v1:session:([a-z0-9]+)$/i.exec(key)
      if (revert) {
        add(revert[1], null, key)
        continue
      }
      if (key === 'solo-lite.local-project-folders') {
        const obj = safeParse(text)
        if (obj && typeof obj === 'object') {
          for (const [sid, folder] of Object.entries(obj)) {
            const label = typeof folder === 'string' ? path.basename(folder.replace(/[\\/]+$/, '')) : ''
            add(sid, null, key, label ? { title: label } : {})
          }
        }
      }
    }
    const fallbackUid = currentUid(meta.platform)
    const sessions = [...entries.values()].map((entry) => ({
      id: entry.id,
      platform: meta.platform,
      uid: entry.uid || fallbackUid,
      title: entry.title || `会话 ${entry.id.slice(0, 8)}`,
      updatedAt: entry.updatedAt || null,
      // 正文在云端，本地只有索引；用 null 表示「本机不可知」，不伪装成 0 条
      messageCount: null,
      preview: '',
      kind: 'trae-index'
    }))
    return { exists: true, sessions, total: sessions.length }
  } finally {
    if (opened.db) opened.db.close()
  }
}

const TRAE_NOTE =
  'Trae 会话正文在云端按 user_id 隔离，本地仅索引与缓存；导出的是可恢复的本地索引与缓存。' +
  '跨账号真迁移会话会被服务端归属校验拒绝并产生幽灵会话，不可行；请勿整体覆盖 state.vscdb。'
const QODER_NOTE =
  'Qoder 会话保存在本机 main.sqlite；chat_sessions 没有 account_id，本地会话库不按账号分区。' +
  '导出的是会话表及全部关联表的完整行，导入按主键合并，绝不整库覆盖。'

async function listSessions(platform) {
  const metas = resolveClients(platform)
  if (metas.length === 0) {
    // 抽屉会遍历所有平台做只读探测，不支持会话管理的平台必须给空结果而不是报错，
    // 否则渲染层会把「没有会话能力」误显示成一次失败
    return {
      ok: true,
      sessions: [],
      note: `平台 ${String(platform)} 暂不支持会话管理（仅 Qoder / Trae 变体支持），已跳过；本次为只读探测，未写盘`
    }
  }
  const sessions = []
  const notes = []
  for (const meta of metas) {
    const result = meta.kind === 'qoder' ? await listQoderSessions(meta) : await listTraeSessions(meta)
    sessions.push(...result.sessions)
    if (!result.exists) {
      notes.push(`${meta.label}：未检测到会话库（已跳过）`)
    } else if (meta.kind === 'qoder') {
      notes.push(`${meta.label}：本地会话库，共 ${result.total} 条会话 / ${result.messageCount} 条消息`)
    } else {
      notes.push(`${meta.label}：本地会话索引 ${result.total} 条；${TRAE_NOTE}`)
    }
  }
  const qoder = sessions.some((s) => s.kind === 'qoder-local')
  const trae = sessions.some((s) => s.kind === 'trae-index')
  const note = [
    ...notes,
    qoder ? QODER_NOTE : null,
    trae ? 'Trae 只读列举，绝不写盘。' : null,
    '只读用 sql.js 打开主库，客户端运行时未 checkpoint 的 -wal/-shm 内容不在读取范围内。'
  ]
    .filter(Boolean)
    .join(' ')
  return { ok: true, sessions, note }
}

function filterSessions(sessions, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return sessions
  const wanted = new Set(sessionIds.map(String))
  return sessions.filter((s) => wanted.has(String(s.id)))
}

/** Qoder：动态发现所有带 session_id 的关联表（排除 FTS 虚表），按选中会话导出完整行 */
async function collectQoderTables(meta, sessionIds) {
  const opened = await openSqlite(qoderDbPath(meta))
  if (!opened.ok || sessionIds.length === 0) {
    if (opened.ok) opened.db.close()
    return []
  }
  try {
    const tables = queryRows(
      opened.db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_session%'"
    )
    const placeholders = sessionIds.map(() => '?').join(',')
    const out = []
    for (const item of tables) {
      const table = String(item.name)
      if (/_fts/i.test(table)) continue
      const info = queryRows(opened.db, `PRAGMA table_info(${quoteIdent(table)})`)
      const columns = info.map((r) => String(r.name))
      if (!columns.includes('session_id')) continue
      const select = columns.map(quoteIdent).join(', ')
      const rows = queryRows(
        opened.db,
        `SELECT ${select} FROM ${quoteIdent(table)} WHERE session_id IN (${placeholders})`,
        sessionIds
      )
      out.push({
        table,
        columns,
        rows: rows.map((r) => columns.map((c) => encodeCell(r[c])))
      })
    }
    return out
  } finally {
    opened.db.close()
  }
}

/** BLOB 单元格用标记对象保真，导入时还原成 Uint8Array */
function encodeCell(value) {
  if (value == null) return null
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (Buffer.isBuffer(value)) return { __b64: value.toString('base64') }
  if (value instanceof Uint8Array) return { __b64: Buffer.from(value).toString('base64') }
  return String(value)
}

function decodeCell(value) {
  if (value && typeof value === 'object' && typeof value.__b64 === 'string') {
    return new Uint8Array(Buffer.from(value.__b64, 'base64'))
  }
  return value
}

/** Trae：导出该 uid 的全部账号分区键 + 会话索引/缓存键，排除登录态与全局键 */
async function collectTraeKeys(meta, uid, sessionIds) {
  const opened = await openVscdb(globalDbPath(meta))
  if (!opened.ok) {
    return []
  }
  try {
    const uidRe = uid ? new RegExp(`(^|[^0-9])${escapeRe(uid)}([^0-9]|$)`) : null
    const selected = new Set(sessionIds.map(String))
    const allSessions = selected.size === 0
    const out = []
    for (const item of readKeys(opened, () => true)) {
      if (isSensitiveKey(item.key)) continue
      const byUid = uidRe ? uidRe.test(item.key) : false
      let bySession = allSessions ? traeSessionKey(item.key) : false
      if (!bySession && !allSessions) {
        for (const sid of selected) {
          if (item.key.includes(sid)) {
            bySession = true
            break
          }
        }
      }
      if (!byUid && !bySession) continue
      const raw = item.value == null ? Buffer.alloc(0) : Buffer.isBuffer(item.value) ? item.value : Buffer.from(toText(item.value), 'utf8')
      out.push({ key: item.key, valueBase64: raw.toString('base64'), valueType: item.valueType })
    }
    return out
  } finally {
    if (opened.db) opened.db.close()
  }
}

function defaultExportFile(prefix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(appPaths().documents, `${prefix}-${stamp}.json`)
}

/** 组装导出内容（纯读客户端 db），导出与切号归档共用同一份实现，避免两套口径 */
async function buildPayload(meta, account, sessionIds) {
  const uid = account && account.uid != null ? String(account.uid) : currentUid(meta.platform)
  let sessions = []
  let tables = []
  let vscdbKeys = []
  let note = ''
  if (meta.kind === 'qoder') {
    const listed = await listQoderSessions(meta)
    sessions = filterSessions(listed.sessions, sessionIds)
    tables = await collectQoderTables(meta, sessions.map((s) => s.id))
    note = QODER_NOTE
  } else {
    const listed = await listTraeSessions(meta)
    sessions = filterSessions(listed.sessions, sessionIds)
    vscdbKeys = await collectTraeKeys(meta, uid, sessionIds.length === 0 ? [] : sessions.map((s) => s.id))
    note = TRAE_NOTE
  }
  return {
    format: FORMAT_SESSIONS,
    version: VERSION,
    exportedAt: Date.now(),
    platform: meta.platform,
    account: {
      id: account && account.id != null ? String(account.id) : null,
      name: account && account.name != null ? String(account.name) : null,
      uid: uid || null
    },
    sessions,
    tables,
    vscdbKeys,
    note
  }
}

async function exportSessions(options = {}) {
  const opts = options || {}
  const meta = clientMeta(opts.platform)
  if (!meta) {
    throw new Error('请指定具体平台（如 qoder-cn / trae-cn），不支持批量平台导出')
  }
  const account = currentAccount(meta.platform, opts.accountId)
  const payload = await buildPayload(meta, account, Array.isArray(opts.sessionIds) ? opts.sessionIds : [])
  const file = opts.file ? String(opts.file) : defaultExportFile(`sessions-${meta.platform}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeJsonAtomic(file, payload)
  return { ok: true, file, count: payload.sessions.length }
}

function validatePayload(data, format, label) {
  if (!data || typeof data !== 'object') throw new Error(`${label}导出文件为空或格式错误`)
  if (data.format !== format) throw new Error(`不是有效的${label}导出文件（format 不匹配）`)
  if (Number(data.version) !== VERSION) throw new Error(`${label}导出文件版本不支持：${data.version}`)
}

function normalizeMode(mode) {
  const m = String(mode || 'merge')
  if (m !== 'merge' && m !== 'replace') throw new Error('mode 只能是 merge 或 replace')
  return m
}

function rewriteUidInKey(key, oldUid, newUid) {
  if (!oldUid || !newUid || oldUid === newUid) return key
  const re = new RegExp(`(^|[^0-9])${escapeRe(oldUid)}(?=[^0-9]|$)`, 'g')
  return key.replace(re, `$1${newUid}`)
}

/** Qoder 导入：按表主键判断是否已存在，merge 只补不删；replace 覆盖同主键行 */
async function importQoder(data, mode, dryRun) {
  const meta = clientMeta(data.platform)
  if (!meta || meta.kind !== 'qoder') throw new Error('导出文件的平台不是 Qoder 变体')
  const file = qoderDbPath(meta)
  if (!exists(file)) throw new Error(`${meta.label} 的 main.sqlite 不存在，无法导入`)
  if (!dryRun) assertClientClosed(meta)
  const opened = await openSqlite(file)
  if (!opened.ok) throw new Error('目标会话库无法打开（可能已损坏或正被占用）')
  let imported = 0
  let skipped = 0
  try {
    for (const tablePlan of Array.isArray(data.tables) ? data.tables : []) {
      const table = String(tablePlan.table || '')
      if (!table || !/^chat_session/i.test(table)) {
        skipped += Array.isArray(tablePlan.rows) ? tablePlan.rows.length : 0
        continue
      }
      const info = queryRows(opened.db, `PRAGMA table_info(${quoteIdent(table)})`)
      if (!info.length) {
        skipped += Array.isArray(tablePlan.rows) ? tablePlan.rows.length : 0
        continue
      }
      const actual = new Set(info.map((r) => String(r.name)))
      const columns = (Array.isArray(tablePlan.columns) ? tablePlan.columns : [])
        .map(String)
        .filter((c) => actual.has(c))
      if (columns.length === 0) {
        skipped += Array.isArray(tablePlan.rows) ? tablePlan.rows.length : 0
        continue
      }
      const pk = info
        .filter((r) => Number(r.pk) > 0)
        .map((r) => String(r.name))
        .filter((c) => columns.includes(c))
      const keyColumns = pk.length ? pk : columns.filter((c) => /^(session_id|message_id|input_id|group_id|identifier|turn_id)$/i.test(c))
      const insertSql = `INSERT OR REPLACE INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      const existsSql = keyColumns.length
        ? `SELECT 1 FROM ${quoteIdent(table)} WHERE ${keyColumns.map((c) => `${quoteIdent(c)} IS ?`).join(' AND ')} LIMIT 1`
        : null
      for (const row of Array.isArray(tablePlan.rows) ? tablePlan.rows : []) {
        if (!Array.isArray(row)) {
          skipped++
          continue
        }
        const cells = columns.map((c, i) => decodeCell(row[i]))
        if (mode === 'merge' && existsSql) {
          const keys = keyColumns.map((c) => cells[columns.indexOf(c)])
          if (queryRows(opened.db, existsSql, keys).length > 0) {
            skipped++
            continue
          }
        }
        // dryRun 只计算不写盘，也不在内存 db 上执行变更
        if (!dryRun) opened.db.run(insertSql, cells)
        imported++
      }
    }
    if (!dryRun && imported > 0) {
      atomicWrite(file, Buffer.from(opened.db.export()), true)
    }
  } finally {
    opened.db.close()
  }
  return {
    ok: true,
    imported,
    skipped,
    dryRun: Boolean(dryRun),
    message: dryRun
      ? `预演：将写入 ${imported} 行、跳过 ${skipped} 行，未写盘`
      : `已合并 ${imported} 行，跳过 ${skipped} 行（已备份原库）`
  }
}

/** Trae 导入：键级写回，可选把键里的旧 uid 换成目标 uid；绝不整库覆盖 */
async function importTrae(data, mode, dryRun, targetUid) {
  const meta = clientMeta(data.platform)
  if (!meta || meta.kind !== 'trae') throw new Error('导出文件的平台不是 Trae 变体')
  const file = globalDbPath(meta)
  if (!exists(file)) throw new Error(`${meta.label} 的 state.vscdb 不存在，无法导入`)
  const opened = await openVscdb(file)
  if (!opened.ok) throw new Error('目标 state.vscdb 无法打开（可能已损坏）')
  const oldUid = data.account && data.account.uid != null ? String(data.account.uid) : null
  const newUid = targetUid ? String(targetUid) : null
  const patch = []
  let skipped = 0
  try {
    for (const item of Array.isArray(data.vscdbKeys) ? data.vscdbKeys : []) {
      if (!item || typeof item.key !== 'string' || typeof item.valueBase64 !== 'string') {
        skipped++
        continue
      }
      if (isSensitiveKey(item.key)) {
        skipped++
        continue
      }
      const key = rewriteUidInKey(item.key, oldUid, newUid)
      if (mode === 'merge' && opened.rows.has(key)) {
        skipped++
        continue
      }
      patch.push({
        key,
        value: Buffer.from(item.valueBase64, 'base64'),
        valueType: item.valueType === 'blob' ? 'blob' : 'text'
      })
    }
  } finally {
    if (opened.db) opened.db.close()
  }
  const result = await writeKeys(file, patch, { client: meta, dryRun: Boolean(dryRun), backup: true })
  return {
    ok: true,
    imported: result.written,
    skipped: skipped + result.skipped,
    dryRun: Boolean(dryRun),
    message: dryRun
      ? `预演：将写入 ${result.written} 个键、跳过 ${skipped + result.skipped} 个键，未写盘`
      : `已写入 ${result.written} 个键，跳过 ${skipped + result.skipped} 个键（已备份原库，其它键原样保留）`
  }
}

async function importSessions(options = {}) {
  const opts = options || {}
  if (!opts.file) throw new Error('请提供要导入的会话文件')
  const data = readJson(String(opts.file))
  validatePayload(data, FORMAT_SESSIONS, '会话')
  const mode = normalizeMode(opts.mode)
  const dryRun = Boolean(opts.dryRun)
  if (data.platform && clientMeta(data.platform) && clientMeta(data.platform).kind === 'qoder') {
    return importQoder(data, mode, dryRun)
  }
  return importTrae(data, mode, dryRun, opts.targetUid ? String(opts.targetUid) : null)
}

function archiveDir(meta) {
  return path.join(appPaths().userData, 'session-archives', meta.platform)
}

function safeUid(uid) {
  return String(uid || 'unknown').replace(/[^\w.@-]/g, '_')
}

/** 只保留我们自己的归档文件，按时间戳倒序留最近 N 份，绝不覆盖既有归档 */
function pruneArchives(dir, uid, keep) {
  if (!exists(dir)) return
  const prefix = `${safeUid(uid)}-`
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const item of files.slice(keep)) fs.unlinkSync(path.join(dir, item.name))
  } catch {
    // 清理失败不影响本次归档结果
  }
}

function latestArchive(dir, uid) {
  if (!exists(dir)) return null
  const prefix = `${safeUid(uid)}-`
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return files.length ? path.join(dir, files[0].name) : null
  } catch {
    return null
  }
}

/** 切号前归档当前账号的本地会话到应用自己的 userData（只读客户端 db，不写客户端文件） */
async function snapshotForSwitch(account) {
  const settings = getSettings()
  if (!settings.autoArchive) return { ok: true, skipped: true, message: '自动归档已关闭' }
  const meta = clientMeta(account && account.platform)
  if (!meta) return { ok: true, skipped: true, message: '该平台不支持会话归档' }
  const uid = account && account.uid != null ? String(account.uid) : 'unknown'
  const payload = await buildPayload(meta, account, [])
  const dir = archiveDir(meta)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${safeUid(uid)}-${stamp}.json`)
  fs.mkdirSync(dir, { recursive: true })
  writeJsonAtomic(file, payload)
  pruneArchives(dir, uid, Number(settings.archiveKeep) || DEFAULT_SETTINGS.archiveKeep)
  return { ok: true, file, count: payload.sessions.length, message: `已归档 ${payload.sessions.length} 条会话` }
}

/**
 * 切号后按 merge 还原目标账号归档。
 * 为什么：switchAccount 默认会重新拉起客户端，此时写库会损坏数据，所以检测到进程在跑就跳过，
 *        并把原因写进 message 交给调用方 warn，绝不让一次成功切号被报成失败。
 */
async function restoreForSwitch(account) {
  const settings = getSettings()
  if (!settings.autoArchive) return { ok: true, skipped: true, message: '自动归档已关闭' }
  const meta = clientMeta(account && account.platform)
  if (!meta) return { ok: true, skipped: true, message: '该平台不支持会话归档' }
  const uid = account && account.uid != null ? String(account.uid) : 'unknown'
  const file = latestArchive(archiveDir(meta), uid)
  if (!file) return { ok: true, skipped: true, message: '该账号暂无会话归档，跳过还原' }
  const running = meta.exeNames.find((n) => isProcessRunning(n))
  if (running) {
    return {
      ok: true,
      skipped: true,
      message: `${meta.label} 已启动，为保护会话数据跳过自动还原；可关闭客户端后手动导入归档`
    }
  }
  return importSessions({ file, mode: 'merge', dryRun: false })
}

module.exports = {
  FORMAT_SESSIONS,
  VERSION,
  setStore,
  getSettings,
  setSettings,
  listSessions,
  exportSessions,
  importSessions,
  snapshotForSwitch,
  restoreForSwitch
}
