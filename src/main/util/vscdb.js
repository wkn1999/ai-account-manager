'use strict'
// state.vscdb / main.sqlite 读写小工具（只读打开、键级更新、原子写回）
// 为什么：客户端运行时会锁库，整体覆盖 state.vscdb 会丢会话；这里只做「键级/行级合并」+ 备份 + 原子替换，
//        绝不提供整库覆盖式恢复入口。
// 为什么：sql.js 只能读主库文件，未 checkpoint 的 -wal/-shm 内容读不到；只读列举场景忽略即可，
//        归档/导入前会要求关闭客户端，让客户端自己把 WAL 落盘。

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { appDataDir, exists, backupFile, isProcessRunning } = require('./core')

// 平台变体表：目录名 / 进程名与 platforms 适配器保持一致，国际版可能没数据，一律优雅返回空
const CLIENTS = {
  'qoder-cn': {
    platform: 'qoder-cn',
    family: 'qoder',
    kind: 'qoder',
    label: 'Qoder 国内版 客户端',
    dirName: 'com.qodercn.app.stable',
    exeNames: ['Qoder CN.exe', 'Qoder.exe']
  },
  qoder: {
    platform: 'qoder',
    family: 'qoder',
    kind: 'qoder',
    label: 'Qoder 国际版 客户端',
    dirName: 'com.qoder.app.stable',
    exeNames: ['Qoder.exe']
  },
  'trae-cn': {
    platform: 'trae-cn',
    family: 'trae',
    kind: 'trae',
    label: 'Trae 国内版 客户端',
    dirName: 'Trae CN',
    exeNames: ['Trae CN.exe']
  },
  trae: {
    platform: 'trae',
    family: 'trae',
    kind: 'trae',
    label: 'Trae 国际版 客户端',
    dirName: 'Trae',
    exeNames: ['Trae.exe']
  }
}

let SQL = null

/**
 * 定位 sql-wasm.wasm：打包后 asar 里的 .wasm 不能被 emscripten 直接读，
 * 必须指向 build.asarUnpack 解包出来的 app.asar.unpacked 目录。
 */
function wasmPath() {
  let resolved = require.resolve('sql.js/dist/sql-wasm.wasm')
  try {
    const electron = require('electron')
    if (electron && electron.app && electron.app.isPackaged) {
      resolved = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    }
  } catch {
    // 纯 Node 自检场景没有 electron，直接用 node_modules 里的原始路径
  }
  return resolved
}

async function getSql() {
  if (SQL) return SQL
  const initSqlJs = require('sql.js')
  const locate = wasmPath()
  SQL = await initSqlJs({ locateFile: () => locate })
  return SQL
}

function clientMeta(platform) {
  return CLIENTS[String(platform || '').trim()] || null
}

/** 支持精确变体 id、变体数组、'all'、以及 'qoder-all'/'trae-all' 家族别名 */
function resolveClients(platform) {
  if (Array.isArray(platform)) return platform.map(clientMeta).filter(Boolean)
  const key = String(platform || '').trim()
  if (!key || key === 'all') return Object.keys(CLIENTS).map((k) => CLIENTS[k])
  if (CLIENTS[key]) return [CLIENTS[key]]
  if (key === 'qoder-all' || key === 'trae-all') {
    const family = key.slice(0, -4)
    return Object.keys(CLIENTS).map((k) => CLIENTS[k]).filter((m) => m.family === family)
  }
  return []
}

function globalDbPath(meta) {
  return appDataDir(meta.dirName, 'User', 'globalStorage', 'state.vscdb')
}

function qoderDbPath(meta) {
  return appDataDir(meta.dirName, 'main.sqlite')
}

/** Trae 的 workspaceStorage 里也有 currentAgentData_<uid> 副本，列举时要能都读到 */
function workspaceDbPaths(meta) {
  const root = appDataDir(meta.dirName, 'User', 'workspaceStorage')
  if (!exists(root)) return []
  const out = []
  try {
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, 'state.vscdb')
      if (exists(file)) out.push({ file, source: `${meta.platform}:workspaceStorage/${name}` })
    }
  } catch {
    return out
  }
  return out
}

