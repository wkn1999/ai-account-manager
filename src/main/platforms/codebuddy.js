'use strict'
// CodeBuddy（国际 / 国内）适配器
// 登录态：%APPDATA%\<CodeBuddy|CodeBuddy CN>\User\globalStorage\state.vscdb 的 ItemTable
// 键：secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessToken[cn]"}
// 值：Chromium safeStorage v10（DPAPI + AES-256-GCM）加密的会话 JSON

const fs = require('fs')
const path = require('path')
const { appDataDir, localAppDataDir, exists, backupFile, isProcessRunning, killProcess, launchApp, sleep } = require('../util/core')
const { loadMasterKey, decryptV10, encryptV10, bufferFromJsonValue } = require('../util/vscodeSafeStorage')
const { markExpiry } = require('../util/quota')

const VARIANTS = {
  codebuddy: {
    id: 'codebuddy',
    label: 'CodeBuddy 国际版',
    appDir: 'CodeBuddy',
    exeNames: ['CodeBuddy.exe'],
    secretKey: 'planning-genie.new.accessToken',
    api: 'https://www.codebuddy.ai',
    region: 'international',
    checkin: false
  },
  'codebuddy-cn': {
    id: 'codebuddy-cn',
    label: 'CodeBuddy 国内版',
    appDir: 'CodeBuddy CN',
    exeNames: ['CodeBuddy.exe', 'CodeBuddy CN.exe'],
    secretKey: 'planning-genie.new.accessTokencn',
    api: 'https://www.codebuddy.cn',
    region: 'cn',
    checkin: true
  }
}

let SQL = null
async function getSql() {
  if (SQL) return SQL
  const initSqlJs = require('sql.js')
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  SQL = await initSqlJs({ locateFile: () => wasmPath })
  return SQL
}

function stateDbPath(v) {
  return appDataDir(v.appDir, 'User', 'globalStorage', 'state.vscdb')
}
function localStatePath(v) {
  return appDataDir(v.appDir, 'Local State')
}
function findExe(v) {
  for (const n of v.exeNames) {
    const p = localAppDataDir('Programs', v.appDir, n)
    if (exists(p)) return p
    const p2 = path.join(process.env['ProgramFiles'] || 'C:\\Program Files', v.appDir, n)
    if (exists(p2)) return p2
  }
  return null
}

function sqliteKeyPath(v) {
  return `secret://{"extensionId":"tencent-cloud.coding-copilot","key":"${v.secretKey}"}`
}

/** 读取并解密会话 */
async function readSnapshot(variant) {
  const v = VARIANTS[variant]
  if (!v) return null
  const dbPath = stateDbPath(v)
  if (!exists(dbPath)) return null
  let masterKey
  try {
    masterKey = loadMasterKey(localStatePath(v))
  } catch {
    return null
  }
  const S = await getSql()
  const db = new S.Database(fs.readFileSync(dbPath))
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
    stmt.bind([sqliteKeyPath(v)])
    if (!stmt.step()) return null
    const raw = bufferFromJsonValue(stmt.get()[0])
    stmt.free()
    if (!raw) return null
    let session
    try {
      session = JSON.parse(decryptV10(masterKey, raw).toString('utf8'))
    } catch {
      return null
    }
    return { variant, session }
  } finally {
    db.close()
  }
}

function toAccount(snap) {
  const v = VARIANTS[snap.variant]
  const s = snap.session || {}
  const acc = s.account || {}
  const uid = acc.uid || s.uid || null
  return {
    id: `${snap.variant}:${String(uid || acc.nickname || 'unknown').replace(/[^\w.@-]/g, '_')}`,
    platform: snap.variant,
    platformLabel: v.label,
    region: v.region,
    name: acc.nickname || acc.label || uid || '未命名账号',
    email: acc.email || null,
    uid,
    plan: acc.type || null,
    snapshot: { session: s },
    updatedAt: Date.now()
  }
}

async function detectCurrent(variant) {
  const snap = await readSnapshot(variant)
  return snap ? toAccount(snap) : null
}

