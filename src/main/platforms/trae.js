'use strict'
// Trae（国际 / 国内）适配器
// 登录态存放于 %APPDATA%\<Trae|Trae CN>\User\globalStorage\storage.json
// 关键键：iCubeAuthInfo://icube.cloudide（ByteCrypto 加密的 JSON，含 token 等）

const path = require('path')
const {
  appDataDir,
  exists,
  readJson,
  writeJsonAtomic,
  backupFile,
  parseIcubeValue,
  isProcessRunning,
  killProcess,
  launchApp,
  sleep,
  localAppDataDir
} = require('../util/core')
const { markExpiry } = require('../util/quota')

const AUTH_PREFIX = 'iCubeAuthInfo://'
const SERVER_PREFIX = 'iCubeServerData://'
const ENTITLEMENT_PREFIX = 'iCubeEntitlementInfo://'
const DEVICE_PREFIX = 'iCubeAuthInfo://icube-dc:'
const USERTAG_KEY = 'iCubeAuthInfo://usertag'
const DEFAULT_PROVIDER = 'icube.cloudide'

const VARIANTS = {
  trae: {
    id: 'trae',
    label: 'Trae 国际版',
    dirName: 'Trae',
    exeName: 'Trae.exe',
    region: 'international',
    checkin: false,
    apiOrigins: ['https://grow-normal.trae.ai', 'https://growsg-normal.trae.ai', 'https://grow-normal.traeapi.us'],
    apiVersion: 'v1'
  },
  'trae-cn': {
    id: 'trae-cn',
    label: 'Trae 国内版',
    dirName: 'Trae CN',
    exeName: 'Trae CN.exe',
    region: 'cn',
    checkin: true,
    apiOrigins: ['https://api.trae.cn', 'https://api.trae.com.cn'],
    apiVersion: 'v2'
  }
}

function storagePath(v) {
  return appDataDir(v.dirName, 'User', 'globalStorage', 'storage.json')
}

function findExe(v) {
  const candidates = [
    localAppDataDir('Programs', v.dirName, v.exeName),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', v.dirName, v.exeName),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', v.dirName, v.exeName)
  ]
  return candidates.find((p) => exists(p)) || null
}

function pickString(root, keys) {
  if (!root || typeof root !== 'object') return null
  for (const key of keys) {
    const val = root[key]
    if (typeof val === 'string' && val.trim()) return val.trim()
    if (typeof val === 'number' && Number.isFinite(val)) return String(val)
  }
  return null
}

function pickEmail(root) {
  const direct = pickString(root, ['email', 'Email', 'NonPlainTextEmail', 'mail'])
  return direct && direct.includes('@') ? direct.toLowerCase() : null
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v)
  return null
}

/** 读取 storage.json 并抽取登录态 */
function readSnapshot(variant) {
  const v = VARIANTS[variant]
  if (!v) return null
  const p = storagePath(v)
  const storage = readJson(p)
  if (!storage) return null

  const keys = Object.keys(storage)
  const authKey = keys.find((k) => k.startsWith(AUTH_PREFIX) && k !== USERTAG_KEY && !k.startsWith(DEVICE_PREFIX))
  if (!authKey) return null
  const auth = parseIcubeValue(storage[authKey])
  if (!auth) return null

  const providerId = authKey.slice(AUTH_PREFIX.length) || DEFAULT_PROVIDER
  const serverKey = SERVER_PREFIX + providerId
  const entitlementKey = ENTITLEMENT_PREFIX + providerId
  const server = parseIcubeValue(storage[serverKey])
  const entitlement = parseIcubeValue(storage[entitlementKey])

  const deviceKeys = {}
  for (const k of keys) {
    if (k.startsWith(DEVICE_PREFIX)) deviceKeys[k] = storage[k]
  }

  const account = auth.account || {}
  const uid =
    pickString(auth, ['userId', 'user_id', 'uid', 'UserID', 'id', 'sub']) ||
    pickString(account, ['userId', 'uid', 'id']) ||
    pickString(server && server.entitlementInfo, ['userId'])
  const email = pickEmail(auth) || pickEmail(account) || pickEmail(server)
  const nickname =
    pickString(auth, ['nickname', 'screenName', 'ScreenName', 'name', 'displayName']) ||
    pickString(account, ['nickname', 'screenName', 'name'])

  const deviceId = Object.keys(deviceKeys)
    .map((k) => k.slice(DEVICE_PREFIX.length))
    .find(Boolean)

  return {
    variant,
    providerId,
    storagePath: p,
    storageRaw: storage,
    authKey,
    serverKey,
    entitlementKey,
    auth,
    server,
    entitlement,
    deviceKeys,
    usertag: storage[USERTAG_KEY],
    token: pickString(auth, ['accessToken', 'access_token', 'token']),
    uid: uid ? String(uid) : null,
    email,
    nickname,
    deviceId,
    plan:
      pickString(entitlement, ['identityStr', 'user_pay_identity_str']) ||
      pickString((server && server.entitlementInfo) || {}, ['identityStr']) ||
      null
  }
}

