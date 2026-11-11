'use strict'
// Qoder（国际 / 国内）适配器
// 登录态：%APPDATA%\<com.qoder.app.stable|com.qodercn.app.stable>\auth.v1.dat
// 使用 Chromium safeStorage（DPAPI + AES-256-GCM v10）加密

const fs = require('fs')
const path = require('path')
const { appDataDir, localAppDataDir, exists, backupFile, isProcessRunning, killProcess, launchApp, sleep } = require('../util/core')
const { loadMasterKey, decryptV10, encryptV10 } = require('../util/vscodeSafeStorage')
const { markExpiry } = require('../util/quota')

const VARIANTS = {
  qoder: {
    id: 'qoder',
    label: 'Qoder 国际版',
    appDir: 'com.qoder.app.stable',
    exeNames: ['Qoder.exe'],
    region: 'international',
    openapi: 'https://openapi.qoder.sh',
    usagePath: '/sash/api/v2/me/usage',
    planPath: '/api/v2/user/plan',
    // 国际版签到端点（openapi.qoder.sh）未验证，本机国际版 token 实测 401，暂不启用签到
    checkin: false
  },
  'qoder-cn': {
    id: 'qoder-cn',
    label: 'Qoder 国内版',
    appDir: 'com.qodercn.app.stable',
    exeNames: ['Qoder CN.exe', 'Qoder.exe'],
    region: 'cn',
    openapi: 'https://openapi.qoder.com.cn',
    usagePath: '/sash/api/v2/me/usage',
    planPath: '/api/v2/user/plan',
    localProgramDirs: ['Qoder CN', 'Qoder'],
    // 服务端按自然日投放活动，常见「签到 + 登录奖励」双活动，必须遍历所有 campaigns
    checkin: true,
    checkinNote: '每日双活动，按服务端投放'
  }
}

function dataDir(v) {
  return appDataDir(v.appDir)
}
function authFilePath(v) {
  return path.join(dataDir(v), 'auth.v1.dat')
}
function localStatePath(v) {
  return path.join(dataDir(v), 'Local State')
}

function findExe(v) {
  const dirs = v.localProgramDirs || ['Qoder']
  const roots = [
    localAppDataDir('Programs'),
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  ]
  for (const d of dirs) {
    for (const root of roots) {
      for (const name of v.exeNames) {
        const p = path.join(root, d, name)
        if (exists(p)) return p
      }
    }
  }
  return null
}

/** 读取并解密本机登录态 */
function readSnapshot(variant) {
  const v = VARIANTS[variant]
  if (!v) return null
  const authPath = authFilePath(v)
  if (!exists(authPath)) return null
  let masterKey
  try {
    masterKey = loadMasterKey(localStatePath(v))
  } catch {
    return null
  }
  let json
  try {
    json = JSON.parse(decryptV10(masterKey, fs.readFileSync(authPath)).toString('utf8'))
  } catch {
    return null
  }
  return { variant, user: json.user || {}, token: json.token, refreshToken: json.refreshToken, raw: json }
}

function toAccount(snap) {
  const v = VARIANTS[snap.variant]
  const user = snap.user || {}
  const idKey = user.id || user.email || user.name || 'unknown'
  return {
    id: `${snap.variant}:${String(idKey).replace(/[^\w.@-]/g, '_')}`,
    platform: snap.variant,
    platformLabel: v.label,
    region: v.region,
    name: user.name || user.email || String(idKey),
    email: user.email || null,
    uid: user.id || null,
    avatarUrl: user.avatarUrl || null,
    plan: null,
    snapshot: { session: snap.raw },
    updatedAt: Date.now()
  }
}

function detectCurrent(variant) {
  const snap = readSnapshot(variant)
  return snap ? toAccount(snap) : null
}

/** 切换：关闭客户端 → 用本机主密钥重写 auth.v1.dat → 启动 */
async function applyAccount(account, opts = {}) {
  const v = VARIANTS[account.platform]
  if (!v) throw new Error('未知平台: ' + account.platform)
  const running = v.exeNames.find((n) => isProcessRunning(n))
  if (running) {
    if (opts.killRunning === false) throw new Error(`${v.label} 正在运行，请先关闭后再切换`)
    killProcess(running)
    await sleep(1500)
  }
  const masterKey = loadMasterKey(localStatePath(v))
  const buf = encryptV10(masterKey, Buffer.from(JSON.stringify(account.snapshot.session), 'utf8'))
  const target = authFilePath(v)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  backupFile(target)
  fs.writeFileSync(target, buf)

  const exe = findExe(v)
  const shouldLaunch = Boolean(exe) && opts.launch !== false
  if (shouldLaunch) launchApp(exe)
  return { ok: true, storagePath: target, launched: shouldLaunch }
}