/** 切换：关闭客户端 → 重新加密写入 state.vscdb → 启动 */
async function applyAccount(account, opts = {}) {
  const v = VARIANTS[account.platform]
  if (!v) throw new Error('未知平台: ' + account.platform)
  const running = v.exeNames.find((n) => isProcessRunning(n))
  if (running) {
    if (opts.killRunning === false) throw new Error(`${v.label} 正在运行，请先关闭后再切换`)
    killProcess(running)
    await sleep(1500)
  }
  const dbPath = stateDbPath(v)
  const masterKey = loadMasterKey(localStatePath(v))
  const encrypted = encryptV10(masterKey, Buffer.from(JSON.stringify(account.snapshot.session), 'utf8'))
  const valueJson = JSON.stringify({ type: 'Buffer', data: Array.from(encrypted) })

  const S = await getSql()
  const db = new S.Database(fs.readFileSync(dbPath))
  try {
    db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [sqliteKeyPath(v), valueJson])
    backupFile(dbPath)
    fs.writeFileSync(dbPath, Buffer.from(db.export()))
  } finally {
    db.close()
  }

  const exe = findExe(v)
  const shouldLaunch = Boolean(exe) && opts.launch !== false
  if (shouldLaunch) launchApp(exe)
  return { ok: true, storagePath: dbPath, launched: shouldLaunch }
}

function sessionToken(account) {
  const s = (account.snapshot && account.snapshot.session) || {}
  return (s.auth && s.auth.accessToken) || s.accessToken || s.token || null
}

function sessionRefreshToken(account) {
  const s = (account.snapshot && account.snapshot.session) || {}
  return (s.auth && s.auth.refreshToken) || s.refreshToken || null
}

/** 使用 refreshToken 换取新的 accessToken，并写回快照 */
async function refreshAccessToken(account) {
  const v = VARIANTS[account.platform]
  const s = (account.snapshot && account.snapshot.session) || {}
  const token = sessionToken(account)
  const refresh = sessionRefreshToken(account)
  if (!token || !refresh) throw new Error('缺少 token / refreshToken，请重新导入账号')
  const res = await fetch(v.api + '/v2/plugin/auth/token/refresh', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Refresh-Token': refresh,
      'X-Auth-Refresh-Source': 'ide-main',
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: '{}'
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`刷新 Token 失败 HTTP ${res.status}`)
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('刷新 Token 响应非 JSON')
  }
  const d = data.data || {}
  if (!d.accessToken) throw new Error('刷新 Token 未返回 accessToken')

  if (!s.auth) s.auth = {}
  s.auth.accessToken = d.accessToken
  if (d.refreshToken) s.auth.refreshToken = d.refreshToken
  if (d.expiresIn) s.auth.expiresIn = d.expiresIn
  if (d.expiresAt) s.auth.expiresAt = d.expiresAt
  s.auth.lastRefreshTime = Date.now()
  s.accessToken = d.accessToken
  if (d.refreshToken) s.refreshToken = d.refreshToken
  account.snapshot.session = s
  return d.accessToken
}

function buildHeaders(account) {
  const s = (account.snapshot && account.snapshot.session) || {}
  const acc = s.account || {}
  const token = sessionToken(account)
  if (!token) throw new Error('缺少 accessToken，请重新导入账号')
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json'
  }
  if (acc.uid) h['X-User-Id'] = acc.uid
  const eid = acc.enterpriseId
  if (eid) {
    h['X-Enterprise-Id'] = eid
    h['X-Tenant-Id'] = eid
  }
  if (s.domain) h['X-Domain'] = s.domain.replace(/^www\./, '')
  return h
}

async function apiFetch(account, method, p, body) {
  const v = VARIANTS[account.platform]
  let res = await fetch(v.api + p, {
    method,
    headers: buildHeaders(account),
    body: method === 'GET' ? undefined : body === undefined ? '{}' : body
  })
  if (res.status === 401) {
    await refreshAccessToken(account)
    res = await fetch(v.api + p, {
      method,
      headers: buildHeaders(account),
      body: method === 'GET' ? undefined : body === undefined ? '{}' : body
    })
  }
  const text = await res.text()
  return { status: res.status, text }
}

function toNum(x) {
  if (typeof x === 'number') return x
  if (typeof x === 'string' && x.trim() && !isNaN(Number(x))) return Number(x)
  return null
}

