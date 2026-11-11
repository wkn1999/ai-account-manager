'use strict'
// DuMate（百度搭子，dumate.cn）适配器
// 登录态：%APPDATA%\qianfan-desktop-app\auth.json（注意不是按产品名推出来的目录）
// cookies 用同目录下 .cookie-key 的 32 字节随机密钥做 AES-256-GCM 加密
// 与其它平台不同：DuMate 客户端原生支持多 profile，accountProfiles 就是账号池

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  appDataDir,
  localAppDataDir,
  exists,
  readJson,
  writeJsonAtomic,
  backupFile,
  isProcessRunning,
  killProcess,
  launchApp,
  sleep
} = require('../util/core')
const { markExpiry } = require('../util/quota')

const VARIANTS = {
  dumate: {
    id: 'dumate',
    label: 'DuMate 国内版',
    appDir: 'qianfan-desktop-app',
    exeNames: ['DuMate.exe'],
    region: 'cn',
    regionLabel: '国内',
    apiBase: 'https://console.bce.baidu.com',
    checkin: true,
    multiAccount: true
  }
}

// 每次签到固定 500 积分（接口只回传累计次数与累计积分，单价恒定）
const DAILY_CREDITS = 500
const API_ORIGIN = 'https://console.bce.baidu.com'
const HOSTNAME = 'console.bce.baidu.com'
const USER_AGENT = 'DuMate/1.0.0 ai-account-manager'

// 接口报登录失效时的统一文案：能做的只有回客户端重新登录
const LOGGED_OUT = '登录态已失效：请在 DuMate 客户端切换/重新登录该账号后点「检测本机账号」重新导入'

// ---------------- 路径 ----------------
function userDataDir(v) {
  return appDataDir(v.appDir)
}

function authFilePath(v) {
  return path.join(userDataDir(v), 'auth.json')
}

function cookieKeyPath(v) {
  return path.join(userDataDir(v), '.cookie-key')
}

/** 安装位置记录在 userData 下的 dumate-install.json，比按产品名猜 Program Files 可靠 */
function installJsonPath(v) {
  return path.join(userDataDir(v), 'dumate-install.json')
}

/**
 * .cookie-key 是 32 字节裸随机字节；个别版本可能写成 hex 文本，
 * 这里统一归一成 32 字节 Buffer，长度不对直接报错（宁可失败也不要拿错密钥去解）
 */
function loadCookieKey(keyPath) {
  const raw = fs.readFileSync(keyPath)
  if (raw.length === 32) return raw
  const text = raw.toString('utf8').trim()
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  if (/^[A-Za-z0-9+/=]{43,44}$/.test(text)) {
    const buf = Buffer.from(text, 'base64')
    if (buf.length === 32) return buf
  }
  if (raw.length > 32) return raw.subarray(0, 32)
  throw new Error('DuMate 密钥文件长度异常，无法解密本机登录态')
}

// ---------------- 加解密（只用 Node 内置 crypto） ----------------
/** 密文格式：base64( iv(12) || authTag(16) || ciphertext ) */
function decryptString(b64, key) {
  const buf = Buffer.from(String(b64 || ''), 'base64')
  if (buf.length <= 28) throw new Error('密文长度异常')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}

function encryptString(plain, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}

// ---------------- 账号识别 ----------------
function str(v) {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v)
  return null
}

function parseCookies(text) {
  const arr = JSON.parse(text)
  if (!Array.isArray(arr)) throw new Error('cookies 结构异常')
  return arr.filter((c) => c && typeof c.name === 'string')
}

