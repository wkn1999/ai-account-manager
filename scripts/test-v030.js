#!/usr/bin/env node
'use strict'
/**
 * AI账号管家 v0.3.0 —— QA 独立验证脚本（任务 #4）
 *
 * 编写原则：不复用工程师的探针结论，独立复现关键事实；只新建/修改本文件，不改任何源码。
 * 依赖：仅 Node 内置模块 + 项目已有的 sql.js（通过项目模块间接加载），无新增依赖。
 *
 * 硬护栏（违反即整轮失败 / 作废）：
 *   1. 全程 0 次真实 POST 到任何 /claim 端点；0 次真实领取（qoder.checkin 仅在受控 stub 下调用）
 *   2. 全程 0 次真实切号（platforms.switchAccount / qoder.applyAccount 已被哨兵拦截）
 *   3. 跑前/跑后对本机 main.sqlite / state.vscdb / auth.json / .cookie-key / 桌面 .lnk 取 sha256 比对
 *   4. 跑前/跑后对 12 个关键源码文件取 sha256 比对，不一致则整轮作废（避免并发改动假绿）
 *   5. 所有 fs 写目标不得落在客户端数据目录 / 用户桌面
 *   6. 日志不输出 token / cookie / 密钥 / 完整响应体 / 会话正文 / 智能体 prompt 内容
 *
 * 用法：node scripts/test-v030.js
 * 退出码：0 全通过 / 1 有失败或护栏拦截
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const Module = require('module')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const HOME = os.homedir()
const NODE = process.execPath

// ---------------------------------------------------------------- 基础工具

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function sha256IfExists(file) {
  try {
    return fs.existsSync(file) ? sha256(file) : null
  } catch {
    return null
  }
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function listJsRecursively(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listJsRecursively(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
function shortHash(h) {
  return h ? h.slice(0, 12) + '…' : '(不存在)'
}

// ---------------------------------------------------------------- 断言框架

const results = []

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
async function test(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note || '', ms: Date.now() - t0 })
    console.log(`[PASS] ${name}${note ? ' → ' + note : ''}`)
  } catch (e) {
    const msg = (e && e.message) || String(e)
    results.push({ name, ok: false, note: msg, ms: Date.now() - t0 })
    console.log(`[FAIL] ${name} → ${msg}`)
  }
}

// ---------------------------------------------------------------- 护栏：网络

const netLog = []           // 主进程真实发出的请求
let nonGetCount = 0         // 主进程真实非 GET 请求数
let stubFetch = null        // 受控 stub（checkin 无 POST 用例专用）
let stubPostCount = 0       // stub 期间出现的 POST 尝试（必须为 0）
const realFetch = globalThis.fetch

globalThis.fetch = function guardedFetch(input, init) {
  if (stubFetch) return stubFetch(input, init)
  const url = typeof input === 'string' ? input : (input && input.url) || String(input)
  const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
  netLog.push({ method, url })
  if (method !== 'GET' && method !== 'HEAD') nonGetCount++
  return realFetch(input, init)
}

function urlPath(url) {
  try {
    return new URL(url).pathname
  } catch {
    return String(url).split('?')[0]
  }
}

// ---------------------------------------------------------------- 护栏：写盘目标

const writeLog = []
const PROTECTED_ROOTS = [
  path.join(ROAMING, 'com.qodercn.app.stable'),
  path.join(ROAMING, 'com.qoder.app.stable'),
  path.join(ROAMING, 'Trae CN'),
  path.join(ROAMING, 'Trae'),
  path.join(ROAMING, 'qianfan-desktop-app'),
  path.join(HOME, '.codex'),
  path.join(HOME, 'Desktop')
].map((p) => path.resolve(p).toLowerCase())

const WRITE_FNS = [
  'writeFileSync', 'appendFileSync', 'createWriteStream', 'mkdirSync', 'renameSync',
  'copyFileSync', 'unlinkSync', 'truncateSync', 'writevSync', 'writeFile',
  'appendFile', 'mkdir', 'rename', 'copyFile', 'unlink', 'truncate'
]
for (const name of WRITE_FNS) {
  const original = fs[name]
  if (typeof original !== 'function') continue
  try {
    fs[name] = function guardedWrite(...args) {
      for (const a of args.slice(0, 2)) {
        if (typeof a === 'string' || Buffer.isBuffer(a)) {
          if (typeof a === 'string') writeLog.push({ fn: name, target: a })
        }
      }
      return original.apply(fs, args)
    }
  } catch {
    /* 个别只读属性无法改写，跳过；sha256 前后比对仍会兜底 */
  }
}
if (fs.promises) {
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'copyFile', 'unlink', 'truncate']) {
    const original = fs.promises[name]
    if (typeof original !== 'function') continue
    try {
      fs.promises[name] = function guardedAsyncWrite(...args) {
        if (typeof args[0] === 'string') writeLog.push({ fn: 'promises.' + name, target: args[0] })
        return original.apply(fs.promises, args)
      }
    } catch {
      /* 同上 */
    }
  }
}

function isProtectedWrite(target) {
  let abs
  try {
    abs = path.resolve(target)
  } catch {
    return false
  }
  const low = abs.toLowerCase()
  return PROTECTED_ROOTS.some((r) => low === r || low.startsWith(r + path.sep) || low.startsWith(r + '/'))
}

// ---------------------------------------------------------------- 护栏：本机文件 sha256

function watchedClientFiles() {
  const files = []
  const add = (p) => {
    if (fs.existsSync(p)) files.push(p)
  }
  add(path.join(ROAMING, 'com.qodercn.app.stable', 'main.sqlite'))
  add(path.join(ROAMING, 'com.qodercn.app.stable', 'auth.v1.dat'))
  add(path.join(ROAMING, 'com.qodercn.app.stable', 'Local State'))
  add(path.join(ROAMING, 'com.qoder.app.stable', 'main.sqlite'))
  add(path.join(ROAMING, 'qianfan-desktop-app', 'auth.json'))
  add(path.join(ROAMING, 'qianfan-desktop-app', '.cookie-key'))
  add(path.join(HOME, '.codex', 'auth.json'))
  add(path.join(HOME, 'Desktop', 'AI账号管家.lnk'))
  for (const dirName of ['Trae CN', 'Trae']) {
    const global = path.join(ROAMING, dirName, 'User', 'globalStorage', 'state.vscdb')
    add(global)
    const wsRoot = path.join(ROAMING, dirName, 'User', 'workspaceStorage')
    try {
      for (const name of fs.readdirSync(wsRoot)) add(path.join(wsRoot, name, 'state.vscdb'))
    } catch {
      /* 客户端未安装该变体 */
    }
  }
  return [...new Set(files)]
}
function fingerprintMap(files) {
  const map = {}
  for (const f of files) map[f] = sha256IfExists(f)
  return map
}

// ---------------------------------------------------------------- 护栏：源码指纹（12 个关键源码 + 3 个补充）

const PIN_FILES = [
  'src/main/platforms/qoder.js',
  'src/main/platforms/index.js',
  'src/main/sessionVault.js',
  'src/main/agentVault.js',
  'src/main/shortcuts.js',
  'src/main/util/vscdb.js',
  'src/main/index.js',
  'src/main/preload.js',
  'src/renderer/components/WorkspaceDrawer.jsx',
  'src/renderer/App.jsx',
  'src/renderer/components/Sidebar.jsx',
  'src/renderer/styles.css'
]
const PIN_EXTRA = ['package.json', 'scripts/qoder-checkin-probe.js', 'scripts/test-dumate.js']
function pinSources() {
  const map = {}
  for (const rel of [...PIN_FILES, ...PIN_EXTRA]) map[rel] = sha256(path.join(ROOT, rel))
  return map
}

// ---------------------------------------------------------------- 被测模块加载 + 切号/领取哨兵

const qoderPath = path.join(ROOT, 'src/main/platforms/qoder.js')
const platformsPath = path.join(ROOT, 'src/main/platforms/index.js')
const sessionVaultPath = path.join(ROOT, 'src/main/sessionVault.js')
const agentVaultPath = path.join(ROOT, 'src/main/agentVault.js')
const shortcutsPath = path.join(ROOT, 'src/main/shortcuts.js')
const vscdbPath = path.join(ROOT, 'src/main/util/vscdb.js')

const qoder = require(qoderPath)
const platforms = require(platformsPath)
const sessionVault = require(sessionVaultPath)
const agentVault = require(agentVaultPath)
const shortcuts = require(shortcutsPath)
const vscdb = require(vscdbPath)

const realQoderCheckin = qoder.checkin
let qoderCheckinCalls = 0
// 只在受控 stub 下放行：任何未在 stub 内发起的 checkin 都会被拦截，绝不真实领取
qoder.checkin = function guardedCheckin(...args) {
  qoderCheckinCalls++
  if (!stubFetch) throw new Error('QA 护栏拦截：非受控环境禁止调用 qoder.checkin()')
  return realQoderCheckin(...args)
}
let platformsCheckinCalls = 0
platforms.checkin = function guardedPlatformsCheckin() {
  platformsCheckinCalls++
  throw new Error('QA 护栏拦截：禁止调用 platforms.checkin()（会真实领取权益）')
}
const realApplyAccount = qoder.applyAccount
let applyAccountCalls = 0
qoder.applyAccount = function guardedApplyAccount(...args) {
  applyAccountCalls++
  throw new Error('QA 护栏拦截：禁止调用 qoder.applyAccount()（会真实切号）')
}
let switchAccountCalls = 0
platforms.switchAccount = function guardedSwitchAccount(...args) {
  switchAccountCalls++
  throw new Error('QA 护栏拦截：禁止调用 platforms.switchAccount()（会真实切号）')
}