function sessionToken(account) {
  return (account.snapshot && account.snapshot.session && account.snapshot.session.token) || null
}

/** Qoder 的 token 由客户端自己续期，我们只能读到当下这一份，过期只能重登 */
const LOGGED_OUT = '登录态已失效：请在 Qoder 客户端重新登录后点「检测本机账号」重新导入'

/** 查询额度 */
async function fetchQuota(account) {
  const v = VARIANTS[account.platform]
  const token = sessionToken(account)
  if (!token) throw new Error('缺少 token，请重新导入账号')
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }

  const res = await fetch(v.openapi + v.usagePath, { headers })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(LOGGED_OUT)
      e.loggedOut = true
      throw e
    }
    throw new Error(`额度查询失败 HTTP ${res.status}`)
  }
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('响应非 JSON')
  }

  let plan = null
  try {
    const pr = await fetch(v.openapi + v.planPath, { headers })
    if (pr.ok) {
      const pj = await pr.json()
      plan = pj.plan_tier_name || pj.user_type || null
    }
  } catch {
    /* 套餐查询失败不影响额度展示 */
  }

  const toNum = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x && !isNaN(Number(x)) ? Number(x) : null)
  const root = data.data || data
  const usage = root.qoderUsage || root

  /** 一份额度对象 → 汇总额度；total 为 0 说明这一层没有可显示的额度 */
  const quotaOf = (o) => {
    const total = toNum(o && o.total)
    if (total == null || total <= 0) return null
    const used = toNum(o.used) ?? 0
    const remaining = toNum(o.remaining) ?? Math.max(0, total - used)
    return { total, used, remaining, unit: o.unit || 'Credits' }
  }

  // 套餐额度 + 加量包合并成汇总；两项都有时不能只挑一项，否则剩余量会少算
  const planQuota = quotaOf(usage.userQuota)
  const addOnQuota = quotaOf(usage.addOnQuota)
  let summary = planQuota || addOnQuota
  if (planQuota && addOnQuota) {
    summary = {
      total: planQuota.total + addOnQuota.total,
      used: planQuota.used + addOnQuota.used,
      remaining: planQuota.remaining + addOnQuota.remaining,
      unit: planQuota.unit || addOnQuota.unit
    }
  }
  let message = null
  if (!summary) {
    // 套餐与加量包都为 0 时接口只给百分比。额度已耗尽却显示 0% 会被读成「还有满额度」
    const percent = toNum(usage.totalUsagePercentage)
    const exhausted = Boolean(usage.isQuotaExceeded)
    summary = { total: 0, used: 0, remaining: 0, unit: 'Credits', percent: exhausted ? 100 : (percent ?? 0) }
    message = exhausted ? '无可用 Credits：套餐额度为 0 或已用尽' : '接口未返回总额度，仅有用量百分比'
  }

  const items = []
  if (planQuota) {
    items.push({
      label: '套餐额度',
      endTime: null,
      metrics: [{ label: '已用', limit: planQuota.total, used: planQuota.used }]
    })
  }
  if (addOnQuota) {
    items.push({
      label: '加量包',
      endTime: null,
      metrics: [{ label: '已用', limit: addOnQuota.total, used: addOnQuota.used }]
    })
  }
  for (const p of usage.dedicatedResourcePackages || []) {
    const total = toNum(p.total)
    items.push({
      label: p.name || p.description || '资源包',
      endTime: p.expiresAt,
      metrics: total ? [{ label: '已用', limit: total, used: toNum(p.used) }] : []
    })
  }
  const enterprise = (root.enterpriseUsage && root.enterpriseUsage.userQuota) || null
  if (enterprise) {
    const et = toNum(enterprise.total)
    if (et != null && et > 0) {
      items.push({
        label: '企业额度',
        endTime: null,
        metrics: [{ label: '已用', limit: et, used: toNum(enterprise.used) }]
      })
    }
  }
  markExpiry(items)

  return { plan, summary, items, message, blocked: Boolean(usage.isQuotaExceeded), raw: data }
}

// ---------------- 签到：Qoder CN / sash campaigns ----------------
// 之前判「Qoder 没有签到接口」是误判：GET campaigns 只带 Authorization + Accept 时，
// 服务端会回 HTTP 200 + 空 campaigns（showCampaign:false），看起来像「没有活动」，
// 其实是缺 Cosy-ClientType: 10 这一族客户端头。反过来领取端点带完整设备指纹头
// 会被上游风控拦成 503，必须用最小头 + 空 body。
// 活动按自然日投放，同一天可能有「签到 + 登录奖励」两条，必须逐条遍历，不能假设只有一条。
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
const CLAIM_PATH_PREFIX = '/sash/api/v1/me/campaigns/'
const CLAIM_PATH_SUFFIX = '/claim'
// campaignId 要拼进 URL path，先做白名单校验，畸形值直接拒绝该条，避免打出畸形请求
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]+$/