/** profile → 归一化账号；解密失败返回 null，由调用方跳过而不是让整批失败 */
function profileToAccount(profile, ctx) {
  const v = ctx.variant
  const profileId = str(profile.profileId)
  if (!profileId) return null
  const cipher = profile.encryptedCookies || (profileId === ctx.activeProfileId ? ctx.rawCookies : null)
  if (!cipher) return null
  let cookies
  try {
    cookies = parseCookies(decryptString(cipher, ctx.key))
  } catch {
    return null
  }
  const uid = str(profile.bceUserId) || str(profile.bceAccountId) || profileId
  return {
    id: `dumate:${uid}`,
    platform: v.id,
    platformLabel: v.label,
    region: v.region,
    name: str(profile.displayName) || `DuMate 账号 ${String(uid).slice(0, 8)}`,
    email: null,
    uid,
    plan: null,
    isCurrent: profileId === ctx.activeProfileId,
    snapshot: {
      profileId,
      loginType: str(profile.loginType) || str(ctx.activeProviderType) || 'bce',
      bceUserId: str(profile.bceUserId),
      bceAccountId: str(profile.bceAccountId),
      displayName: str(profile.displayName),
      tenantName: str(profile.tenantName),
      enterpriseApiBaseUrl: str(profile.enterpriseApiBaseUrl) || str(ctx.enterpriseApiBaseUrl),
      vpcSvcUrl: str(profile.vpcSvcUrl) || str(ctx.vpcSvcUrl),
      cookies
    },
    updatedAt: toNum(profile.lastSuccessfulLoginAt) || toNum(profile.lastLogin) || Date.now()
  }
}

function readAuthState(v) {
  const authPath = authFilePath(v)
  if (!exists(authPath)) return null
  const auth = readJson(authPath)
  if (!auth || !Array.isArray(auth.accountProfiles)) return null
  const keyPath = cookieKeyPath(v)
  if (!exists(keyPath)) return null
  return { auth, authPath, keyPath, key: loadCookieKey(keyPath) }
}

/** 读取本机全部 profile（同步实现）；单个 profile 解密失败只跳过它 */
function readAccounts(variant) {
  const v = VARIANTS[variant || 'dumate']
  if (!v) return []
  const state = readAuthState(v)
  if (!state) return []
  const ctx = {
    variant: v,
    key: state.key,
    activeProfileId: str(state.auth.activeProfileId),
    activeProviderType: state.auth.activeProviderType,
    rawCookies: state.auth.cookies,
    enterpriseApiBaseUrl: state.auth.enterpriseApiBaseUrl,
    vpcSvcUrl: state.auth.vpcSvcUrl
  }
  const out = []
  for (const profile of state.auth.accountProfiles) {
    if (!profile) continue
    try {
      const acc = profileToAccount(profile, ctx)
      if (acc) out.push(acc)
    } catch {
      /* 单个 profile 损坏不影响其它账号导入 */
    }
  }
  return out
}

/** 对外统一成 Promise：注册表的 importAll / detectAll 都按异步接口调用 */
async function detectAccounts(variant) {
  return readAccounts(variant)
}

function detectCurrent(variant) {
  const list = readAccounts(variant)
  return list.find((a) => a.isCurrent) || null
}

// ---------------- 切号 ----------------
/**
 * 与官方 getProfileIdentity 同口径的身份键：
 * 客户端重建过账号池时 profileId 会变，但人还是同一个人，不能因此判定「账号不存在」。
 */
function profileIdentity(profile) {
  if (!profile) return null
  const userId = str(profile.bceUserId)
  if (!userId) return null
  if (str(profile.loginType) === 'enterprise') {
    const base = str(profile.enterpriseApiBaseUrl)
    return base ? `enterprise:${base}:${userId}` : null
  }
  const accountId = str(profile.bceAccountId)
  return accountId ? `bce:${accountId}:${userId}` : null
}

/**
 * 用快照重建 profile 所需的最小字段集。缺哪个就报哪个 ——
 * 用户拿着「已不存在该账号」这种一句话报错根本不知道下一步该做什么。
 * 企业版靠 enterpriseApiBaseUrl 认人并决定客户端连哪个网关，所以它替代 bceAccountId 参与校验。
 */