// ---------------------------------------------------------------- 用例常量

const NEW_METHODS = [
  'listSessions', 'exportSessions', 'importSessions', 'getVaultSettings', 'setVaultSettings',
  'listAgents', 'exportAgents', 'importAgents', 'getShortcut', 'setShortcut', 'removeShortcut', 'pickFile'
]
const OLD_METHODS = [
  'listPlatforms', 'listAccounts', 'detect', 'importAccounts', 'login', 'switchAccount',
  'removeAccount', 'batchAccounts', 'renameAccount', 'refreshQuota', 'refreshAllQuota',
  'checkin', 'checkinAll', 'refreshCheckinStatus', 'getSettings', 'setSettings', 'onSchedulerEvent'
]
const CHANNEL_OF = {
  listSessions: 'sessions:list',
  exportSessions: 'sessions:export',
  importSessions: 'sessions:import',
  getVaultSettings: 'vault:settings:get',
  setVaultSettings: 'vault:settings:set',
  listAgents: 'agents:list',
  exportAgents: 'agents:export',
  importAgents: 'agents:import',
  getShortcut: 'shortcut:get',
  setShortcut: 'shortcut:set',
  removeShortcut: 'shortcut:remove',
  pickFile: 'dialog:file'
}
const NEW_CHANNELS = Object.values(CHANNEL_OF)
const PLATFORM_BASELINE = {
  trae: { supportsCheckin: false, supportsCheckinStatus: false, multiAccount: false, loginMode: 'client' },
  'trae-cn': { supportsCheckin: true, supportsCheckinStatus: true, multiAccount: false, loginMode: 'client' },
  qoder: { supportsCheckin: false, supportsCheckinStatus: false, multiAccount: false, loginMode: 'client' },
  'qoder-cn': { supportsCheckin: true, supportsCheckinStatus: true, multiAccount: false, loginMode: 'client' },
  codebuddy: { supportsCheckin: false, supportsCheckinStatus: false, multiAccount: false, loginMode: 'client' },
  'codebuddy-cn': { supportsCheckin: true, supportsCheckinStatus: true, multiAccount: false, loginMode: 'client' },
  workbuddy: { supportsCheckin: false, supportsCheckinStatus: false, multiAccount: false, loginMode: 'none' },
  dumate: { supportsCheckin: true, supportsCheckinStatus: true, multiAccount: true, loginMode: 'client' },
  codex: { supportsCheckin: false, supportsCheckinStatus: false, multiAccount: false, loginMode: 'oauth' }
}

// ---------------------------------------------------------------- 运行时常量

let clientFilesBefore = null
let clientHashBefore = null
let pinBefore = null
const tempDirs = []
let verdictInvalid = false

function newTemp(name) {
  const dir = tmpDir('aam-qa-v030-')
  tempDirs.push(dir)
  return { dir, file: path.join(dir, name) }
}

// ================================================================ A. 环境与护栏前置

async function groupA() {
  console.log('\n--- A) 环境与护栏前置 ---')
  await test('A1 12 个关键源码文件存在且已记录跑前指纹', () => {
    for (const rel of PIN_FILES) assert(fs.existsSync(path.join(ROOT, rel)), `缺少 ${rel}`)
    pinBefore = pinSources()
    return `${PIN_FILES.length} 个核心 + ${PIN_EXTRA.length} 个补充文件，共 ${Object.keys(pinBefore).length} 个指纹`
  })
  await test('A2 本机客户端数据文件 sha256 跑前基线已建立', () => {
    clientFilesBefore = watchedClientFiles()
    clientHashBefore = fingerprintMap(clientFilesBefore)
    // 用 path.join 构造绝对路径比对：Windows 是反斜杠，不能用 endsWith('a/b') 这类正斜杠后缀
    const required = [
      ['qoder-cn/main.sqlite', path.join(ROAMING, 'com.qodercn.app.stable', 'main.sqlite')],
      ['trae-cn/state.vscdb', path.join(ROAMING, 'Trae CN', 'User', 'globalStorage', 'state.vscdb')],
      ['dumate/auth.json', path.join(ROAMING, 'qianfan-desktop-app', 'auth.json')],
      ['dumate/.cookie-key', path.join(ROAMING, 'qianfan-desktop-app', '.cookie-key')]
    ]
    for (const [label, p] of required) {
      assert(fs.existsSync(p), `未找到 ${label}：${p}`)
      assert(clientFilesBefore.includes(p), `${label} 未纳入 sha256 监控清单`)
    }
    return `${clientFilesBefore.length} 个本机文件（含 main.sqlite / state.vscdb / auth.json / .cookie-key / 桌面 .lnk）`
  })
  await test('A3 TLS 环境事实记录（NODE_TLS_REJECT_UNAUTHORIZED=0，不算缺陷）', () => {
    return `NODE_TLS_REJECT_UNAUTHORIZED=${String(process.env.NODE_TLS_REJECT_UNAUTHORIZED)}（环境事实，只读 GET 不校验证书）`
  })
}

// ================================================================ B. Qoder CN 签到（只读）

function minimalHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}
function fullHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
    'Cosy-Version': '0.4.3',
    'Cosy-MachineOS': 'x86_64_win32',
    Accept: 'application/json'
  }
}
async function getCampaigns(headers) {
  const url = qoder.VARIANTS['qoder-cn'].openapi + qoder.CAMPAIGNS_PATH
  const res = await globalThis.fetch(url, { method: 'GET', headers })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, body }
}

let liveCampaigns = null
let qoderAccount = null