/** 活动列表请求头：Cosy-ClientType: 10 缺一不可，缺了只会拿到「假空列表」 */
function campaignsHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
    'Cosy-Version': '0.4.3',
    'Cosy-MachineOS': 'x86_64_win32',
    Accept: 'application/json'
  }
}

/** 领取请求头必须最小化：完整设备指纹头族会触发上游风控 503 RISK_DEPENDENCY_UNAVAILABLE */
function claimHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
    'Content-Type': 'application/json'
  }
}

function loggedOutError() {
  const e = new Error(LOGGED_OUT)
  e.loggedOut = true
  return e
}

/** 兜底消毒：任何对外文案都不能带出 token 原文，并截断避免整段响应体外泄 */
function redact(text, token) {
  const raw = String(text == null ? '' : text)
  const safe = token ? raw.split(String(token)).join('[已隐藏]') : raw
  return safe.slice(0, 200)
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 只回传 HTTP 状态码与业务 code/message，绝不回显完整响应体（可能含 uid） */
function httpFailure(prefix, res, body, token) {
  const code = body && body.code != null ? redact(body.code, token) : ''
  const msg = body && body.message ? redact(body.message, token) : ''
  let text = `${prefix} HTTP ${res.status}`
  if (code) text += ` code=${code}`
  if (msg) text += `: ${msg}`
  return new Error(text)
}

function toAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value)
  return 0
}

/**
 * 拉取活动列表。401/403 抛带 loggedOut 标记的错误，其余失败抛普通错误。
 * 只把归一化后的结构交出去，绝不返回响应原文。
 */
async function fetchCampaigns(account) {
  const v = VARIANTS[account && account.platform]
  if (!v) throw new Error('未知平台: ' + (account && account.platform))
  if (v.checkin !== true) throw new Error(`${v.label} 未启用签到`)
  const token = sessionToken(account)
  if (!token) throw loggedOutError()

  let res
  try {
    res = await fetch(v.openapi + CAMPAIGNS_PATH, { headers: campaignsHeaders(token) })
  } catch (e) {
    throw new Error(`活动列表请求失败：${redact(e && e.message, token)}`)
  }
  const text = await res.text().catch(() => '')
  const body = parseJsonObject(text)
  if (res.status === 401 || res.status === 403) throw loggedOutError()
  if (!res.ok) throw httpFailure('活动列表查询失败', res, body, token)
  if (!body) throw new Error('活动列表响应非 JSON')
  return {
    showCampaign: Boolean(body.showCampaign),
    claimable: Boolean(body.claimable),
    campaigns: Array.isArray(body.campaigns) ? body.campaigns : []
  }
}

function normalizeCampaign(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const campaignId = typeof c.campaignId === 'string' ? c.campaignId : ''
  const benefit = c.benefit && typeof c.benefit === 'object' ? c.benefit : {}
  return {
    campaignId,
    campaignKey: typeof c.campaignKey === 'string' ? c.campaignKey : '',
    actionType: typeof c.actionType === 'string' ? c.actionType : '',
    // 大小写宽容：服务端给 CLAIMABLE / CLAIMED，别把未来变体漏判
    status: String(c.claimStatus == null ? '' : c.claimStatus).trim().toUpperCase(),
    amount: Math.max(0, toAmount(benefit.amount)),
    validId: CAMPAIGN_ID_RE.test(campaignId)
  }
}

/**
 * 汇总成对外状态 + 可领明细。
 * Qoder 没有「连续签到天数」概念，streakDays 恒为 0；totalTimes 用今日已领取项数代替。
 * credits 是本次待领可得、totalCredits 是今日全部活动投放总额，均来自 benefit.amount。
 */