function missingProfileFields(snap) {
  const loginType = str(snap.loginType)
  const required = ['loginType', 'bceUserId', 'displayName']
  required.push(loginType === 'enterprise' ? 'enterpriseApiBaseUrl' : 'bceAccountId')
  return required.filter((k) => !str(snap[k]))
}

/**
 * 对齐官方 activateAccountProfile 的语义：
 * 关闭客户端 → 用当前密钥重新加密目标 profile 的 cookies → 改写 auth.json
 * 旧 active 的凭证要回写到它自己的 encryptedCookies，否则来回切两次后旧账号就只剩解不开的密文。
 *
 * 定位顺序：profileId → 身份键（bce / enterprise）→ 用快照重建 profile。
 * 顺序不能反：快照里的 profileId 也可能因为客户端重装而过期，但凭证本身仍然有效。
 */
async function applyAccount(account, opts = {}) {
  const v = VARIANTS[account && account.platform]
  if (!v) throw new Error('未知平台: ' + (account && account.platform))
  const snap = (account.snapshot || {})
  const profileId = str(snap.profileId)
  const cookies = Array.isArray(snap.cookies) ? snap.cookies : null
  if (!profileId) throw new Error('账号快照缺少 profileId，请在客户端重新登录后重新导入')
  if (!cookies || cookies.length === 0) throw new Error('账号快照缺少登录凭证，请在客户端重新登录后重新导入')

  const state = readAuthState(v)
  if (!state) throw new Error('未找到 DuMate 的本机登录数据（auth.json / .cookie-key），请先启动客户端登录一次')
  const { auth, authPath, key } = state
  const profiles = auth.accountProfiles.map((p) => ({ ...p }))

  const identityKey = profileIdentity(snap)
  let target = profiles.find((p) => p.profileId === profileId) || null
  let matchedBy = target ? 'profileId' : null
  if (!target && identityKey) {
    target = profiles.find((p) => profileIdentity(p) === identityKey) || null
    if (target) matchedBy = 'identity'
  }

  const now = Date.now()
  const loginType = str(snap.loginType) || (target && str(target.loginType)) || 'bce'
  let createProfile = false

  if (!target) {
    const missing = missingProfileFields(snap)
    if (missing.length > 0) {
      throw new Error(
        `账号池中不存在该账号（profileId=${profileId}${identityKey ? '，身份键 ' + identityKey : ''}），` +
          `且账号快照缺少 ${missing.join('、')}，无法在本机重建 profile：请在客户端重新登录后重新导入`
      )
    }
    // 快照字段齐全 = 我们手里就有完整凭证，本机账号池里没有只是被清过，按快照补回去
    target = {
      profileId,
      loginType,
      bceUserId: str(snap.bceUserId),
      bceAccountId: str(snap.bceAccountId),
      displayName: str(snap.displayName),
      lastLogin: now,
      lastSuccessfulLoginAt: toNum(snap.updatedAt) || now
    }
    if (str(snap.tenantName)) target.tenantName = str(snap.tenantName)
    if (str(snap.enterpriseApiBaseUrl)) target.enterpriseApiBaseUrl = str(snap.enterpriseApiBaseUrl)
    if (str(snap.vpcSvcUrl)) target.vpcSvcUrl = str(snap.vpcSvcUrl)
    profiles.push(target)
    createProfile = true
    matchedBy = 'rebuilt'
  }

  const running = v.exeNames.find((n) => isProcessRunning(n))
  if (running && opts.killRunning === false && opts.dryRun !== true) {
    throw new Error(`${v.label} 正在运行，请先关闭后再切换`)
  }

  const currentId = str(auth.activeProfileId)
  const prevActive = profiles.find((p) => p.profileId === currentId && p.profileId !== target.profileId)
  if (prevActive) {
    try {
      // 当前 active 的明文凭证就在 auth.cookies 里，用同一把密钥加密回去当它的备份
      prevActive.encryptedCookies = encryptString(decryptString(auth.cookies, key), key)
    } catch {
      /* 解不开就保留它原有的密文，不能因为备份失败阻断切号 */
    }
  }

  const targetProfileId = str(target.profileId)
  const encrypted = encryptString(JSON.stringify(cookies), key)
  target.encryptedCookies = encrypted
  target.lastLogin = now
  if (snap.loginType) target.loginType = loginType
  if (snap.displayName) target.displayName = snap.displayName
  if (snap.tenantName) target.tenantName = snap.tenantName

  const next = {
    ...auth,
    cookies: encrypted,
    activeProfileId: targetProfileId,
    activeProviderType: loginType,
    accountProfiles: profiles
  }
  // 企业版凭据只在 loginType 为 enterprise 时有效，残留会让客户端连错网关
  if (loginType === 'enterprise') {
    if (snap.enterpriseApiBaseUrl) next.enterpriseApiBaseUrl = snap.enterpriseApiBaseUrl
    if (snap.vpcSvcUrl) next.vpcSvcUrl = snap.vpcSvcUrl
  } else {
    delete next.enterpriseApiBaseUrl
    delete next.vpcSvcUrl
  }

  const willWrite = {
    activeProfileId: targetProfileId,
    activeProviderType: loginType,
    profileCount: profiles.length,
    // dryRun 也要能看出这次是「复用已有 profile」还是「按快照新建一个」
    createProfile,
    matchedBy,
    runningClient: Boolean(running)
  }

  // dryRun：只做计算与校验，不写盘不杀进程 —— 用来在真实切号前确认目标状态
  if (opts.dryRun === true) return { ok: true, dryRun: true, willWrite }

  if (running) {
    killProcess(running)
    await sleep(1500)
  }

  backupFile(authPath)
  writeJsonAtomic(authPath, next)

  const exe = findExe(v)
  const shouldLaunch = Boolean(exe) && opts.launch !== false
  if (shouldLaunch) launchApp(exe)
  return { ok: true, storagePath: authPath, launched: shouldLaunch, willWrite }
}