/**
 * 应用自身目录。纯 Node 自检脚本没有 electron.app，退回环境变量推导，
 * 保证 scripts/vault-probe.js 能在不启动 Electron 的情况下跑通。
 */
function appPaths() {
  try {
    const electron = require('electron')
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      const app = electron.app
      return {
        userData: app.getPath('userData'),
        documents: app.getPath('documents'),
        desktop: app.getPath('desktop'),
        appExe: app.getPath('exe'),
        isPackaged: Boolean(app.isPackaged)
      }
    }
  } catch {
    // fallthrough
  }
  const home = os.homedir()
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  return {
    userData: path.join(roaming, 'ai-account-manager'),
    documents: path.join(home, 'Documents'),
    desktop: path.join(home, 'Desktop'),
    appExe: process.execPath,
    isPackaged: false
  }
}

// 登录态/凭据类键一律不导出、不写回；宁可少导一项，也不能把凭据带出本机
const SENSITIVE_KEY_RE = /secret:\/\/|token|cookie|csrf|password|credential|oauth|authinfo|bearer|api[_-]?key/i

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ''))
}

/** 写盘前必须确认客户端已关闭，运行中直接抛可读中文错误 */
function assertClientClosed(client) {
  if (!client) return
  const names = Array.isArray(client.exeNames) ? client.exeNames : []
  const running = names.find((n) => isProcessRunning(n))
  if (running) {
    throw new Error(`请先关闭 ${client.label || '客户端'} 客户端再导入，否则会损坏会话数据（进程 ${running} 仍在运行）`)
  }
}