async function groupB() {
  console.log('\n--- B) Qoder CN 签到（只读，硬护栏 0 POST） ---')

  await test('B1 工程师探针 node scripts/qoder-checkin-probe.js 退出码 0 且自报 0 POST', () => {
    const r = spawnSync(NODE, [path.join(ROOT, 'scripts/qoder-checkin-probe.js')], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024
    })
    const out = String(r.stdout || '') + String(r.stderr || '')
    assertEq(r.status, 0, `探针退出码非 0：${out.slice(-400)}`)
    assert(/\[PASS\]/.test(out), '探针未输出 [PASS]')
    assert(/0 次 POST/.test(out) && /0 次 checkin\(\)/.test(out), '探针未自报 0 POST / 0 checkin()')
    const m = out.match(/\[完整头\] HTTP (\d+) \/ showCampaign=(\w+) \/ campaigns=(\d+)/)
    assert(m, '未解析到完整头结果行')
    assertEq(m[2], 'true', '探针完整头 showCampaign')
    assert(Number(m[3]) >= 1, '探针完整头 campaigns 少于 1 条')
    return `HTTP ${m[1]} / showCampaign=${m[2]} / campaigns=${m[3]}，探针 0 POST、0 checkin()`
  })

  await test('B2 独立复现：最小头 vs 带 Cosy-ClientType:10 的完整头 GET campaigns', async () => {
    const snap = qoder.readSnapshot('qoder-cn')
    assert(snap && typeof snap.token === 'string' && snap.token.length > 0, '未读到 qoder-cn 本机登录态')
    const token = snap.token
    // 生产头必须与 QA 独立构造的完整头同族，且确实含 Cosy-ClientType:10
    const prod = qoder.campaignsHeaders(token)
    const mine = fullHeaders(token)
    assertEq(prod['Cosy-ClientType'], '10', "生产 campaignsHeaders 缺少 Cosy-ClientType: '10'")
    assertEq(mine['Cosy-ClientType'], '10', "QA 完整头缺少 Cosy-ClientType: '10'")
    const prodKeys = Object.keys(prod).sort().join(',')
    const mineKeys = Object.keys(mine).sort().join(',')
    assertEq(prodKeys, mineKeys, '生产头与 QA 完整头字段集合不一致')

    const minimal = await getCampaigns(minimalHeaders(token))
    const full = await getCampaigns(mine)
    assertEq(full.status, 200, '完整头 GET campaigns HTTP 状态')
    assert(full.body && typeof full.body === 'object', '完整头响应不是可解析 JSON 对象')
    assertEq(full.body.showCampaign, true, '完整头 showCampaign')
    assert(Array.isArray(full.body.campaigns), '完整头 campaigns 不是数组')
    assert(full.body.campaigns.length >= 1, '完整头 campaigns.length < 1（关键头未生效）')
    liveCampaigns = full.body.campaigns
    const minCount = minimal.body && Array.isArray(minimal.body.campaigns) ? minimal.body.campaigns.length : -1
    // 最小头结果只作对照观察，不断言死：服务端改变投放策略时不应误报
    return `最小头 ${minCount} 条 / 完整头 ${full.body.campaigns.length} 条，showCampaign=${full.body.showCampaign}；生产头字段 ${prodKeys}`
  })

  await test('B3 checkinStatus(account)：结构、如实文案、与实时活动状态一致', async () => {
    qoderAccount = qoder.detectCurrent('qoder-cn')
    assert(qoderAccount && qoderAccount.snapshot && qoderAccount.snapshot.session, 'detectCurrent("qoder-cn") 未构造出账号')
    const s = await qoder.checkinStatus(qoderAccount)
    assertEq(s.ok, true, 'checkinStatus.ok')
    assertEq(s.supported, true, 'checkinStatus.supported')
    assertEq(typeof s.checkedIn, 'boolean', 'checkinStatus.checkedIn 类型')
    for (const k of ['credits', 'totalCredits', 'totalTimes', 'streakDays']) {
      assert(k in s && typeof s[k] === 'number', `checkinStatus 缺少数值字段 ${k}`)
    }
    assert(typeof s.message === 'string' && s.message.length > 0, 'message 为空')

    // 用 B2 拿到的实时活动独立推断期望，任何服务端投放状态下都如实，不写死「1 条」
    const claimable = liveCampaigns.filter(
      (c) => String((c && c.claimStatus) || '').trim().toUpperCase() === 'CLAIMABLE'
    ).length
    if (claimable === 0) {
      assertEq(s.checkedIn, true, '无可领活动时 checkedIn 应为 true（不能显示待签到）')
      assert(!/待领|待签到/.test(s.message), `无可领活动却写成待签到：${s.message}`)
      assert(/已领|已全部领取|无可领|无需领取|暂无可领取/.test(s.message), `message 未如实表达已领/无可领：${s.message}`)
    } else {
      assertEq(s.checkedIn, false, `存在 ${claimable} 条 CLAIMABLE 时 checkedIn 应为 false`)
      assert(/待领/.test(s.message), `存在待领活动却未提示：${s.message}`)
    }
    // 本机当前事实：1 条活动且 CLAIMED，应表达「已领取」而非「待签到」
    let localFact = ''
    if (liveCampaigns.length === 1 && String(liveCampaigns[0].claimStatus).toUpperCase() === 'CLAIMED') {
      assert(/已全部领取|已领取/.test(s.message), `本机 1 条 CLAIMED 时 message 未表达已领：${s.message}`)
      localFact = '；本机 1 条 CLAIMED → 已领文案正确'
    }
    // 注册表口径一致性（只读）
    const viaRegistry = await platforms.checkinStatus(qoderAccount)
    assertEq(viaRegistry.supported, true, 'platforms.checkinStatus.supported')
    assertEq(viaRegistry.checkedIn, s.checkedIn, '注册表与适配器 checkedIn 口径一致')
    return `ok=${s.ok} checkedIn=${s.checkedIn} credits=${s.credits} totalCredits=${s.totalCredits} totalTimes=${s.totalTimes} streakDays=${s.streakDays}；message 已校验${localFact}`
  })

  await test('B4 checkin 在「无可领活动」时不发 POST（受控 stub，绝不真实领取）', async () => {
    const scenarios = [
      { name: 'noCampaign', body: { showCampaign: false, claimable: false, campaigns: [] } },
      {
        name: 'allClaimed',
        body: {
          showCampaign: true, claimable: false,
          campaigns: [{ campaignId: 'qa-only-claimed', claimStatus: 'CLAIMED', benefit: { amount: 10 } }]
        }
      },
      { name: 'claimableFlagButEmptyList', body: { showCampaign: true, claimable: true, campaigns: [] } }
    ]
    const notes = []
    for (const sc of scenarios) {
      let localPost = 0
      stubFetch = async (input, init) => {
        const method = String((init && init.method) || 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
          localPost++
          stubPostCount++
          return { ok: false, status: 503, text: async () => '{}', json: async () => ({}) }
        }
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify(sc.body),
          json: async () => sc.body
        }
      }
      try {
        const r = await qoder.checkin(qoderAccount)
        assertEq(localPost, 0, `${sc.name} 场景发出了 ${localPost} 次 POST`)
        assert(r && r.ok === true, `${sc.name} 场景应返回 ok:true`)
        assertEq(r.alreadyCheckedIn, true, `${sc.name} 场景应返回 alreadyCheckedIn:true`)
        notes.push(`${sc.name}:0POST/已领`)
      } finally {
        stubFetch = null
      }
    }
    // 静态兜底：源码里 noCampaign/claimable 分支必须提前 return，且 POST 只在 claimOne 里
    const src = readSrc('src/main/platforms/qoder.js')
    const perf = src.slice(src.indexOf('async function performCheckin'), src.indexOf('async function checkin('))
    assert(/if \(targets\.length === 0\)/.test(perf), 'performCheckin 缺少「无可领活动」提前返回分支')
    assert(/return \{ ok: true, alreadyCheckedIn: true, message \}/.test(perf), '提前返回分支未返回 alreadyCheckedIn')
    assert(/method: 'POST'/.test(src), '未找到领取 POST 语句')
    const postCount = (src.match(/method: 'POST'/g) || []).length
    assertEq(postCount, 1, `源码里 POST 语句应只有 claimOne 一处，实际 ${postCount} 处`)
    return `${scenarios.length} 个场景均 0 POST（受控 stub，无真实网络领取）；源码提前 return + 唯一 POST 点均已确认`
  })

  await test('B5 listPlatforms()：9 平台、qoder-cn 签到能力位与其余 8 个基线一致', () => {
    const rows = platforms.listPlatforms()
    assertEq(rows.length, 9, '平台总数')
    const byId = new Map(rows.map((r) => [r.id, r]))
    const qc = byId.get('qoder-cn')
    assert(qc, '缺少 qoder-cn')
    assertEq(qc.supportsCheckin, true, 'qoder-cn.supportsCheckin')
    assertEq(qc.supportsCheckinStatus, true, 'qoder-cn.supportsCheckinStatus')
    assert(typeof qc.checkinNote === 'string' && qc.checkinNote.length > 0, 'qoder-cn 缺少 checkinNote')
    for (const [id, exp] of Object.entries(PLATFORM_BASELINE)) {
      const row = byId.get(id)
      assert(row, `缺少平台 ${id}`)
      for (const [k, v] of Object.entries(exp)) {
        assertEq(row[k], v, `${id}.${k}`)
      }
    }
    return `9 平台；qoder-cn checkin=true / checkinNote="${qc.checkinNote}"；其余 8 个能力位逐字段与基线一致`
  })
}

// ================================================================ C. 会话仓库

function codeOnly(src) {
  let inBlock = false
  return src
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (inBlock) {
        if (t.includes('*/')) inBlock = false
        return ''
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true
        return ''
      }
      if (t.startsWith('//') || t.startsWith('*')) return ''
      return line
    })
    .join('\n')
}