// ---------------- HTTP ----------------
function unquote(value) {
  const v = String(value == null ? '' : value).trim()
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    return v.slice(1, -1)
  }
  return v
}

/** Cookie 值里带分隔符或空格时必须整体加引号，否则服务端会把它截断 */
function quoteCookieValue(v) {
  return /[\s:;=|,]/.test(v) ? `"${v}"` : v
}

function domainMatches(domain, hostname) {
  const d = String(domain || '').replace(/^\./, '')
  if (!d) return true
  return hostname === d || hostname.endsWith('.' + d)
}

function accountCookies(account) {
  const snap = (account && account.snapshot) || {}
  return Array.isArray(snap.cookies) ? snap.cookies : []
}

function cookieHeader(cookies, hostname) {
  const parts = []
  for (const c of cookies) {
    if (!c || !c.name) continue
    if (!domainMatches(c.domain, hostname)) continue
    parts.push(`${c.name}=${quoteCookieValue(unquote(c.value))}`)
  }
  return parts.join('; ')
}

/** BCE 的 csrftoken 就是 bce-user-info 这个 cookie 的值（不带引号） */
function csrfToken(cookies) {
  const c = cookies.find((x) => x && x.name === 'bce-user-info')
  return c ? unquote(c.value) : ''
}

function loggedOutError() {
  const e = new Error(LOGGED_OUT)
  e.loggedOut = true
  return e
}

/** 统一请求：DuMate 的接口对请求头挑剔，缺 X-Requested-With / csrftoken 会被判成未登录 */
async function apiCall(account, apiPath, method = 'GET', body) {
  const cookies = accountCookies(account)
  if (cookies.length === 0) throw loggedOutError()
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Dumate-Client-Type': 'desktop',
    Origin: API_ORIGIN,
    Referer: API_ORIGIN + '/',
    Cookie: cookieHeader(cookies, HOSTNAME),
    'User-Agent': USER_AGENT
  }
  const token = csrfToken(cookies)
  if (token) headers.csrftoken = token

  const res = await fetch(API_ORIGIN + apiPath, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body === undefined ? {} : body)
  })
  const text = await res.text()
  return { status: res.status, ok: res.ok, text }
}

function parseBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------- 额度 ----------------
const PACKAGE_LABELS = {
  plan_free: 'Free',
  plan_pro: 'Pro',
  plan_plus: 'Plus',
  plan_max: 'Max',
  plan_ultra: 'Ultra'
}
const PACKAGE_RANK = { plan_free: 0, plan_pro: 1, plan_plus: 2, plan_max: 3, plan_ultra: 4 }

function packageLabel(type) {
  return PACKAGE_LABELS[type] || type || '积分包'
}

/** 查询积分额度：只统计 status === 'active' 的积分包 */
async function fetchQuota(account) {
  const v = VARIANTS[account.platform]
  if (!v) throw new Error('未知平台: ' + account.platform)
  const res = await apiCall(account, '/api/dumate/points/package/list', 'GET')
  if (res.status === 401 || res.status === 403) throw loggedOutError()
  if (!res.ok) throw new Error(`额度查询失败 HTTP ${res.status}`)
  const data = parseBody(res.text)
  if (!data) throw new Error('额度查询失败：响应非 JSON')
  if (data.code !== 0 && data.code != null) {
    throw new Error(`额度查询失败 code=${data.code}${data.message ? ': ' + data.message : ''}`)
  }

  const result = data.result || {}
  const packages = (Array.isArray(result.packages) ? result.packages : []).filter(
    (p) => p && String(p.status || '').toLowerCase() === 'active'
  )

  const items = []
  let total = 0
  let used = 0
  let plan = null
  let bestRank = -1
  for (const p of packages) {
    const totalPoints = toNum(p.totalPoints) ?? 0
    const usedPoints = toNum(p.usedPoints) ?? 0
    total += totalPoints
    used += usedPoints
    const rank = PACKAGE_RANK[p.packageType] != null ? PACKAGE_RANK[p.packageType] : 0
    if (rank > bestRank) {
      bestRank = rank
      plan = packageLabel(p.packageType)
    }
    const expire = toNum(p.expireDate)
    const remainingPoints = Math.max(0, totalPoints - usedPoints)
    items.push({
      label: packageLabel(p.packageType),
      // 接口给的是秒级时间戳
      endTime: expire && expire > 0 ? expire * 1000 : null,
      // 字段按字面语义填：used=已用、remaining=剩余。
      // 这张卡的主指标是「剩余」，由 showRemaining 显式告诉渲染层取哪个字段 ——
      // 否则后来人拿 used 去算百分比会算反（used 里装的其实是剩余量）。
      metrics: [
        {
          label: '剩余 / 总量',
          limit: totalPoints,
          used: usedPoints,
          remaining: remainingPoints,
          showRemaining: true
        }
      ]
    })
  }
  markExpiry(items)

  let summary = null
  let message = null
  if (packages.length === 0 || total <= 0) {
    message = '该账号暂无可用积分包'
  } else {
    summary = { total, used, remaining: Math.max(0, total - used), unit: '积分' }
  }

  return { plan, summary, items, message, raw: data }
}

// ---------------- 签到 ----------------
const pad2 = (n) => String(n).padStart(2, '0')

function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * 连续签到天数：从 signInDays 以今天为终点往前数连续自然日。
 * 今天还没签时以昨天为起点 —— 否则「今天还没签」会把昨天及之前的连续记录全清零。
 */
function streakFromDays(days, now = new Date()) {
  const set = new Set((Array.isArray(days) ? days : []).map((x) => String(x)))
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!set.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let n = 0
  while (set.has(dayKey(cursor)) && n < 3660) {
    n++
    cursor.setDate(cursor.getDate() - 1)
  }
  return n
}