function summarizeCampaigns(campaigns) {
  const items = (Array.isArray(campaigns) ? campaigns : []).map(normalizeCampaign)
  const total = items.length
  const claimable = items.filter((x) => x.status === 'CLAIMABLE')
  const claimed = items.filter((x) => x.status === 'CLAIMED')
  const noCampaign = total === 0
  // 空列表时也置 true：否则卡片会一直显示「待签到」按钮，用户反复空点、定时任务反复触发
  const checkedIn = noCampaign ? true : claimable.length === 0
  const credits = claimable.reduce((sum, x) => sum + x.amount, 0)
  const totalCredits = items.reduce((sum, x) => sum + x.amount, 0)
  let message
  if (noCampaign) {
    message = '当前账号暂无可领取活动（活动未开始或已结束）'
  } else if (claimable.length > 0) {
    message = `今日有 ${claimable.length} 项待领活动`
  } else if (claimed.length === total) {
    message = `今日 ${total} 项活动已全部领取`
  } else {
    message = `今日 ${total} 项活动中 ${claimed.length} 项已领取，其余无需领取`
  }
  return {
    status: {
      ok: true,
      supported: true,
      checkedIn,
      noCampaign,
      streakDays: 0,
      credits,
      totalCredits,
      totalTimes: claimed.length,
      message
    },
    claimable
  }
}

/** checkinStatus / checkin 共用同一次 GET，避免两次请求之间活动状态漂移 */
async function readCheckinState(account) {
  const { campaigns } = await fetchCampaigns(account)
  return summarizeCampaigns(campaigns)
}

/**
 * 今日签到状态，契约与 dumate.checkinStatus 完全对齐，供 scheduler.refreshCheckins 解析。
 * 401/403 时返回带 loggedOut:true 的结果对象而不是抛错：注册表 checkinStatus 有 try/catch，
 * 抛出去会把 loggedOut 标记吞掉，scheduler.checkinStatusWithHeal 就永远不会自愈。
 */
async function checkinStatus(account) {
  try {
    const state = await readCheckinState(account)
    return state.status
  } catch (e) {
    const err = e || {}
    return {
      ok: false,
      supported: true,
      checkedIn: false,
      noCampaign: false,
      streakDays: 0,
      credits: 0,
      totalCredits: 0,
      totalTimes: 0,
      loggedOut: Boolean(err.loggedOut),
      message: redact(err.message, sessionToken(account || {}))
    }
  }
}

/** 领取响应把 status / replayed / code / message 可能放在顶层或 data 下，统一取出 */
function claimResultOf(body) {
  const data = body.data && typeof body.data === 'object' ? body.data : null
  const pick = (key) => (body[key] != null ? body[key] : data ? data[key] : null)
  const status = pick('status')
  const replayed = pick('replayed')
  return {
    status: String(status == null ? '' : status).trim().toUpperCase(),
    replayed: replayed === true || replayed === 'true',
    code: pick('code'),
    message: pick('message')
  }
}

/**
 * 网络异常后的幂等复查：重新 GET 列表看该 campaignId 是否已变 CLAIMED。
 * GET 无副作用，用它确认「POST 其实成功了」，绝不盲目重发 POST。
 */
async function recheckClaimed(account, campaignId) {
  try {
    const { campaigns } = await fetchCampaigns(account)
    const hit = campaigns.find((c) => c && c.campaignId === campaignId) || null
    const status = String((hit && hit.claimStatus) || '').trim().toUpperCase()
    return status === 'CLAIMED' ? 'claimed' : 'pending'
  } catch {
    return 'error'
  }
}

/**
 * 领取单条活动，返回 kind: success / already / failure。
 * POST 必须空 body：写 '{}' 会让上游按有参请求处理（参考实现实测会失败）；
 * 服务端重复领取是幂等的（status:CLAIMED + replayed:true），无副作用。
 */