function toAccount(snap) {
  const v = VARIANTS[snap.variant]
  const idKey = snap.uid || snap.email || snap.nickname || 'unknown'
  return {
    id: `${snap.variant}:${String(idKey).replace(/[^\w.@-]/g, '_')}`,
    platform: snap.variant,
    platformLabel: v.label,
    region: v.region,
    name: snap.nickname || snap.email || snap.uid || '未命名账号',
    email: snap.email || null,
    uid: snap.uid || null,
    plan: snap.plan || null,
    deviceId: snap.deviceId || null,
    snapshot: {
      providerId: snap.providerId,
      authKey: snap.authKey,
      values: {
        [snap.authKey]: snap.storageRaw[snap.authKey],
        [snap.serverKey]: snap.storageRaw[snap.serverKey],
        [snap.entitlementKey]: snap.storageRaw[snap.entitlementKey],
        [USERTAG_KEY]: snap.storageRaw[USERTAG_KEY],
        ...snap.deviceKeys
      }
    },
    updatedAt: Date.now()
  }
}

function detectCurrent(variant) {
  const snap = readSnapshot(variant)
  return snap ? toAccount(snap) : null
}

/** 一键切换：关闭客户端 → 写入 storage.json → 启动客户端 */
async function applyAccount(account, opts = {}) {
  const v = VARIANTS[account.platform]
  if (!v) throw new Error('未知平台: ' + account.platform)
  const p = storagePath(v)

  if (isProcessRunning(v.exeName)) {
    if (opts.killRunning === false) throw new Error(`${v.label} 正在运行，请先关闭后再切换`)
    killProcess(v.exeName)
    await sleep(1500)
  }

  const storage = readJson(p) || {}
  for (const [k, val] of Object.entries((account.snapshot && account.snapshot.values) || {})) {
    if (val === undefined || val === null) continue
    storage[k] = val
  }
  backupFile(p)
  writeJsonAtomic(p, storage)

  const exe = findExe(v)
  const shouldLaunch = Boolean(exe) && opts.launch !== false
  if (shouldLaunch) launchApp(exe)
  return { ok: true, storagePath: p, launched: shouldLaunch }
}

function extractAccessToken(account) {
  const snapshot = account.snapshot || {}
  const values = snapshot.values || {}
  const authRaw = parseIcubeValue(values[snapshot.authKey])
  return authRaw && pickString(authRaw, ['accessToken', 'access_token', 'token'])
}

/** Trae 没有对外可用的刷新接口，token 一过期只能回客户端重登，所以错误文案要直接给出下一步 */
const LOGGED_OUT = '登录态已失效：请在 Trae 客户端重新登录后点「检测本机账号」重新导入'

async function traePayRequest(url, accessToken) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Trae/1.0.0 ai-account-manager',
      Authorization: `Cloud-IDE-JWT ${accessToken}`
    },
    body: JSON.stringify({ require_usage: true })
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401) {
      const e = new Error(LOGGED_OUT)
      e.loggedOut = true
      throw e
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('响应非 JSON')
  }
}

const METRIC_LABELS = {
  advanced_model_request_limit: '高级模型请求',
  auto_completion_limit: '代码补全',
  basic_usage_limit: '基础用量',
  premium_model_fast_request_limit: '快速请求',
  premium_model_slow_request_limit: '慢速请求',
  credits_limit: '积分',
  bonus_usage_limit: '赠送额度',
  solo_agent_parallel_limit: '并发任务'
}

function metricLabel(key) {
  return METRIC_LABELS[key] || key.replace(/_limit$|_amount$/g, '')
}

function productTypeLabel(t) {
  const map = { 0: 'Free', 1: 'Pro', 4: 'Pro+', 6: 'Ultra', 100: 'CN Express' }
  return map[t] != null ? map[t] : '套餐'
}