async function groupC() {
  console.log('\n--- C) 会话仓库（只读 + dryRun） ---')

  await test('C1 listSessions("qoder-cn")：ok:true，能读到会话条目且每条含 id/title/kind', async () => {
    const r = await sessionVault.listSessions('qoder-cn')
    assertEq(r.ok, true, 'qoder-cn listSessions.ok')
    assert(Array.isArray(r.sessions), 'sessions 不是数组')
    assert(r.sessions.length > 0, 'qoder-cn 未读到任何会话条目')
    for (const s of r.sessions) {
      assert(typeof s.id === 'string' && s.id.length > 0, '会话缺少 id')
      assert(typeof s.title === 'string' && s.title.length > 0, '会话缺少 title')
      assert(typeof s.kind === 'string' && s.kind.length > 0, '会话缺少 kind')
    }
    const total = r.sessions.reduce((n, s) => n + (Number(s.messageCount) || 0), 0)
    assert(total > 0, '会话消息总数为 0（关联表未读到）')
    return `${r.sessions.length} 条会话 / ${total} 条消息，字段 id/title/kind 齐全（本机实测约 5 / 88）`
  })

  await test('C2 listSessions("trae-cn")：note 如实说明云端正文/本地仅索引，不伪称可跨账号迁移', async () => {
    const r = await sessionVault.listSessions('trae-cn')
    assertEq(r.ok, true, 'trae-cn listSessions.ok')
    assert(Array.isArray(r.sessions), 'sessions 不是数组')
    assert(/云端/.test(r.note), 'note 未说明正文在云端')
    assert(/本地仅索引/.test(r.note), 'note 未说明本地仅索引')
    assert(/不可行|拒绝|请勿整体覆盖|不做假迁移|归属校验/.test(r.note), 'note 未说明跨账号真迁移不可行')
    assert(!/可跨账号迁移|一键迁移|完整迁移|已迁移到新账号/.test(r.note), 'note 伪称会话可跨账号迁移')
    return `${r.sessions.length} 条本地索引；note 含「云端 / 本地仅索引 / 迁移不可行」，未写可迁移`
  })

  await test('C3 exportSessions 到临时目录：format/version/sessions 契约正确', async () => {
    const t = newTemp('sessions-qoder-cn.json')
    const r = await sessionVault.exportSessions({ platform: 'qoder-cn', file: t.file })
    assertEq(r.ok, true, 'exportSessions.ok')
    assertEq(r.file, t.file, 'exportSessions.file')
    const data = readJson(t.file)
    assertEq(data.format, 'ai-account-manager/sessions', 'format')
    assertEq(data.version, 1, 'version')
    assert(Array.isArray(data.sessions), 'sessions 不是数组')
    assert(Array.isArray(data.tables) && data.tables.length > 0, '导出缺少关联表数据')
    const rows = data.tables.reduce((n, x) => n + (Array.isArray(x.rows) ? x.rows.length : 0), 0)
    assert(rows > 0, '导出的表行数为 0')
    return `format=${data.format} version=${data.version} sessions=${data.sessions.length} 关联表=${data.tables.length} 表行=${rows}`
  })

  await test('C4 importSessions({dryRun:true})：返回 imported/skipped，且两个客户端 db 的 sha256 完全不变', async () => {
    const tq = newTemp('sessions-qoder-cn-import.json')
    const expQ = await sessionVault.exportSessions({ platform: 'qoder-cn', file: tq.file })
    const qTarget = path.join(ROAMING, 'com.qodercn.app.stable', 'main.sqlite')
    const tTarget = path.join(ROAMING, 'Trae CN', 'User', 'globalStorage', 'state.vscdb')
    const before = { q: sha256(qTarget), t: sha256(tTarget) }

    const rq = await sessionVault.importSessions({ file: expQ.file, mode: 'merge', dryRun: true })
    assertEq(rq.ok, true, 'qoder dryRun.ok')
    assertEq(rq.dryRun, true, 'qoder dryRun 标记')
    assert(typeof rq.imported === 'number' && typeof rq.skipped === 'number', 'qoder dryRun 缺少 imported/skipped')
    assert(rq.imported + rq.skipped > 0, 'qoder dryRun 未处理任何导出行')

    const tt = newTemp('sessions-trae-cn-import.json')
    const expT = await sessionVault.exportSessions({ platform: 'trae-cn', file: tt.file })
    const rt = await sessionVault.importSessions({ file: expT.file, mode: 'merge', dryRun: true, targetUid: '900000000000001' })
    assertEq(rt.ok, true, 'trae dryRun.ok')
    assertEq(rt.dryRun, true, 'trae dryRun 标记')
    assert(typeof rt.imported === 'number' && typeof rt.skipped === 'number', 'trae dryRun 缺少 imported/skipped')
    assert(rt.imported + rt.skipped > 0, 'trae dryRun 未处理任何导出键')

    assertEq(sha256(qTarget), before.q, 'qoder-cn main.sqlite 被写入')
    assertEq(sha256(tTarget), before.t, 'trae-cn state.vscdb 被写入')
    return `qoder imported=${rq.imported}/skipped=${rq.skipped}；trae imported=${rt.imported}/skipped=${rt.skipped}；两库 sha256 ${shortHash(before.q)} / ${shortHash(before.t)} 前后一致`
  })

  await test('C5 getSettings() 返回 protectOnSwitch/autoArchive/archiveKeep，且 setStore 替身注入生效', () => {
    const def = sessionVault.getSettings()
    for (const k of ['protectOnSwitch', 'autoArchive', 'archiveKeep']) assert(k in def, `getSettings 缺少 ${k}`)
    assertEq(def.protectOnSwitch, true, '默认 protectOnSwitch')
    assertEq(def.autoArchive, true, '默认 autoArchive')
    assertEq(def.archiveKeep, 5, '默认 archiveKeep')
    // 替身 store 注入（纯内存，不写盘）
    let savedPatch = null
    sessionVault.setStore({
      getSettings: () => ({ vault: { protectOnSwitch: false, autoArchive: false, archiveKeep: 3 } }),
      setSettings: (p) => {
        savedPatch = p
        return { vault: p.vault }
      }
    })
    try {
      const injected = sessionVault.getSettings()
      assertEq(injected.protectOnSwitch, false, '注入后 protectOnSwitch')
      assertEq(injected.archiveKeep, 3, '注入后 archiveKeep')
      const changed = sessionVault.setSettings({ archiveKeep: 7 })
      assert(savedPatch && savedPatch.vault && savedPatch.vault.archiveKeep === 7, 'setSettings 未把 patch 交给 store')
      assertEq(changed.archiveKeep, 7, 'setSettings 返回值')
    } finally {
      sessionVault.setStore(null)
    }
    assertEq(sessionVault.getSettings().protectOnSwitch, true, '卸载替身后应回到默认值')
    return `默认 {protectOnSwitch:true, autoArchive:true, archiveKeep:5}；替身注入/卸载均生效，无 Electron 依赖`
  })

  await test('C6 静态审查 snapshotForSwitch / restoreForSwitch：检查进程、备份、键级合并、dryRun 不写盘', () => {
    const sv = readSrc('src/main/sessionVault.js')
    const vd = readSrc('src/main/util/vscdb.js')
    const restore = sv.slice(sv.indexOf('async function restoreForSwitch'), sv.indexOf('module.exports'))
    const snapshot = sv.slice(sv.indexOf('async function snapshotForSwitch'), sv.indexOf('async function restoreForSwitch'))

    // 归档只写应用自身 userData，不覆盖客户端 db
    assert(/archiveDir\(meta\)/.test(snapshot), 'snapshotForSwitch 未写到应用自身归档目录')
    assert(/writeJsonAtomic\(file, payload\)/.test(snapshot), 'snapshotForSwitch 未写归档文件')
    assert(!/qoderDbPath|globalDbPath/.test(snapshot), 'snapshotForSwitch 直接触碰了客户端 db 路径')

    // 还原前必须检查客户端进程；还原走 merge 导入
    assert(/isProcessRunning/.test(restore), 'restoreForSwitch 未检查客户端进程')
    assert(/importSessions\(\{ file, mode: 'merge', dryRun: false \}\)/.test(restore), 'restoreForSwitch 未按 merge 还原')
    assert(/跳过自动还原/.test(restore), 'restoreForSwitch 客户端运行时未跳过')

    // 写盘前备份 + 进程检查 + 键级 / 行级合并，绝不整库覆盖
    assert(/function assertClientClosed/.test(vd), 'vscdb 缺少 assertClientClosed')
    assert(/isProcessRunning/.test(vd), 'assertClientClosed 未检查进程')
    assert(/function atomicWrite\(file, buf, doBackup\)/.test(vd), '缺少 atomicWrite')
    assert(/if \(doBackup !== false\) backupFile\(file\)/.test(vd), 'atomicWrite 未默认备份')
    assert(/INSERT OR REPLACE INTO ItemTable/.test(vd), 'writeKeys 未做键级 INSERT OR REPLACE')
    assert(/INSERT OR REPLACE INTO \$\{quoteIdent\(table\)\}/.test(sv), 'importQoder 未做行级 INSERT OR REPLACE')
    assert(/atomicWrite\(file, Buffer\.from\(opened\.db\.export\(\)\), true\)/.test(sv), 'importQoder 写盘未备份')
    assert(/writeKeys\(file, patch, \{ client: meta, dryRun: Boolean\(dryRun\), backup: true \}\)/.test(sv), 'importTrae 未以 backup:true 键级写回')
    assert(/if \(!dryRun\) opened\.db\.run\(insertSql, cells\)/.test(sv), 'importQoder dryRun 仍会执行行写入')
    assert(/if \(!dryRun && imported > 0\)/.test(sv), 'importQoder dryRun 仍会导出写盘')
    assert(/if \(options\.dryRun\) \{/.test(vd) && /dryRun: true, file/.test(vd), 'writeKeys dryRun 未提前返回')
    // 不存在「拿外部文件整体替换目标 db」的写法
    assert(!/writeFileSync\(file,/.test(vd), '存在直接整库覆盖写目标 db 的语句')
    return '进程检查 / backupFile 备份 / INSERT OR REPLACE 键级与行级合并 / dryRun 提前返回均已静态确认'
  })

  await test('C7 可执行：临时副本上验证 writeKeys 键级合并 + 备份 + 其它键原样保留', async () => {
    const t = newTemp('key-merge-state.vscdb')
    const S = await vscdb.getSql()
    const db = new S.Database()
    db.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    db.run("INSERT INTO ItemTable (key, value) VALUES ('keep.a', 'A')")
    db.run("INSERT INTO ItemTable (key, value) VALUES ('keep.b', 'B')")
    db.run("INSERT INTO ItemTable (key, value) VALUES ('target', 'OLD')")
    fs.writeFileSync(t.file, Buffer.from(db.export()))
    db.close()

    // dryRun 不改盘
    const before = sha256(t.file)
    const dry = await vscdb.writeKeys(
      t.file,
      [{ key: 'target', value: Buffer.from('NEW'), valueType: 'text' }, { key: 'added', value: 'X', valueType: 'text' }],
      { dryRun: true, backup: true, client: null }
    )
    assertEq(dry.dryRun, true, 'dryRun 标记')
    assertEq(sha256(t.file), before, 'dryRun 改动了临时 db')

    // 真写：只动目标键，其它键保留
    const wet = await vscdb.writeKeys(
      t.file,
      [{ key: 'target', value: Buffer.from('NEW'), valueType: 'text' }, { key: 'added', value: 'X', valueType: 'text' }],
      { dryRun: false, backup: true, client: null }
    )
    assertEq(wet.written, 2, '写入键数')
    assert(fs.existsSync(t.file + '.bak'), '写盘前未生成 .bak 备份')
    const opened = await vscdb.openVscdb(t.file)
    try {
      assertEq(opened.rows.get('keep.a'), 'A', 'keep.a 被抹掉（疑似整库覆盖）')
      assertEq(opened.rows.get('keep.b'), 'B', 'keep.b 被抹掉（疑似整库覆盖）')
      assertEq(opened.rows.get('target'), 'NEW', 'target 未被替换')
      assertEq(opened.rows.get('added'), 'X', 'added 未新增')
    } finally {
      if (opened.db) opened.db.close()
    }
    return '临时副本：keep.a/keep.b 原样保留、target→NEW、added 新增、生成 .bak；dryRun 零改动（本机客户端 db 未触碰）'
  })
}

// ================================================================ D. 智能体仓库

async function groupD() {
  console.log('\n--- D) 智能体仓库 ---')

  await test('D1 listAgents()：至少 1 个 custom 智能体，含「3D工作台开发助手」及 prompt/tools/mcpList', async () => {
    const r = await agentVault.listAgents()
    assertEq(r.ok, true, 'listAgents.ok')
    assert(Array.isArray(r.agents), 'agents 不是数组')
    assert(r.agents.length >= 1, '未发现任何自定义智能体')
    assert(r.agents.every((a) => a.type === 'custom'), '存在非 custom 智能体')
    const hit = r.agents.find((a) => a.uniqueName === 'workbench-dev-assistant') ||
      r.agents.find((a) => a.name === '3D工作台开发助手')
    assert(hit, '未发现 uniqueName=workbench-dev-assistant / 名称=3D工作台开发助手 的智能体')
    assert(typeof hit.prompt === 'string' && hit.prompt.length > 500, `prompt 过短或缺失：${hit.prompt && hit.prompt.length}`)
    assert(Array.isArray(hit.tools), 'tools 不是数组')
    assert(Array.isArray(hit.mcpList), 'mcpList 不是数组')
    assert(/本机已缓存/.test(r.note) && /云端全量/.test(r.note), 'note 未如实说明只能导出本机已缓存的')
    assert(!/云端全量.*可导出|一键拉取云端/.test(r.note), 'note 伪称可导出云端全量')
    return `${r.agents.length} 个 custom；命中「${hit.name}」unique_name=${hit.uniqueName}，prompt ${hit.prompt.length} 字（本机实测 1499），tools/mcpList 为数组；note 如实`
  })

  await test('D2 exportAgents → importAgents({dryRun:true})：不写盘，两个 vscdb sha256 不变', async () => {
    const t = newTemp('agents-export.json')
    const qTarget = path.join(ROAMING, 'com.qodercn.app.stable', 'main.sqlite')
    const tTarget = path.join(ROAMING, 'Trae CN', 'User', 'globalStorage', 'state.vscdb')
    const before = { q: sha256(qTarget), t: sha256(tTarget) }
    const exp = await agentVault.exportAgents({ file: t.file })
    assertEq(exp.ok, true, 'exportAgents.ok')
    const data = readJson(t.file)
    assertEq(data.format, 'ai-account-manager/agents', 'agents format')
    assertEq(data.version, 1, 'agents version')
    assert(Array.isArray(data.agents) && data.agents.length > 0, '导出没有智能体')
    const imp = await agentVault.importAgents({ file: t.file, mode: 'merge', dryRun: true, targetUid: '900000000000001' })
    assertEq(imp.ok, true, 'importAgents dryRun.ok')
    assertEq(imp.dryRun, true, 'importAgents dryRun 标记')
    assert(typeof imp.imported === 'number' && typeof imp.skipped === 'number', '缺少 imported/skipped')
    assertEq(sha256(qTarget), before.q, 'qoder-cn main.sqlite 被写入')
    assertEq(sha256(tTarget), before.t, 'trae-cn state.vscdb 被写入')
    return `导出 ${data.agents.length} 个；dryRun imported=${imp.imported}/skipped=${imp.skipped}；两库 sha256 前后一致`
  })

  await test('D3 导出的智能体 JSON 不含 token / cookie / 密钥 / 凭据形状', () => {
    const t = newTemp('agents-secrets.json')
    return agentVault.exportAgents({ file: t.file }).then(() => {
      const text = fs.readFileSync(t.file, 'utf8')
      const data = JSON.parse(text)
      const keys = []
      const walk = (o) => {
        if (!o || typeof o !== 'object') return
        if (Array.isArray(o)) {
          for (const x of o) walk(x)
          return
        }
        for (const [k, v] of Object.entries(o)) {
          keys.push(k)
          walk(v)
        }
      }
      walk(data)
      const sensitive = /secret:\/\/|token|cookie|csrf|password|credential|oauth|bearer|api[_-]?key/i
      const bad = keys.filter((k) => sensitive.test(k))
      assertEq(bad.length, 0, `导出 JSON 键名含敏感字段：${bad.slice(0, 5).join(',')}`)
      assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), '导出 JSON 含 JWT 形状凭据')
      assert(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(text), '导出 JSON 含 Bearer 凭据')
      assert(!/auth\.v1\.dat|\.cookie-key|encryptedCookies/i.test(text), '导出 JSON 含客户端凭据文件引用')
      return `扫描 ${keys.length} 个键名：0 个敏感键；无 JWT / Bearer / 凭据文件引用`
    })
  })
}