async function claimOne(account, campaign, token) {
  if (!campaign.validId) {
    return { kind: 'failure', message: '活动 ID 非法，已拒绝该条', credits: 0 }
  }
  const v = VARIANTS[account.platform]
  const url = `${v.openapi}${CLAIM_PATH_PREFIX}${campaign.campaignId}${CLAIM_PATH_SUFFIX}`
  let res
  try {
    // 不写 body，Node fetch 会发 Content-Length: 0，这正是领取端点要求的
    res = await fetch(url, { method: 'POST', headers: claimHeaders(token) })
  } catch (e) {
    const check = await recheckClaimed(account, campaign.campaignId)
    if (check === 'claimed') {
      return { kind: 'already', message: '网络异常，复查确认该活动已领取', credits: 0 }
    }
    const suffix = check === 'error' ? '（复查也失败）' : '（复查显示仍未领取）'
    return { kind: 'failure', message: `领取请求失败${suffix}：${redact(e && e.message, token)}`, credits: 0 }
  }
  const text = await res.text().catch(() => '')
  const body = parseJsonObject(text)
  if (res.status === 401 || res.status === 403) {
    return { kind: 'failure', loggedOut: true, message: LOGGED_OUT, credits: 0 }
  }
  if (!res.ok) {
    return { kind: 'failure', message: httpFailure('领取失败', res, body, token).message, credits: 0 }
  }
  if (!body) {
    return { kind: 'failure', message: '领取失败：响应非 JSON', credits: 0 }
  }
  const result = claimResultOf(body)
  // HTTP 200 也可能是风控拦截，BLOCKED 必须明确报错，不能当成功
  if (result.status === 'BLOCKED') {
    return { kind: 'failure', message: '领取被风控拦截（BLOCKED），请稍后在客户端重试', credits: 0 }
  }
  if (result.replayed) {
    return { kind: 'already', message: '该活动此前已领取（幂等重放）', credits: 0 }
  }
  if (result.status === 'CLAIMED') {
    return { kind: 'success', message: '领取成功', credits: campaign.amount }
  }
  const detail = [
    result.status ? `status=${result.status}` : '',
    result.code != null ? `code=${redact(result.code, token)}` : '',
    result.message ? redact(result.message, token) : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { kind: 'failure', message: `领取未成功${detail ? '：' + detail : ''}`, credits: 0 }
}

/** 多活动逐条领取之间加 1~2 秒随机抖动，避免被判成脚本连发触发风控 */
function jitterMs() {
  return 1000 + Math.floor(Math.random() * 1000)
}

/** 领完再查一次状态，用服务端最新文案收尾；失败不影响已经成功的领取结论 */
async function latestStatus(account) {
  try {
    return await checkinStatus(account)
  } catch {
    return null
  }
}

async function performCheckin(account) {
  // 先查状态（与 checkinStatus 同一口径、同一份 GET 结果），无可领时绝不发 POST
  const state = await readCheckinState(account)
  const targets = state.claimable
  if (targets.length === 0) {
    const message = state.status.noCampaign
      ? '今日无可领取活动（活动未开始或已结束）'
      : `今日无可领取活动 · ${state.status.message}`
    return { ok: true, alreadyCheckedIn: true, message }
  }

  const token = sessionToken(account)
  if (!token) {
    return { ok: false, loggedOut: true, message: LOGGED_OUT }
  }

  const outcomes = []
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(jitterMs())
    outcomes.push(await claimOne(account, targets[i], token))
  }

  const success = outcomes.filter((r) => r.kind === 'success')
  const failures = outcomes.filter((r) => r.kind === 'failure')
  const already = outcomes.filter((r) => r.kind === 'already')

  // 归并口径：任一成功 → 成功；否则任一失败 → 失败；否则已领
  if (success.length > 0) {
    const credits = success.reduce((sum, r) => sum + r.credits, 0)
    const after = await latestStatus(account)
    // 部分活动不返回 benefit.amount（本机「首次订阅福利」就是），此时别报「获得 0 Credits」误导用户
    let message =
      credits > 0
        ? `签到成功 · 领取 ${success.length} 项活动 / 获得 ${credits} Credits`
        : `签到成功 · 领取 ${success.length} 项活动（该活动未返回 Credits 数额）`
    if (failures.length > 0) message += `（另有 ${failures.length} 项未成功）`
    // 复查只用来决定是否追加提醒：服务端可能短暂仍报可领，直接拼它的原文会和「领取成功」自相矛盾
    if (after && after.ok && after.checkedIn === false && after.noCampaign !== true) {
      message += ' · 复查仍有待领活动，请稍后刷新'
    }
    return { ok: true, alreadyCheckedIn: false, message, credits }
  }
  if (failures.length > 0) {
    return {
      ok: false,
      loggedOut: failures.some((r) => r.loggedOut),
      message: failures.map((r) => r.message).join('；').slice(0, 300)
    }
  }
  return {
    ok: true,
    alreadyCheckedIn: true,
    message: `今日 ${already.length} 项活动此前均已领取`
  }
}

/** checkin 不抛错：任何异常都收敛成结构化结果，scheduler 才能按 loggedOut 自愈 */
async function checkin(account) {
  try {
    return await performCheckin(account)
  } catch (e) {
    const err = e || {}
    return {
      ok: false,
      loggedOut: Boolean(err.loggedOut),
      message: redact(err.message, sessionToken(account || {}))
    }
  }
}

module.exports = {
  VARIANTS,
  variants: Object.keys(VARIANTS),
  authFilePath,
  localStatePath,
  readSnapshot,
  detectCurrent,
  applyAccount,
  fetchQuota,
  checkin,
  checkinStatus,
  findExe,
  // 只读探针复用生产代码的端点与请求头，避免探针自己抄一份跑偏
  CAMPAIGNS_PATH,
  campaignsHeaders,
  claimHeaders
}