/** 查询套餐 / 额度 */
async function fetchQuota(account) {
  const v = VARIANTS[account.platform]
  const accessToken = extractAccessToken(account)
  if (!accessToken) throw new Error('缺少 access_token，请重新导入账号')

  const ver = v.apiVersion
  const errors = []
  let pay = null
  let usage = null
  for (const origin of v.apiOrigins) {
    try {
      pay = await traePayRequest(origin + `/trae/api/${ver}/pay/ide_user_pay_status`, accessToken)
      break
    } catch (e) {
      errors.push(e.message)
    }
  }
  for (const origin of v.apiOrigins) {
    try {
      usage = await traePayRequest(origin + `/trae/api/${ver}/pay/ide_user_ent_usage`, accessToken)
      break
    } catch (e) {
      errors.push(e.message)
    }
  }
  if (!pay && !usage) {
    const uniq = [...new Set(errors)]
    throw new Error(uniq.length === 1 ? uniq[0] : '额度查询失败：' + uniq.join('；'))
  }

  const plan = pickString(pay || {}, ['user_pay_identity_str']) || account.plan || '未知'

  let summary = null
  const us = usage && usage.usage_summary
  if (us) {
    const total = num(us.total_amount)
    const used = num(us.consumed_amount) ?? 0
    if (total != null) {
      summary = { total, used, remaining: Math.max(0, total - used), unit: '积分' }
    }
  }

  const items = []
  const packs = (usage && usage.user_entitlement_pack_list) || []
  for (const pack of packs) {
    const base = pack.entitlement_base_info || {}
    const quota = base.quota || {}
    const usedMap = pack.usage || {}
    const metrics = []
    for (const [k, val] of Object.entries(quota)) {
      if (typeof val !== 'number' || val <= 0) continue
      if (k.startsWith('enable_') || k === 'no_bonus_quota') continue
      metrics.push({ label: metricLabel(k), limit: val, used: num(usedMap[k.replace(/_limit$/, '_amount')]) })
    }
    if (metrics.length === 0) {
      for (const [k, val] of Object.entries(usedMap)) {
        if (typeof val === 'number') metrics.push({ label: metricLabel(k), limit: null, used: val })
      }
    }
    const endTime = (num(base.end_time) || num(pack.expire_time) || 0) * 1000 || null
    items.push({
      label: pack.display_desc || productTypeLabel(base.product_type),
      endTime,
      metrics
    })
  }
  markExpiry(items)

  return { plan, summary, items, raw: { pay, usage } }
}

/** 签到接口和额度接口共用 Cloud-IDE-JWT 鉴权；这里用 Bearer 会被判成未登录（code 1001） */
function buildCheckinHeaders(account) {
  const accessToken = extractAccessToken(account)
  if (!accessToken) throw new Error('缺少 access_token，请重新导入账号')
  const deviceId = account.deviceId || ''
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://www.trae.cn',
    Referer: 'https://www.trae.cn/',
    'x-app-type': 'trae',
    Authorization: `Cloud-IDE-JWT ${accessToken}`
  }
  if (deviceId) headers['x-device-id'] = deviceId
  return { headers, deviceId }
}

/** 查询签到状态（仅国内版） */
async function checkinStatus(account) {
  const v = VARIANTS[account.platform]
  if (v.region !== 'cn') return { ok: false, supported: false, message: '国际版未提供签到接口' }
  const { headers, deviceId } = buildCheckinHeaders(account)
  const url =
    'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status' + (deviceId ? `?did=${encodeURIComponent(deviceId)}` : '')
  const res = await fetch(url, { headers })
  const text = await res.text()
  if (!res.ok) {
    return {
      ok: false,
      supported: true,
      loggedOut: res.status === 401,
      message: res.status === 401 ? LOGGED_OUT : `查询失败 HTTP ${res.status}`
    }
  }
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, supported: true, message: '响应格式异常' }
  }
  if (data.code !== 0) {
    return {
      ok: false,
      supported: true,
      loggedOut: data.code === 1001,
      message: data.code === 1001 ? LOGGED_OUT : data.message || `接口返回 code=${data.code}`
    }
  }
  const credits = num(data.credits) ?? 0
  return {
    ok: true,
    supported: true,
    checkedIn: Boolean(data.checked_in),
    credits,
    enable: Boolean(data.enable),
    message: !data.enable
      ? '当前账号未开启签到活动'
      : data.checked_in
        ? `今日已签到 · ${credits} 积分`
        : '今日未签到'
  }
}

/** 一键签到（仅国内版） */
async function checkin(account) {
  const status = await checkinStatus(account)
  if (!status.supported || !status.ok) return status
  if (status.checkedIn) return { ok: true, alreadyCheckedIn: true, message: status.message }

  const { headers } = buildCheckinHeaders(account)
  const res = await fetch('https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim', {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  })
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, loggedOut: res.status === 401, message: res.status === 401 ? LOGGED_OUT : `签到失败 HTTP ${res.status}` }
  }
  let claim = {}
  try {
    claim = JSON.parse(text)
  } catch {
    /* ignore */
  }
  if (claim.code !== 0 && claim.code !== undefined) {
    return {
      ok: false,
      loggedOut: claim.code === 1001,
      message: claim.code === 1001 ? LOGGED_OUT : claim.message || `签到失败 code=${claim.code}`
    }
  }
  return { ok: true, alreadyCheckedIn: false, message: `签到成功！${claim.message || ''}`.trim(), raw: claim }
}

module.exports = {
  VARIANTS,
  variants: Object.keys(VARIANTS),
  storagePath,
  readSnapshot,
  detectCurrent,
  toAccount,
  applyAccount,
  fetchQuota,
  checkin,
  checkinStatus,
  extractAccessToken,
  findExe
}