// ================================================================ E. 快捷方式

async function groupE() {
  console.log('\n--- E) 快捷方式（不改用户桌面） ---')

  await test('E1 静态审查：只用 shell.readShortcutLink / writeShortcutLink，代码里无 COM/PowerShell，含目标校验与 operation 白名单', () => {
    const src = readSrc('src/main/shortcuts.js')
    const code = codeOnly(src)
    assert(/shell\.readShortcutLink/.test(code), '未使用 shell.readShortcutLink')
    assert(/shell\.writeShortcutLink/.test(code), '未使用 shell.writeShortcutLink')
    const forbidden = /WScript\.Shell|powershell|New-Object|CoCreateInstance|ActiveXObject|COM\(/i
    assert(!forbidden.test(code), '可执行代码里出现 COM / PowerShell / WScript.Shell 调用')
    // 注释里作为「为什么不用它」的说明性提及，不算实现，单独记录
    const inComments = forbidden.test(src) && !forbidden.test(code)
    assert(/if \(!exists\(target\)\) throw/.test(code), 'setShortcut 缺少目标存在性校验')
    assert(/const OPERATIONS = \['create', 'update', 'replace'\]/.test(code), '缺少 operation 白名单')
    assert(/OPERATIONS\.includes\(String\(opts\.operation\)\)/.test(code), 'operation 未按白名单校验')
    return `只用 Electron shell 两个 API；可执行代码 0 处 COM/PowerShell${inComments ? '（注释第 3 行有「为何不用 COM」说明性提及，非实现）' : ''}；exists(target) 校验 + OPERATIONS 白名单`
  })

  await test('E2 getShortcut() 纯 Node 可执行：结构齐全且现有 AI账号管家.lnk 目标非空', () => {
    const sc = shortcuts.getShortcut()
    for (const k of ['exists', 'path', 'target', 'appExe', 'desktopDir']) assert(k in sc, `getShortcut 缺少字段 ${k}`)
    assert(typeof sc.path === 'string' && sc.path.length > 0, 'path 为空')
    assert(typeof sc.appExe === 'string' && sc.appExe.length > 0, 'appExe 为空')
    assert(typeof sc.desktopDir === 'string' && sc.desktopDir.length > 0, 'desktopDir 为空')
    assertEq(sc.exists, fs.existsSync(sc.path), 'exists 与实际不一致')
    if (sc.exists) {
      assert(typeof sc.target === 'string' && sc.target.trim().length > 0, '现有 .lnk 读到空 target')
      assert(/\.exe$/i.test(sc.target.trim()), `读到的 target 不是 exe：${sc.target}`)
    }
    return `exists=${sc.exists} target=${sc.exists ? '已读取（非空 .exe）' : '(快捷方式不存在)'} appExe/desktopDir 均已返回；未调用 setShortcut/removeShortcut`
  })
}

// ================================================================ F. IPC 契约一致性（静态逐字比对）

async function groupF() {
  console.log('\n--- F) IPC 契约一致性（静态逐字比对） ---')

  await test('F1 preload.js 暴露且仅暴露 12 个新方法，字段名与 channel 一字不差', () => {
    const src = readSrc('src/main/preload.js')
    const methods = [...src.matchAll(/^  ([A-Za-z_$][\w$]*):/gm)].map((m) => m[1])
    assertEq(methods.length, 29, `preload 方法总数应为 17 旧 + 12 新 = 29，实际 ${methods.length}`)
    const extra = methods.filter((m) => !OLD_METHODS.includes(m))
    assertEq(extra.length, 12, `新增方法数应为 12，实际 ${extra.length}：${extra.join(',')}`)
    for (const m of NEW_METHODS) assert(extra.includes(m), `preload 缺少新方法 ${m}`)
    const channels = {}
    for (const m of src.matchAll(/^  ([A-Za-z_$][\w$]*):[^\n]*?ipcRenderer\.invoke\('([^']+)'/gm)) {
      channels[m[1]] = m[2]
    }
    for (const [method, channel] of Object.entries(CHANNEL_OF)) {
      assert(method in channels, `preload 缺少 ${method} 的 invoke`)
      assertEq(channels[method], channel, `preload ${method} 的 channel`)
    }
    return `29 个方法（17 旧 + 12 新）；12 个新方法与 channel 逐字匹配：${NEW_CHANNELS.join(' / ')}`
  })

  await test('F2 index.js 注册对应 12 个 IPC channel（逐字）', () => {
    const src = readSrc('src/main/index.js')
    const channels = new Set([...src.matchAll(/(?:safeHandle|ipcMain\.handle)\(\s*'([^']+)'/g)].map((m) => m[1]))
    for (const c of NEW_CHANNELS) assert(channels.has(c), `index.js 未注册 channel ${c}`)
    const newRegistered = NEW_CHANNELS.filter((c) => channels.has(c)).length
    assertEq(newRegistered, 12, '新 channel 注册数')
    return `12 个 channel 全部命中：${NEW_CHANNELS.join(' / ')}`
  })

  await test('F3 WorkspaceDrawer.jsx 的 call("方法名") 全部落在 12 个白名单内', () => {
    const src = readSrc('src/renderer/components/WorkspaceDrawer.jsx')
    const used = [...new Set([...src.matchAll(/\bcall\(\s*'([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]))].sort()
    const outside = used.filter((m) => !NEW_METHODS.includes(m))
    assertEq(outside.length, 0, `WorkspaceDrawer 调用了白名单外的方法：${outside.join(',')}`)
    assertEq(used.length, 12, `WorkspaceDrawer 实际用到 ${used.length} 个新方法，期望 12 个`)
    return `抽取到 ${used.length} 个 call() 方法，全部在白名单内：${used.join(', ')}`
  })

  await test('F4 渲染层不得出现 require( / ipcRenderer / process.env', () => {
    const files = listJsRecursively(path.join(ROOT, 'src/renderer'))
    files.push(path.join(ROOT, 'index.html'))
    const bad = []
    const re = /\brequire\s*\(|\bipcRenderer\b|\bprocess\.env\b/
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      if (re.test(text)) bad.push(path.relative(ROOT, f))
    }
    assertEq(bad.length, 0, `渲染层出现 Node/Electron 直连：${bad.join(',')}`)
    return `${files.length} 个渲染层文件 + index.html 已扫描，0 处直连`
  })

  await test('F5 主进程 console.* 不打印 token / cookie / 密钥 / 响应体', () => {
    const files = listJsRecursively(path.join(ROOT, 'src/main')).filter((f) => f.endsWith('.js'))
    const sensitive = /\b(token|cookie|secret|password|credential|api[_-]?key|bearer|authInfo|rawBody|responseBody|\bbody\b|\braw\b|\btext\b)\b/i
    const bad = []
    let consoleCount = 0
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(/console\.(log|warn|error|info|debug)\s*\(([^)]*)\)/g)) {
        consoleCount++
        if (sensitive.test(m[2])) bad.push(`${path.relative(ROOT, f)}: console.${m[1]}(${m[2].trim().slice(0, 60)})`)
      }
    }
    assertEq(bad.length, 0, `console 参数含敏感标识符：${bad.slice(0, 3).join(' | ')}`)
    return `${files.length} 个主进程 .js，${consoleCount} 条 console 语句，0 条夹带凭据/响应体`
  })

  // 终验新增（team-lead 冻结通知要求）：App.jsx 切号 toast 的 sessionProtect 判空处理
  await test('F6 App.jsx 切号 toast：sessionProtect 判空 + 四字段明细 + 保护全关不刷屏', () => {
    const src = readSrc('src/renderer/App.jsx')
    const block = sliceBetween(src, "if (action === 'switch')", "if (action === 'quota')")
    assert(/const sp = \(r && r\.sessionProtect\) \|\| null/.test(block), 'sessionProtect 未做判空兜底（旧版主进程可能无此字段）')
    assert(/if \(sp && \(sp\.archived \|\| sp\.restored \|\| sp\.skipped\)\)/.test(block), '缺少三态判空守卫，保护全关时会每条切号刷屏')
    for (const k of ['archived', 'restored', 'skipped', 'reason']) {
      assert(new RegExp('sp\\.' + k).test(block), `toast 未处理 sessionProtect.${k}`)
    }
    assert(/sp\.reason \? String\(sp\.reason\) : ''/.test(block), 'reason 未做判空 / String 兜底')
    assert(/lines\.push\(`会话保护：/.test(block), 'toast 未追加会话保护明细')
    assert(/protectWarn/.test(block) && /tone: 'warn'/.test(block), '缺少按 skipped/失败原因升级为 warn 的语气判定')
    return 'sp 空值兜底 + archived/restored/skipped/reason 四字段判空 + reason String() 兜底 + protectWarn 语气，均静态确认'
  })

  // 终验新增（team-lead 冻结通知要求）：WorkspaceDrawer「自动按变体解析」选项
  await test('F7 WorkspaceDrawer「自动按变体解析」下拉：value 空串、targetUid 单字符串、无新增契约字段', () => {
    const src = readSrc('src/renderer/components/WorkspaceDrawer.jsx')
    assert(/<option value="">/.test(src), '未找到「自动按变体解析」空值 <option>')
    assert(/自动按变体解析/.test(src), '缺少「自动按变体解析」文案')
    assert(/建议按变体分批导出 \/ 导入，或在上方下拉选「自动按变体解析」/.test(src), '第 19 行分批提示文案缺失')
    assert(/const \[targetUid, setTargetUid\] = useState\(''\)/.test(src), 'targetUid 初始值不是空串')
    assert(/setTargetUidTouched\(true\)/.test(src), '选择后未标记 touched（重开抽屉会被覆盖）')
    assert(/call\('importAgents', \{ file, targetUid, mode: 'merge', dryRun: false \}\)/.test(src), 'importAgents 未传单字符串 targetUid')
    // 没有引入按变体分别指定 uid 的对象 / 新契约字段（team-lead 已拍板维持单字符串）
    assert(!/targetUids|variantUids|uidMap|targetUidMap|variantMap|targetUid:\s*\{/.test(src), '出现新增的 targetUid 契约字段')
    return '实际实现含下拉空串选项（非仅提示文案）；payload 仍为 {file,targetUid,mode,dryRun}，无新增契约字段'
  })

  // 终验新增（team-lead 冻结通知要求）：noCampaign 低危 UI 表达问题，如实记录，不判 FAIL
  await test('F8 已知低危项记录：noCampaign 主进程已保留、渲染层未用于区分文案（非 FAIL）', () => {
    assert(/noCampaign/.test(readSrc('src/main/platforms/qoder.js')), 'qoder.js 未产出 noCampaign')
    const sched = readSrc('src/main/scheduler.js')
    assert(/account\.checkin = \{ \.\.\.st, at: Date\.now\(\) \}/.test(sched), 'refreshCheckins 未全量透传签到状态')
    const used = listJsRecursively(path.join(ROOT, 'src/renderer')).filter((f) => /noCampaign/.test(fs.readFileSync(f, 'utf8')))
    assertEq(used.length, 0, `渲染层已使用 noCampaign，与已知项不符：${used.map((f) => path.relative(ROOT, f)).join(',')}`)
    return 'INFO：scheduler 全量透传 noCampaign（字段未丢），但卡片/format.js 未区分「活动未开始」与「已领取」→ 低危 UI 表达问题，本轮不作为 FAIL'
  })
}

// ================================================================ G. 切号会话保护闭环

function sliceBetween(src, start, end) {
  const i = src.indexOf(start)
  assert(i >= 0, `源码未找到片段起点 ${start}`)
  const j = end ? src.indexOf(end, i) : src.length
  assert(j > i, `源码未找到片段终点 ${end}`)
  return src.slice(i, j)
}

async function groupG() {
  console.log('\n--- G) 切号会话保护闭环（静态 + 可执行替身） ---')

  await test('G1 静态：accounts:switch 顺序、launch:false、sessionProtect 四字段、res.ok 语义', () => {
    const src = readSrc('src/main/index.js')
    const body = sliceBetween(src, "ipcMain.handle('accounts:switch'", "ipcMain.handle('accounts:remove'")
    assert(/sessionVault\.getSettings\(\)\.protectOnSwitch === true/.test(body), '未按 protectOnSwitch 判定')
    assert(/opts = \{ \.\.\.\(opts \|\| \{\}\), launch: false \}/.test(body), '保护开启时未给 switchAccount 传 launch:false')
    assert(/const sessionProtect = \{ archived: false, restored: false, skipped: false, reason: null \}/.test(body), 'sessionProtect 四字段不全')
    assert(/res\.sessionProtect = sessionProtect/.test(body), 'sessionProtect 未挂到 res')
    assert(/return \{ \.\.\.res, quota \}/.test(body), 'return { ...res, quota } 被破坏')
    assert(!/\bres\.ok\s*=/.test(body), 'res.ok 被改写')

    const pos = {
      archive: body.indexOf('snapshotForSwitch'),
      switch: body.indexOf('platforms.switchAccount'),
      restore: body.indexOf('restoreForSwitch'),
      finally: body.indexOf('} finally {'),
      relaunch: body.indexOf('relaunchClient(account'),
      markUsed: body.indexOf('store.markUsed(id)'),
      refresh: body.indexOf('scheduler.refreshOne(saved)')
    }
    for (const [k, v] of Object.entries(pos)) assert(v >= 0, `顺序片段缺失：${k}`)
    assert(pos.archive < pos.switch, '归档必须早于 switch')
    assert(pos.switch < pos.restore, 'restore 必须晚于 switch')
    assert(pos.restore < pos.finally && pos.finally < pos.relaunch, '拉起客户端必须放在 finally 内且在 restore 之后')
    assert(pos.relaunch < pos.markUsed, '拉起客户端必须早于 markUsed')
    assert(pos.markUsed < pos.refresh, 'markUsed 必须早于刷新额度')

    // 归档/还原失败只 warn，不外抛
    const archiveTry = body.slice(body.indexOf('// 切号前归档'), body.indexOf('const res = await platforms.switchAccount'))
    assert(/console\.warn/.test(archiveTry) && /catch \(e\)/.test(archiveTry), '归档失败未只 warn')
    assert(!/throw\b/.test(archiveTry), '归档失败会外抛，可能把成功切号报成失败')
    const restoreBlock = body.slice(body.indexOf('// 还原 + finally'), body.indexOf('// sessionProtect 挂到 res'))
    assert(/console\.warn/.test(restoreBlock) && /catch \(e\)/.test(restoreBlock), '还原失败未只 warn')
    assert(!/throw\b/.test(restoreBlock), '还原失败会外抛')
    return '顺序 归档→switch→restore→finally拉起→markUsed→刷新额度；4 字段 / launch:false / 只 warn / return 结构均确认'
  })

  await test('G2 可执行替身：还原抛错时仍拉起客户端，且成功切号不被报成失败', async () => {
    const handlers = new Map()
    const events = []
    const state = { protect: true, restoreMode: 'ok', launched: false }
    let lastOpts = null

    class FakeBrowserWindow {
      constructor() {
        this.webContents = { send() {}, setWindowOpenHandler() {}, once() {}, on() {}, capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }) }
      }
      loadFile() {}
      loadURL() {}
      isDestroyed() { return false }
      isMinimized() { return false }
      restore() {}
      focus() {}
      on() {}
      static getAllWindows() { return [] }
    }
    const electronMock = {
      app: {
        requestSingleInstanceLock: () => true,
        getPath: () => os.tmpdir(),
        getVersion: () => '33.0.0',
        whenReady: () => Promise.resolve(),
        on() {}, quit() {}, isPackaged: false
      },
      BrowserWindow: FakeBrowserWindow,
      ipcMain: { handle: (n, f) => handlers.set(n, f), removeHandler() {} },
      safeStorage: { isEncryptionAvailable: () => false },
      session: { defaultSession: { setProxy: () => Promise.resolve() } },
      shell: { openExternal() {} },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true })
      },
      net: {}
    }
    const platformsMock = {
      registry: {
        'qoder-cn': { meta: { exeNames: ['FakeQoder.exe'] }, adapter: { findExe: () => 'C:\\fake\\Qoder.exe' } }
      },
      listPlatforms: () => [],
      switchAccount: async (_acc, opts) => {
        lastOpts = { ...(opts || {}) }
        events.push('switch:launch=' + String(opts && opts.launch))
        return { ok: true, launched: state.launched, storagePath: 'fake' }
      }
    }
    const sessionVaultMock = {
      setStore() {},
      getSettings: () => ({ protectOnSwitch: state.protect, autoArchive: true, archiveKeep: 5 }),
      snapshotForSwitch: async () => {
        events.push('archive')
        return { ok: true }
      },
      restoreForSwitch: async () => {
        events.push('restore')
        if (state.restoreMode === 'throw') throw new Error('模拟还原异常')
        if (state.restoreMode === 'skipped') return { ok: true, skipped: true, message: '客户端已启动，跳过自动还原' }
        return { ok: true, imported: 3, message: '已合并 3 行' }
      }
    }
    class FakeStore {
      list() { return [{ id: 'old-account', isCurrent: true, uid: '111' }] }
      get() { return { id: 'new-account', platform: 'qoder-cn', uid: '222', name: '目标账号' } }
      markUsed() { events.push('markUsed') }
      getSettings() { return {} }
      upsert(a) { return a }
      markCurrent() {}
      remove() { return true }
      setSettings(p) { return p }
    }
    class FakeScheduler {
      start() {}
      reschedule() {}
      async refreshOne() { events.push('refreshOne'); return { ok: true } }
      async refreshCheckins() { events.push('refreshCheckins') }
      async refreshAll() { return { ok: true } }
    }
    const mocks = {
      electron: electronMock,
      './platforms': platformsMock,
      './sessionVault': sessionVaultMock,
      './agentVault': { setStore() {} },
      './shortcuts': { getShortcut() {}, setShortcut() {}, removeShortcut() {} },
      './store': { AccountStore: FakeStore },
      './scheduler': { Scheduler: FakeScheduler },
      './util/core': { launchApp: () => events.push('launch'), isProcessRunning: () => false }
    }
    const indexPath = path.join(ROOT, 'src/main/index.js')
    delete require.cache[require.resolve(indexPath)]
    const origLoad = Module._load
    Module._load = function (request) {
      if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request]
      return origLoad.apply(this, arguments)
    }
    try {
      require(indexPath)
    } finally {
      Module._load = origLoad
    }
    // 等 whenReady().then 注册完 handler（不使用固定 sleep 猜时间）
    for (let i = 0; i < 100 && !handlers.has('accounts:switch'); i++) {
      await new Promise((r) => setImmediate(r))
    }
    assert(handlers.has('accounts:switch'), 'accounts:switch handler 未注册')
    const handler = handlers.get('accounts:switch')
    const reset = () => { events.length = 0; lastOpts = null }
    const idx = (e, prefix) => e.findIndex((x) => x.startsWith(prefix))

    // case1：保护开启 + 还原成功
    state.protect = true; state.restoreMode = 'ok'; state.launched = false
    reset()
    const r1 = await handler({}, 'new-account', { killRunning: false })
    assertEq(lastOpts && lastOpts.launch, false, 'case1 未传 launch:false')
    assertEq(lastOpts && lastOpts.killRunning, false, 'case1 丢失原有 opts')
    assert(idx(events, 'archive') < idx(events, 'switch') && idx(events, 'switch') < idx(events, 'restore'), 'case1 归档/切号/还原顺序错误')
    assert(idx(events, 'restore') < idx(events, 'launch') && idx(events, 'launch') < idx(events, 'markUsed'), 'case1 finally 拉起顺序错误')
    assert(idx(events, 'markUsed') < idx(events, 'refreshOne'), 'case1 刷新额度顺序错误')
    assert(r1.sessionProtect && ['archived', 'restored', 'skipped', 'reason'].every((k) => k in r1.sessionProtect), 'case1 sessionProtect 四字段')
    assertEq(r1.sessionProtect.archived, true, 'case1 archived')
    assertEq(r1.sessionProtect.restored, true, 'case1 restored')
    assertEq(r1.sessionProtect.skipped, false, 'case1 skipped')
    assertEq(r1.ok, true, 'case1 res.ok 语义')
    assert(r1.quota && r1.quota.ok === true, 'case1 quota.ok')

    // case2：还原抛错 → finally 仍拉起，成功切号不报失败
    state.restoreMode = 'throw'
    reset()
    const r2 = await handler({}, 'new-account', {})
    assert(events.includes('launch'), 'case2 还原抛错后未拉起客户端')
    assert(idx(events, 'launch') < idx(events, 'refreshOne'), 'case2 拉起晚于额度刷新')
    assertEq(r2.ok, true, 'case2 成功切号被报成失败')
    assertEq(r2.sessionProtect.skipped, true, 'case2 skipped')
    assert(/还原失败/.test(r2.sessionProtect.reason || ''), 'case2 reason 未如实')

    // case3：保护关闭 → 原流程一字不变
    state.protect = false; state.restoreMode = 'ok'
    reset()
    const r3 = await handler({}, 'new-account', { foo: 1 })
    assert(!('launch' in (lastOpts || {})), 'case3 不应注入 launch:false')
    assertEq(lastOpts && lastOpts.foo, 1, 'case3 原有 opts 被改')
    assert(!events.includes('launch') && !events.includes('archive') && !events.includes('restore'), 'case3 触发了保护动作')
    assert(r3.sessionProtect && ['archived', 'restored', 'skipped', 'reason'].every((k) => k in r3.sessionProtect), 'case3 sessionProtect 四字段')

    // case4：适配器已自行拉起 → 不重复拉起
    state.protect = true; state.restoreMode = 'skipped'; state.launched = true
    reset()
    const r4 = await handler({}, 'new-account', {})
    assert(!events.includes('launch'), 'case4 重复拉起客户端')
    assertEq(r4.sessionProtect.skipped, true, 'case4 skipped')
    assert(/跳过自动还原/.test(r4.sessionProtect.reason || ''), 'case4 reason 未回传')

    delete require.cache[require.resolve(indexPath)]
    return '4 个 case 全通过：顺序正确 / 还原抛错仍 launch 且 ok:true / 关闭保护原流程不变 / 已拉起不重复；0 次真实切号（mock）'
  })
}

// ================================================================ H. 构建与回归

function runNode(args, timeout = 300000) {
  return spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 })
}

async function groupH() {
  console.log('\n--- H) 构建与回归 ---')

  await test('H1 npx vite build 成功', () => {
    let r = spawnSync('cmd.exe', ['/c', 'npx vite build'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024
    })
    let how = 'cmd.exe /c npx vite build'
    if (r.status !== 0 || r.error) {
      r = spawnSync(NODE, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024
      })
      how = 'node node_modules/vite/bin/vite.js build'
    }
    assertEq(r.status, 0, `vite build 失败：${String(r.stderr || r.stdout || '').slice(-400)}`)
    assert(/built in/.test(String(r.stdout || '')), 'build 输出缺少 built in')
    return `${how} → exit 0，${String(r.stdout || '').match(/built in [^\n]+/)?.[0] || 'built in'}`
  })

  await test('H2 dist/index.html 引用的 js/css 实际存在', () => {
    const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8')
    const refs = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1])
    assert(refs.length >= 2, `只找到 ${refs.length} 个资源引用`)
    for (const ref of refs) {
      const f = path.join(ROOT, 'dist', ref.replace(/^\.\//, ''))
      assert(fs.existsSync(f), `引用文件不存在：${ref}`)
      assert(fs.statSync(f).size > 0, `引用文件为空：${ref}`)
    }
    return `${refs.length} 个引用全部存在且非空：${refs.map((r) => path.basename(r)).join(', ')}`
  })

  await test('H3 bundle 含新文案「会话 / 智能体 / 快捷方式 / 切号时自动保护会话」', () => {
    const assets = listJsRecursively(path.join(ROOT, 'dist/assets'))
    const text = assets.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    for (const w of ['会话', '智能体', '快捷方式', '切号时自动保护会话']) {
      assert(text.includes(w), `bundle 缺少文案「${w}」`)
    }
    const counts = ['会话', '智能体', '快捷方式', '切号时自动保护会话']
      .map((w) => `${w}×${(text.match(new RegExp(w, 'g')) || []).length}`)
      .join(' ')
    return counts
  })

  await test('H4 node scripts/test-dumate.js --no-build 回归全绿', () => {
    const r = runNode([path.join(ROOT, 'scripts/test-dumate.js'), '--no-build'])
    const out = String(r.stdout || '') + String(r.stderr || '')
    assertEq(r.status, 0, `回归退出码非 0：${out.slice(-500)}`)
    const pass = (out.match(/^\[PASS\]/gm) || []).length
    const fail = (out.match(/^\[FAIL\]/gm) || []).length
    assertEq(fail, 0, `回归存在 ${fail} 条 FAIL`)
    const total = out.match(/合计\s*(\d+)\s*条：通过\s*(\d+)，失败\s*(\d+)/)
    assert(total, '未解析到回归合计行')
    assertEq(Number(total[1]), pass, '合计总数与 PASS 行数不一致')
    assertEq(Number(total[2]), pass, '合计通过数与 PASS 行数不一致')
    assertEq(Number(total[3]), 0, '合计失败数非 0')
    assert(pass >= 44, `回归用例数异常偏少：${pass}`)
    // --no-build 跳过 1 个 vite build 用例故为 44；完整 45/45 由 H8 单独验收，两个口径都对
    return `exit 0 / PASS ${pass} / FAIL 0 / 合计 ${total[1]} 条，ROUTE: NoOne（--no-build 跳过 1 个 build 用例；完整 45/45 见 H8，两个口径都对）`
  })

  await test('H5 node --check 通过所有新增/修改的主进程文件', () => {
    const files = listJsRecursively(path.join(ROOT, 'src/main')).filter((f) => f.endsWith('.js'))
    // 显式核对本次新增/修改文件都在列
    for (const rel of [
      'src/main/index.js', 'src/main/preload.js', 'src/main/platforms/qoder.js', 'src/main/platforms/index.js',
      'src/main/sessionVault.js', 'src/main/agentVault.js', 'src/main/shortcuts.js', 'src/main/util/vscdb.js'
    ]) {
      assert(files.includes(path.join(ROOT, rel)), `待检查清单缺少 ${rel}`)
    }
    const bad = []
    for (const f of files) {
      const r = runNode(['--check', f], 60000)
      if (r.status !== 0) bad.push(path.relative(ROOT, f) + ': ' + String(r.stderr || '').slice(0, 120))
    }
    assertEq(bad.length, 0, `node --check 失败：${bad.join(' | ')}`)
    return `${files.length} 个主进程 .js 全部语法通过（含 8 个本次新增/修改文件）`
  })

  // 版本基线跟随交付版本同步：v0.3.1 仅重构渲染层，v0.3.2 增补智能体归档能力，v0.3.3 增补单个复制，主进程契约与依赖不变
  await test('H6 package.json version === 0.3.3 且无新增第三方依赖', () => {
    const pkg = readJson(path.join(ROOT, 'package.json'))
    assertEq(pkg.version, '0.3.3', 'package.json version')
    const deps = Object.keys(pkg.dependencies || {})
    assertEq(deps.join(','), 'sql.js', `运行时依赖应为且仅为 sql.js，实际 ${deps.join(',')}`)
    return `version=${pkg.version}；dependencies=${deps.join(',')}；devDependencies=${Object.keys(pkg.devDependencies || {}).length} 个（构建期）`
  })

  await test('H7 安全扫描：新增主进程文件 console.* 不含 token/cookie/密钥/响应体', () => {
    const newFiles = [
      'src/main/sessionVault.js', 'src/main/agentVault.js', 'src/main/shortcuts.js',
      'src/main/util/vscdb.js', 'src/main/platforms/qoder.js', 'src/main/index.js', 'src/main/preload.js'
    ]
    const sensitive = /\b(token|cookie|secret|password|credential|api[_-]?key|bearer|authInfo|rawBody|responseBody|\bbody\b|\braw\b|\btext\b)\b/i
    const bad = []
    let consoleCount = 0
    for (const rel of newFiles) {
      const src = readSrc(rel)
      for (const m of src.matchAll(/console\.(log|warn|error|info|debug)\s*\(([^)]*)\)/g)) {
        consoleCount++
        if (sensitive.test(m[2])) bad.push(`${rel}: console.${m[1]}(${m[2].trim().slice(0, 60)})`)
      }
    }
    assertEq(bad.length, 0, `新增主进程文件 console 参数含敏感标识符：${bad.join(' | ')}`)
    return `${newFiles.length} 个文件 / ${consoleCount} 条 console 语句，0 条夹带凭据或响应体`
  })

  // 终验新增（team-lead 冻结通知要求）：45/45 作为验收项，而非假定项
  await test('H8 完整 node scripts/test-dumate.js（含 vite build）45/45 全绿', () => {
    const r = runNode([path.join(ROOT, 'scripts/test-dumate.js')], 300000)
    const out = String(r.stdout || '') + String(r.stderr || '')
    assertEq(r.status, 0, `完整回归退出码非 0：${out.slice(-500)}`)
    const pass = (out.match(/^\[PASS\]/gm) || []).length
    const fail = (out.match(/^\[FAIL\]/gm) || []).length
    const total = out.match(/合计\s*(\d+)\s*条：通过\s*(\d+)，失败\s*(\d+)/)
    assert(total, '未解析到完整回归合计行')
    assertEq(Number(total[1]), 45, '完整回归合计条数')
    assertEq(Number(total[2]), 45, '完整回归通过数')
    assertEq(Number(total[3]), 0, '完整回归失败数')
    assertEq(pass, 45, '完整回归 PASS 行数')
    assertEq(fail, 0, '完整回归 FAIL 行数')
    // 失败时先分辨口径：若合计不是 45 属断言口径问题（QA），45 条里有 FAIL 才是源码回归（Engineer）
    return `exit 0 / 合计 45 条：通过 45，失败 0（含 vite build 用例）；--no-build 44/44 亦成立，两个口径都对`
  })
}

// ================================================================ I. 收尾护栏

async function groupI() {
  console.log('\n--- I) 收尾护栏 ---')

  await test('I1 整轮 0 次真实 POST / 0 次 /claim / 0 次真实领取 / 0 次真实切号', () => {
    const claimHits = netLog.filter((r) => /\/claim\b/i.test(r.url))
    const posts = netLog.filter((r) => r.method === 'POST')
    assertEq(posts.length, 0, `主进程发生 ${posts.length} 次真实 POST`)
    assertEq(nonGetCount, 0, `主进程发生 ${nonGetCount} 次非 GET 请求`)
    assertEq(claimHits.length, 0, `触达 /claim 端点 ${claimHits.length} 次`)
    assertEq(stubPostCount, 0, `受控 stub 期间发生 ${stubPostCount} 次 POST 尝试`)
    assertEq(platformsCheckinCalls, 0, `platforms.checkin 被调用 ${platformsCheckinCalls} 次`)
    assertEq(applyAccountCalls, 0, `qoder.applyAccount 被调用 ${applyAccountCalls} 次`)
    assertEq(switchAccountCalls, 0, `platforms.switchAccount 被调用 ${switchAccountCalls} 次`)
    assert(qoderCheckinCalls === 3, `qoder.checkin 受控调用应为 3 次，实际 ${qoderCheckinCalls}`)
    const paths = [...new Set(netLog.map((r) => r.method + ' ' + urlPath(r.url)))]
    return `真实请求 ${netLog.length} 次（${paths.join(' | ') || '无'}）；POST 0 / claim 0 / 真实领取 0 / 真实切号 0；qoder.checkin 受控 stub 调用 ${qoderCheckinCalls} 次`
  })

  await test('I2 本机 main.sqlite / state.vscdb / auth.json / .cookie-key / 桌面 .lnk 的 sha256 前后完全一致', () => {
    const after = fingerprintMap(clientFilesBefore)
    const changed = clientFilesBefore.filter((f) => clientHashBefore[f] !== after[f])
    assertEq(changed.length, 0, `以下本机文件被改动：${changed.map((f) => path.relative(ROAMING, f)).join(', ')}`)
    return `${clientFilesBefore.length} 个文件 sha256 全部 UNCHANGED（含两个 main.sqlite、所有 state.vscdb、auth.json、.cookie-key、桌面 .lnk）`
  })

  await test('I3 源码指纹护栏：12 个关键源码 + 3 个补充文件跑前/跑后 sha256 一致', () => {
    const after = pinSources()
    const changed = [...PIN_FILES, ...PIN_EXTRA].filter((rel) => pinBefore[rel] !== after[rel])
    if (changed.length) verdictInvalid = true
    assertEq(changed.length, 0, `源码在跑测期间发生改动，整轮作废：${changed.join(', ')}`)
    return `${PIN_FILES.length} 个核心 + ${PIN_EXTRA.length} 个补充文件指纹稳定（无并发改动假绿）`
  })

  await test('I4 fs 写盘护栏：所有写目标都不在客户端数据目录 / 用户桌面', () => {
    const bad = writeLog.filter((w) => isProtectedWrite(w.target))
    assertEq(bad.length, 0, `检测到 ${bad.length} 次写向客户端目录/桌面：${bad.slice(0, 3).map((b) => b.fn + '→' + b.target).join(' | ')}`)
    return `${writeLog.length} 次写盘全部落在临时目录 / dist 构建产物，0 次写向客户端目录或桌面`
  })
}

// ================================================================ main

async function main() {
  console.log('=== AI账号管家 v0.3.0 QA 独立验证（scripts/test-v030.js） ===')
  console.log(`时间：${new Date().toISOString()}  Node：${process.version}  ROOT：${ROOT}`)

  await groupA()
  await groupB()
  await groupC()
  await groupD()
  await groupE()
  await groupF()
  await groupG()
  await groupH()
  await groupI()

  const failed = results.filter((r) => !r.ok)
  console.log('\n================ 汇总 ================')
  console.log(`合计 ${results.length} 条：通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}：${f.note}`)
  }
  const verdict = verdictInvalid ? 'INVALID（源码指纹护栏拦截，整轮作废，请源码稳定后重跑）'
    : failed.length ? 'FAIL' : 'PASS'
  console.log(`VERDICT: ${verdict}`)
  console.log(`ROUTE: ${failed.length ? (verdictInvalid ? 'NoOne' : 'Engineer') : 'NoOne'}`)
  console.log('=====================================')

  // 只清理本脚本自己创建的临时目录
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
  process.exit(verdict === 'PASS' ? 0 : 1)
}

main().catch((e) => {
  console.error('[FATAL] ' + (e && e.stack ? e.stack : String(e)))
  console.log('ROUTE: QA（验证脚本自身异常，需修正脚本后重跑）')
  process.exit(1)
})