/** 查询积分/额度：汇总 get-user-resource 返回的各资源包容量 */
async function fetchQuota(account) {
  const r = await apiFetch(account, 'POST', '/v2/billing/meter/get-user-resource', '{}')
  if (r.status !== 200) {
    const e = new Error(`额度查询失败 HTTP ${r.status}`)
    e.loggedOut = r.status === 401
    throw e
  }
  let raw
  try {
    raw = JSON.parse(r.text)
  } catch {
    throw new Error('额度响应非 JSON')
  }
  if (raw.code && raw.code !== 0) throw new Error(`额度查询失败 code=${raw.code} ${raw.msg || ''}`)

  const data = (raw.data && raw.data.Response && raw.data.Response.Data) || {}
  const accounts = Array.isArray(data.Accounts) ? data.Accounts : []

  // 单个账号（含无套餐的默认账号）的完整积分展示
  const acc = (account.snapshot && account.snapshot.session && account.snapshot.session.account) || {}

  let total = 0
  let remaining = 0
  let used = 0
  const items = []
  const seen = new Set()
  for (const a of accounts) {
    const size = toNum(a.CapacitySize) || 0
    const remain = toNum(a.CapacityRemain) || 0
    const usedV = toNum(a.CapacityUsed) || 0
    total += size
    remaining += remain
    used += usedV
    const name = a.PackageName || a.SubProductName || a.ProductName || '资源包'
    if (!seen.has(name)) {
      seen.add(name)
      items.push({
        label: name,
        endTime: a.ExpiredTime ? new Date(a.ExpiredTime.replace(/-/g, '/')).getTime() : null,
        metrics: [{ label: '剩余/总量', limit: size, used: remain }]
      })
    }
  }
  // 同一资源包名可能多份，做去重后再合并展示（保留前 6 个）
  markExpiry(items)
  items.length = Math.min(items.length, 6)

  let summary = null
  if (total > 0) {
    summary = { total, used, remaining, unit: '积分' }
  } else if (toNum(data.TotalDosage) != null) {
    summary = { total: toNum(data.TotalDosage), used: 0, remaining: toNum(data.TotalDosage), unit: '积分' }
  }

  return {
    plan: acc.type || acc.accountType || null,
    summary,
    items,
    raw
  }
}

/** 查询签到状态 */
async function checkinStatus(account) {
  const r = await apiFetch(account, 'POST', '/v2/billing/meter/checkin-activity-status', '{}')
  if (r.status !== 200) {
    return { ok: false, supported: true, loggedOut: r.status === 401, message: `签到状态查询失败 HTTP ${r.status}` }
  }
  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    return { ok: false, supported: true, message: '响应非 JSON' }
  }
  if (j.code && j.code !== 0) return { ok: false, supported: true, message: j.msg || `code=${j.code}` }
  const d = j.data || {}
  const checkedIn = Boolean(d.today_checked_in)
  return {
    ok: true,
    supported: true,
    checkedIn,
    streakDays: toNum(d.streak_days) || 0,
    credits: toNum(d.today_credit) ?? 0,
    totalCredits: toNum(d.total_credits) ?? 0,
    dailyCredit: toNum(d.daily_credit) ?? 0,
    activity: d.theme_name || d.activity_name || '',
    message: checkedIn
      ? `今日已签到 · 连续 ${d.streak_days || 0} 天 · 累计 ${d.total_credits || 0} 积分`
      : '今日未签到'
  }
}

/** 一键签到 */
async function checkin(account) {
  const status = await checkinStatus(account)
  if (status.ok && status.checkedIn) {
    return { ok: true, alreadyCheckedIn: true, message: status.message }
  }
  const r = await apiFetch(account, 'POST', '/v2/billing/meter/daily-checkin', '{}')
  if (r.status !== 200) return { ok: false, loggedOut: r.status === 401, message: `签到失败 HTTP ${r.status}` }
  let j = {}
  try {
    j = JSON.parse(r.text)
  } catch {
    /* ignore */
  }
  if (j.code && j.code !== 0) return { ok: false, message: j.msg || j.message || `签到失败 code=${j.code}` }
  const after = await checkinStatus(account).catch(() => null)
  return {
    ok: true,
    alreadyCheckedIn: false,
    message: after && after.ok ? `签到成功 · ${after.message}` : '签到成功'
  }
}

module.exports = {
  VARIANTS,
  variants: Object.keys(VARIANTS),
  stateDbPath,
  readSnapshot,
  detectCurrent,
  applyAccount,
  fetchQuota,
  checkin,
  checkinStatus,
  findExe
}