/** tmp + rename：写一半失败时原文件仍是完整的 */
function atomicWrite(file, buf, doBackup) {
  if (doBackup !== false) backupFile(file)
  const tmp = `${file}.tmp${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, buf)
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 清理失败不覆盖原始异常
    }
    throw new Error(`写入失败（原子替换未完成）：${e.message}`)
  }
}

function toText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

/** 保持 value 的原始类型：TEXT 写字符串、BLOB 写 Uint8Array，否则客户端读出来会解析失败 */
function toBindValue(entry) {
  const raw = entry && entry.value != null ? entry.value : null
  const type = entry && entry.valueType === 'blob' ? 'blob' : 'text'
  if (type === 'blob') {
    if (raw == null) return new Uint8Array(0)
    if (Buffer.isBuffer(raw)) return new Uint8Array(raw)
    if (raw instanceof Uint8Array) return raw
    return new Uint8Array(Buffer.from(String(raw), 'utf8'))
  }
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  return toText(raw)
}

function sha256File(file) {
  if (!exists(file)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safeParse(text) {
  const raw = toText(text)
  if (!raw || !raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/**
 * 只读打开 state.vscdb。文件不存在/损坏时返回空而不抛，
 * 让国际版未安装、客户端正在写库等场景都能优雅降级。
 * @returns {{file:string, ok:boolean, db:object|null, rows:Map<string, Buffer|string>, types:Map<string,string>}}
 */
async function openVscdb(file) {
  const empty = { file, ok: false, db: null, rows: new Map(), types: new Map() }
  if (!exists(file)) return empty
  let db = null
  try {
    const S = await getSql()
    db = new S.Database(fs.readFileSync(file))
    const result = db.exec('SELECT key, value, typeof(value) FROM ItemTable')
    const rows = new Map()
    const types = new Map()
    const values = result.length ? result[0].values : []
    for (const row of values) {
      const key = String(row[0])
      const raw = row[1]
      const type = String(row[2] || 'text') === 'blob' ? 'blob' : 'text'
      let value = null
      if (raw != null) value = typeof raw === 'string' ? raw : Buffer.from(raw)
      rows.set(key, value)
      types.set(key, type)
    }
    return { file, ok: true, db, rows, types }
  } catch {
    try {
      if (db) db.close()
    } catch {
      // 关闭失败不影响返回空结果
    }
    return empty
  }
}

/**
 * 按键过滤读取。兼容传入 openVscdb 的结果对象或原始 SQL.Database。
 * @returns {Array<{key:string, value:Buffer|string|null, valueType:string}>}
 */
function readKeys(source, predicate) {
  const test = typeof predicate === 'function' ? predicate : () => true
  const out = []
  if (!source) return out
  if (source.rows instanceof Map) {
    for (const [key, value] of source.rows) {
      if (!test(key, value)) continue
      const valueType = (source.types && source.types.get(key)) || (typeof value === 'string' ? 'text' : 'blob')
      out.push({ key, value, valueType })
    }
    return out
  }
  if (typeof source.exec === 'function') {
    const result = source.exec('SELECT key, value, typeof(value) FROM ItemTable')
    for (const row of (result.length ? result[0].values : [])) {
      const key = String(row[0])
      if (!test(key, row[1])) continue
      const raw = row[1]
      const valueType = String(row[2] || 'text') === 'blob' ? 'blob' : 'text'
      const value = raw == null ? null : typeof raw === 'string' ? raw : Buffer.from(raw)
      out.push({ key, value, valueType })
    }
  }
  return out
}

/**
 * 键级写回：逐键 INSERT OR REPLACE，再 export() 原子替换。
 * 绝不整库覆盖 —— 其它账号/全局键原样保留。
 * @param {Array<{key:string,value:*,valueType?:string}>|Record<string,*>} patch
 * @param {{backup?:boolean, dryRun?:boolean, client?:object}} opts
 */
async function writeKeys(file, patch, opts = {}) {
  const options = { backup: true, dryRun: false, client: null, ...opts }
  const list = Array.isArray(patch)
    ? patch
    : Object.entries(patch || {}).map(([key, value]) => ({ key, value }))
  const usable = []
  let skipped = 0
  for (const entry of list) {
    if (!entry || typeof entry.key !== 'string' || !entry.key || isSensitiveKey(entry.key)) {
      skipped++
      continue
    }
    usable.push(entry)
  }
  if (options.dryRun) {
    return { ok: true, written: usable.length, skipped, dryRun: true, file }
  }
  if (usable.length === 0) {
    return { ok: true, written: 0, skipped, dryRun: false, file }
  }
  assertClientClosed(options.client)
  if (!exists(file)) throw new Error('目标数据库不存在，拒绝新建：' + path.basename(file))
  const S = await getSql()
  const db = new S.Database(fs.readFileSync(file))
  try {
    const table = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")
    if (!table.length) throw new Error('目标文件不是有效的 state.vscdb（缺少 ItemTable）')
    for (const entry of usable) {
      db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [entry.key, toBindValue(entry)])
    }
    atomicWrite(file, Buffer.from(db.export()), options.backup !== false)
  } finally {
    db.close()
  }
  return { ok: true, written: usable.length, skipped, dryRun: false, file }
}

/** 只读打开任意 sqlite（Qoder main.sqlite），不存在/损坏返回 ok:false */
async function openSqlite(file) {
  if (!exists(file)) return { file, ok: false, db: null }
  try {
    const S = await getSql()
    return { file, ok: true, db: new S.Database(fs.readFileSync(file)) }
  } catch {
    return { file, ok: false, db: null }
  }
}

/** 参数化查询，返回 [{列名: 值}]；所有 SQL 由调用方拼接列名白名单，参数一律绑定 */
function queryRows(db, sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    if (params.length) stmt.bind(params)
    const columns = stmt.getColumnNames()
    const out = []
    while (stmt.step()) {
      const values = stmt.get()
      const row = {}
      columns.forEach((c, i) => {
        row[c] = values[i]
      })
      out.push(row)
    }
    return out
  } finally {
    stmt.free()
  }
}

module.exports = {
  CLIENTS,
  getSql,
  clientMeta,
  resolveClients,
  globalDbPath,
  qoderDbPath,
  workspaceDbPaths,
  appPaths,
  isSensitiveKey,
  assertClientClosed,
  atomicWrite,
  toText,
  toBindValue,
  sha256File,
  escapeRe,
  safeParse,
  quoteIdent,
  openVscdb,
  readKeys,
  writeKeys,
  openSqlite,
  queryRows
}