/** 今日签到状态 */
async function checkinStatus(account) {
  let res
  try {
    res = await apiCall(account, '/api/dumate/points/loginBonusInfo', 'GET')
  } catch (e) {
    return { ok: false, supported: true, loggedOut: Boolean(e.loggedOut), message: e.message }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, supported: true, loggedOut: true, message: LOGGED_OUT }
  }
  if (!res.ok) {
    return { ok: false, supported: true, message: `签到状态查询失败 HTTP ${res.status}` }
  }
  const data = parseBody(res.text)
  if (!data) return { ok: false, supported: true, message: '签到状态响应格式异常' }
  if (data.code !== 0 && data.code != null) {
    return {
      ok: false,
      supported: true,
      message: `签到状态查询失败 code=${data.code}${data.message ? ': ' + data.message : ''}`
    }
  }
  const result = data.result || {}
  const checkedIn = Boolean(result.hasIssued)
  const streakDays = streakFromDays(result.signInDays)
  const totalTimes = toNum(result.totalTimes) ?? 0
  const totalCredits = toNum(result.totalPoints) ?? 0
  return {
    ok: true,
    supported: true,
    checkedIn,
    streakDays,
    credits: DAILY_CREDITS,
    totalCredits,
    totalTimes,
    message: checkedIn
      ? `今日已签到 · 累计 ${totalTimes} 次 / ${totalCredits} 积分`
      : '今日未签到'
  }
}

/** 领取每日签到积分 */
async function checkin(account) {
  const status = await checkinStatus(account)
  if (!status.ok) return status
  if (status.checkedIn) return { ok: true, alreadyCheckedIn: true, message: status.message }

  const res = await apiCall(account, '/api/dumate/points/loginBonus', 'POST', {})
  const loggedOut = res.status === 401 || res.status === 403
  if (loggedOut) return { ok: false, loggedOut: true, message: LOGGED_OUT }
  if (!res.ok) return { ok: false, loggedOut: false, message: `签到失败 HTTP ${res.status}` }
  const data = parseBody(res.text)
  if (!data) return { ok: false, loggedOut: false, message: '签到失败：响应格式异常' }
  if (data.code !== 0 && data.code != null) {
    return {
      ok: false,
      loggedOut: false,
      message: `签到失败 code=${data.code}${data.message ? ': ' + data.message : ''}`
    }
  }
  if (data.result === false) {
    return { ok: false, loggedOut: false, message: '领取失败：接口返回 false，可能今日已领取' }
  }

  // 领完再查一次，用服务端累计值报数，避免本地估算和实际对不上
  const after = await checkinStatus(account).catch(() => null)
  const times = after && after.ok ? after.totalTimes : (status.totalTimes || 0) + 1
  const credits = after && after.ok ? after.totalCredits : (status.totalCredits || 0) + DAILY_CREDITS
  return {
    ok: true,
    alreadyCheckedIn: false,
    message: `签到成功 · 获得 ${DAILY_CREDITS} 积分（累计 ${times} 次 / ${credits} 积分）`
  }
}

// ---------------- 可执行文件 ----------------
function findExe(v) {
  const target = v || VARIANTS.dumate
  const install = readJson(installJsonPath(target))
  const dir = install && typeof install.install_dir === 'string' ? install.install_dir : null
  const candidates = []
  if (dir) for (const name of target.exeNames) candidates.push(path.join(dir, name))
  for (const name of target.exeNames) {
    candidates.push(localAppDataDir('Programs', 'DuMate', name))
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'DuMate', name))
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'DuMate', name))
  }
  return candidates.find((p) => exists(p)) || null
}

module.exports = {
  VARIANTS,
  variants: Object.keys(VARIANTS),
  authFilePath,
  cookieKeyPath,
  decryptString,
  encryptString,
  readAccounts,
  detectAccounts,
  detectCurrent,
  profileIdentity,
  applyAccount,
  fetchQuota,
  checkin,
  checkinStatus,
  findExe
}
