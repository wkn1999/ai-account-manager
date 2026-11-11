#!/usr/bin/env node
'use strict'
/**
 * DuMate 适配器 / 平台注册表 / 批量 IPC 回归测试（v0.2.0）
 *
 * 只读原则（硬约束）：
 *   1. 不调用 dumate.checkin() —— 会产生真实 POST 领取
 *   2. 不调用不带 dryRun 的 applyAccount() —— 会改写客户端登录态
 *   3. 任何输出都不打印 cookie / token / 密钥，断言失败信息里也只给账号名与数量
 *
 * 用法：
 *   node scripts/test-dumate.js              # 全量（含 vite build）
 *   node scripts/test-dumate.js --no-build   # 跳过构建
 *   node scripts/test-dumate.js --batch-ipc  # 内部使用：子进程里跑 accounts:batch 行为用例
 * 退出码：0 全部通过 / 1 有失败
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ARGS = new Set(process.argv.slice(2))
const WITH_BUILD = !ARGS.has('--no-build')

const AUTH_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'qianfan-desktop-app')
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json')
const KEY_FILE = path.join(AUTH_DIR, '.cookie-key')

// ---------------------------------------------------------------- 源码指纹锁定
// 编辑器/并发改动会让「静态断言读到旧文件、构建读到新文件」，结论就不可信了。
// 跑之前在 main() 里记录，跑完再比一次。

const PIN_FILES = [
  'src/main/index.js',
  'src/main/preload.js',
  'src/main/platforms/index.js',
  'src/main/platforms/dumate.js',
  'src/main/util/quota.js',
  'src/renderer/App.jsx',
  'src/renderer/components/AccountCard.jsx',
  'src/renderer/components/Sidebar.jsx',
  'src/renderer/components/Topbar.jsx',
  'src/renderer/lib/format.js',
  'src/renderer/styles.css',
  'package.json'
]

let pinAtStart = null

function pinSources() {
  const map = {}
  for (const rel of PIN_FILES) map[rel] = fingerprint(path.join(ROOT, rel)).sha256
  return map
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

function assertThrows(fn, msg, matcher) {
  let err = null
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      throw new TypeError('assertThrows 收到 Promise，请用 assertRejects')
    }
  } catch (e) {
    err = e
  }
  assert(err, `${msg}：期望抛错，实际没有抛`)
  assert(err instanceof Error, `${msg}：抛出的不是 Error 实例`)
  assert(typeof err.message === 'string' && err.message.trim().length > 0, `${msg}：错误信息为空，不可读`)
  if (matcher) assert(matcher.test(err.message), `${msg}：错误信息不可读或不匹配，实际为「${err.message}」`)
  return err
}

async function assertRejects(fn, msg, matcher) {
  let err = null
  try {
    await fn()
  } catch (e) {
    err = e
  }
  assert(err, `${msg}：期望抛错，实际没有抛`)
  assert(err instanceof Error, `${msg}：抛出的不是 Error 实例`)
  assert(typeof err.message === 'string' && err.message.trim().length > 0, `${msg}：错误信息为空，不可读`)
  if (matcher) assert(matcher.test(err.message), `${msg}：错误信息不匹配，实际为「${err.message}」`)
  return err
}

async function test(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note || '', ms: Date.now() - t0 })
  } catch (e) {
    results.push({ name, ok: false, note: (e && e.message) || String(e), ms: Date.now() - t0 })
  }
}

function fingerprint(file) {
  const buf = fs.readFileSync(file)
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    mtimeMs: fs.statSync(file).mtimeMs,
    size: buf.length
  }
}

// ---------------------------------------------------------------- 网络护栏
// 全程记录发出的 HTTP 请求，结束时断言「没有任何一次签到 POST」，作为只读证明。

const netLog = []
const realFetch = globalThis.fetch
globalThis.fetch = function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  const method = String((init && init.method) || 'GET').toUpperCase()
  netLog.push({ method, url })
  return realFetch(input, init)
}

function countCheckinPosts() {
  return netLog.filter((r) => r.method === 'POST' && /loginBonus(\?|$)/.test(r.url)).length
}

// ---------------------------------------------------------------- 被测模块

const platforms = require(path.join(ROOT, 'src/main/platforms'))
const dumate = require(path.join(ROOT, 'src/main/platforms/dumate'))

// 预期的其它平台能力位（本次改动前的事实，用于回归比对）
const BASELINE = {
  trae: { supportsCheckin: false, multiAccount: false, loginMode: 'client' },
  'trae-cn': { supportsCheckin: true, multiAccount: false, loginMode: 'client' },
  qoder: { supportsCheckin: false, multiAccount: false, loginMode: 'client' },
  // v0.3.0 起 qoder-cn 接入 sash 活动签到（需 Cosy-ClientType:10），这是预期能力位变更，不是回归
  'qoder-cn': { supportsCheckin: true, multiAccount: false, loginMode: 'client' },
  codebuddy: { supportsCheckin: false, multiAccount: false, loginMode: 'client' },
  'codebuddy-cn': { supportsCheckin: true, multiAccount: false, loginMode: 'client' },
  workbuddy: { supportsCheckin: false, multiAccount: false, loginMode: 'none' },
  codex: { supportsCheckin: false, multiAccount: false, loginMode: 'oauth' }
}

// ---------------------------------------------------------------- 1. 环境前置

let CURRENT_ACCOUNT = null

async function envTests() {
  await test('前置：DuMate userData 与 auth.json/.cookie-key 存在', () => {
    assert(fs.existsSync(AUTH_FILE), `未找到 ${AUTH_FILE}`)
    assert(fs.existsSync(KEY_FILE), `未找到 ${KEY_FILE}`)
    return `auth.json ${fs.statSync(AUTH_FILE).size} B`
  })
}

// ---------------------------------------------------------------- 2. 账号识别

async function detectTests() {
  await test('detectAccounts("dumate")：返回非空数组且字段完整', async () => {
    const list = await dumate.detectAccounts('dumate')
    assert(Array.isArray(list), 'detectAccounts 未返回数组')
    assert(list.length >= 1, `期望至少 1 个账号，实际 ${list.length}`)
    for (const [i, a] of list.entries()) {
      assert(a && typeof a === 'object', `第 ${i} 条不是对象`)
      for (const f of ['id', 'platform', 'name', 'uid']) {
        assert(typeof a[f] === 'string' && a[f].length > 0, `第 ${i} 条缺少字符串字段 ${f}`)
      }
      assertEq(a.platform, 'dumate', `第 ${i} 条 platform`)
      assert(a.id.startsWith('dumate:'), `第 ${i} 条 id 未以 dumate: 开头，实际 ${a.id}`)
      assert(a.snapshot && typeof a.snapshot === 'object', `第 ${i} 条缺少 snapshot`)
      assert(typeof a.snapshot.profileId === 'string' && a.snapshot.profileId, `第 ${i} 条缺少 snapshot.profileId`)
      assert(Array.isArray(a.snapshot.cookies), `第 ${i} 条 snapshot.cookies 不是数组`)
      assert(a.snapshot.cookies.length > 0, `第 ${i} 条 snapshot.cookies 为空`)
      const bad = a.snapshot.cookies.filter((c) => !c || typeof c.name !== 'string')
      assertEq(bad.length, 0, `第 ${i} 条存在无 name 的 cookie 项`)
      assertEq(typeof a.isCurrent, 'boolean', `第 ${i} 条 isCurrent 不是布尔`)
    }
    return `${list.length} 个账号（${list.map((a) => a.name).join('、')}）`
  })

  await test('detectAccounts("dumate")：isCurrent 唯一且与 auth.json 的 activeProfileId 对应', async () => {
    const list = await dumate.detectAccounts('dumate')
    const current = list.filter((a) => a.isCurrent === true)
    assert(current.length <= 1, `isCurrent 数量应 ≤1，实际 ${current.length}`)
    assertEq(current.length, 1, '当前存在已登录账号，应恰好 1 条 isCurrent')
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    assertEq(current[0].snapshot.profileId, auth.activeProfileId, 'isCurrent 账号的 profileId 与 activeProfileId 不一致')
    CURRENT_ACCOUNT = current[0]
    return `当前：${current[0].name}`
  })

  await test('detectCurrent("dumate")：与 detectAccounts 中的当前账号一致', async () => {
    const list = await dumate.detectAccounts('dumate')
    const cur = dumate.detectCurrent('dumate')
    assert(cur, 'detectCurrent 返回空')
    assertEq(cur.isCurrent, true, 'detectCurrent 返回项 isCurrent')
    const expected = list.find((a) => a.isCurrent)
    assert(expected, 'detectAccounts 中没有当前账号')
    assertEq(cur.id, expected.id, 'detectCurrent 与 detectAccounts 的当前账号 id 不一致')
    assertEq(cur.name, expected.name, '两条路径的账号名不一致')
    return cur.name
  })
}

// ---------------------------------------------------------------- 3. 额度

async function quotaTests() {
  await test('fetchQuota：summary/items/明细口径自洽，endTime 为毫秒', async () => {
    const q = await dumate.fetchQuota(CURRENT_ACCOUNT)
    assert(q && typeof q === 'object', 'fetchQuota 未返回对象')
    assert(q.summary && typeof q.summary === 'object', 'summary 缺失（本机有活跃积分包，不应为空）')
    assert(q.summary.total > 0, `summary.total 应 > 0，实际 ${q.summary.total}`)
    const diff = Math.abs(q.summary.remaining - (q.summary.total - q.summary.used))
    assert(diff <= 0.01, `remaining 与 total-used 不一致（差 ${diff}）`)
    assert(q.summary.remaining >= 0, `remaining 为负：${q.summary.remaining}`)
    assert(Array.isArray(q.items) && q.items.length >= 1, `items 应至少 1 项，实际 ${q.items && q.items.length}`)
    const first = q.items[0]
    assert(first && typeof first.label === 'string' && first.label, 'items[0].label 缺失')
    assert(Array.isArray(first.metrics) && first.metrics.length >= 1, 'items[0].metrics 为空')
    assert(first.endTime != null, 'items[0].endTime 为 null（积分包应有过期时间）')
    assert(first.endTime > 1e12, `items[0].endTime 不是毫秒级时间戳：${first.endTime}`)
    assertEq(first.expired, false, 'items[0].expired 应为 false（未过期包）')
    assert(typeof q.plan === 'string' && q.plan, `plan 缺失，实际 ${q.plan}`)
    return `${q.plan} · ${q.summary.remaining}/${q.summary.total} ${q.summary.unit}`
  })

  await test('fetchQuota：metric 字段语义（used=已用、remaining=剩余、showRemaining 显式声明主指标）', async () => {
    const q = await dumate.fetchQuota(CURRENT_ACCOUNT)
    const m = q.items[0].metrics[0]
    assertEq(m.showRemaining, true, 'DuMate 积分包主指标应显式声明 showRemaining')
    assert(typeof m.used === 'number', 'metrics[0].used 缺失')
    assert(typeof m.remaining === 'number', 'metrics[0].remaining 缺失')
    const sum = m.used + m.remaining
    assert(Math.abs(sum - m.limit) <= 0.01, `used+remaining 应等于 limit：${m.used}+${m.remaining} != ${m.limit}`)
    // summary 是所有积分包的合计；账号可能有多个包，逐包指标必须求和后再比对，
    // 直接拿 items[0] 与 summary 相等只在「恰好一个包」时成立（2026-11-10 实测出现第二个 500 分包）
    const metrics = q.items.flatMap((it) => it.metrics || []).filter((x) => x.showRemaining)
    const sumUsed = metrics.reduce((s, x) => s + x.used, 0)
    const sumRemaining = metrics.reduce((s, x) => s + x.remaining, 0)
    assert(metrics.length >= 1, '至少应有一个 showRemaining 指标')
    assert(Math.abs(sumUsed - q.summary.used) <= 0.01, `各包 used 合计(${sumUsed}) 与 summary.used(${q.summary.used}) 口径不一致`)
    assert(Math.abs(sumRemaining - q.summary.remaining) <= 0.01, `各包 remaining 合计(${sumRemaining}) 与 summary.remaining(${q.summary.remaining}) 口径不一致`)
    return `包数=${metrics.length} used=${sumUsed} remaining=${sumRemaining} 首包limit=${m.limit}`
  })

  await test('AccountCard 渲染取值（可执行）：抽出真实表达式，DuMate 取 remaining、其它平台仍取 used', () => {
    const card = read('src/renderer/components/AccountCard.jsx')
    const exprMatch = card.match(/const shown = (m\.showRemaining && m\.remaining != null \? m\.remaining : m\.used)/)
    assert(exprMatch, '未找到 AccountCard 的 shown 取值表达式（showRemaining 分支可能没接上）')
    const pick = new Function('m', `return ${exprMatch[1]}`)

    const dumateMetric = { label: '剩余 / 总量', limit: 25000, used: 1741.66, remaining: 23258.34, showRemaining: true }
    assertEq(pick(dumateMetric), 23258.34, 'DuMate 卡片主指标应显示剩余而不是已用')

    const legacyMetric = { label: '已用 / 总量', limit: 100, used: 37 }
    assertEq(pick(legacyMetric), 37, '没有 showRemaining 的平台必须仍然显示 used（不能被改动影响）')

    const zeroRemaining = { limit: 100, used: 100, remaining: 0, showRemaining: true }
    assertEq(pick(zeroRemaining), 0, 'remaining 为 0 时不能被当成缺值回退到 used')
    return '3 组输入：DuMate→rem / legacy→used / 0→0'
  })
}

// ---------------------------------------------------------------- 4. 签到状态（只读）

async function checkinStatusTests() {
  await test('checkinStatus：ok/supported/checkedIn/streakDays 类型与今日实际一致', async () => {
    const st = await dumate.checkinStatus(CURRENT_ACCOUNT)
    assertEq(st.ok, true, 'checkinStatus.ok')
    assertEq(st.supported, true, 'checkinStatus.supported')
    assertEq(typeof st.checkedIn, 'boolean', 'checkinStatus.checkedIn 不是布尔')
    assert(typeof st.streakDays === 'number' && st.streakDays >= 0, `streakDays 非法：${st.streakDays}`)
    assert(typeof st.message === 'string' && st.message, 'checkinStatus.message 缺失')
    assert(st.totalTimes >= 0, 'totalTimes 非法')
    assert(st.totalCredits >= 0, 'totalCredits 非法')
    // 与接口原始 hasIssued 对齐：本机今日 hasIssued=true，checkedIn 必须为 true
    const raw = await dumate.checkinStatus(CURRENT_ACCOUNT)
    assertEq(st.checkedIn, raw.checkedIn, '两次调用 checkedIn 不稳定')
    assertEq(st.checkedIn, true, '今日 hasIssued=true，checkedIn 应为 true')
    return `checkedIn=${st.checkedIn} streak=${st.streakDays} 累计 ${st.totalTimes} 次/${st.totalCredits} 分`
  })

  await test('checkinStatus：实现方按 status===active 与 hasIssued 取值，无 checkin() 调用副作用', async () => {
    assertEq(countCheckinPosts(), 0, '过程中出现了签到 POST 请求')
    return `签到 POST 次数 ${countCheckinPosts()}`
  })
}

// ---------------------------------------------------------------- 5. 切号 dryRun

async function applyDryRunTests() {
  await test('applyAccount(dryRun)：返回 willWrite 且完全不动 auth.json / .cookie-key', async () => {
    const beforeAuth = fingerprint(AUTH_FILE)
    const beforeKey = fingerprint(KEY_FILE)
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))

    const res = await dumate.applyAccount(CURRENT_ACCOUNT, { dryRun: true })

    const afterAuth = fingerprint(AUTH_FILE)
    const afterKey = fingerprint(KEY_FILE)

    assertEq(res.ok, true, 'applyAccount.ok')
    assertEq(res.dryRun, true, 'applyAccount.dryRun 未回传 true')
    assert(res.willWrite && typeof res.willWrite === 'object', 'willWrite 缺失')
    assertEq(res.willWrite.activeProfileId, auth.activeProfileId, 'willWrite.activeProfileId 与当前 activeProfileId 不一致')
    assertEq(res.willWrite.matchedBy, 'profileId', '正常路径应通过 profileId 命中')
    assertEq(res.willWrite.createProfile, false, '正常路径不应新建 profile')
    assertEq(typeof res.willWrite.runningClient, 'boolean', 'willWrite.runningClient 应为布尔')
    assertEq(res.storagePath, undefined, 'dryRun 不应回传 storagePath（说明走了写盘分支）')

    assertEq(afterAuth.sha256, beforeAuth.sha256, 'dryRun 改动了 auth.json 内容')
    assertEq(afterAuth.mtimeMs, beforeAuth.mtimeMs, 'dryRun 改动了 auth.json mtime')
    assertEq(afterAuth.size, beforeAuth.size, 'dryRun 改动了 auth.json 大小')
    assertEq(afterKey.sha256, beforeKey.sha256, 'dryRun 改动了 .cookie-key')
    assertEq(afterKey.mtimeMs, beforeKey.mtimeMs, 'dryRun 改动了 .cookie-key mtime')
    return `sha256 ${beforeAuth.sha256.slice(0, 12)}… 前后一致，profileCount=${res.willWrite.profileCount}`
  })

  await test('applyAccount 负向：缺 profileId / 缺 cookies / 未知平台均抛出可读错误', async () => {
    const e1 = await assertRejects(
      () => dumate.applyAccount({ platform: 'dumate', snapshot: {} }, { dryRun: true }),
      '缺 profileId'
    )
    assert(/profileId/.test(e1.message), `缺 profileId 的报错未点明字段，实际「${e1.message}」`)

    const e2 = await assertRejects(
      () => dumate.applyAccount({ platform: 'dumate', snapshot: { profileId: 'x' } }, { dryRun: true }),
      '缺 cookies'
    )
    assert(/登录凭证|cookies/i.test(e2.message), `缺 cookies 的报错不可读，实际「${e2.message}」`)

    const e3 = await assertRejects(
      () => dumate.applyAccount({ platform: 'nope' }, { dryRun: true }),
      '未知平台'
    )
    assert(/未知平台/.test(e3.message), `未知平台报错不可读，实际「${e3.message}」`)

    return `3 条负向用例均抛出可读错误`
  })

  await test('applyAccount 负向：本机账号池里不存在的 profileId 会被拒绝（dryRun）', async () => {
    const ghost = {
      platform: 'dumate',
      snapshot: { profileId: 'ghost-profile-id', cookies: [{ name: 'a', value: 'b' }] }
    }
    const before = fingerprint(AUTH_FILE)
    const err = await assertRejects(() => dumate.applyAccount(ghost, { dryRun: true }), '幽灵账号')
    assert(/账号池|不存在/.test(err.message), `报错不可读，实际「${err.message}」`)
    // 报错必须点出「到底缺哪些字段」，只给一句「账号不存在」用户不知道下一步做什么
    for (const field of ['loginType', 'bceUserId', 'displayName', 'bceAccountId']) {
      assert(err.message.includes(field), `报错未点明缺失字段 ${field}，实际「${err.message}」`)
    }
    assert(/无法在本机重建/.test(err.message), `报错未说明为何不能重建，实际「${err.message}」`)
    assertEq(fingerprint(AUTH_FILE).sha256, before.sha256, '被拒绝的 dryRun 仍改动了 auth.json')
    return '已拒绝、点明 4 个缺失字段且未落盘'
  })

  await test('applyAccount(dryRun)：profileId 过期但身份键命中 → 复用现有 profile，不新建', async () => {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    const snap = { ...CURRENT_ACCOUNT.snapshot, profileId: 'stale-profile-id-from-old-install' }
    const before = fingerprint(AUTH_FILE)
    const res = await dumate.applyAccount({ platform: 'dumate', snapshot: snap }, { dryRun: true })
    assertEq(res.dryRun, true, 'dryRun 标记缺失')
    assertEq(res.willWrite.matchedBy, 'identity', '应通过身份键（bce:accountId:userId）命中')
    assertEq(res.willWrite.createProfile, false, '身份键命中时不应新建 profile')
    assertEq(res.willWrite.activeProfileId, auth.activeProfileId, '回写的 activeProfileId 应仍是本机已有 profile')
    assertEq(fingerprint(AUTH_FILE).sha256, before.sha256, '身份键命中的 dryRun 改动了 auth.json')
    return 'matchedBy=identity，未新建'
  })

  await test('applyAccount(dryRun)：快照齐全但账号池里没有 → 按快照重建 profile（仅计算，不落盘）', async () => {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    const snap = {
      ...CURRENT_ACCOUNT.snapshot,
      profileId: 'qa-rebuilt-profile-uuid',
      bceUserId: 'qa-fake-user-id',
      bceAccountId: 'qa-fake-account-id'
    }
    const before = fingerprint(AUTH_FILE)
    const beforeKey = fingerprint(KEY_FILE)
    const res = await dumate.applyAccount({ platform: 'dumate', snapshot: snap }, { dryRun: true })
    assertEq(res.willWrite.createProfile, true, '快照齐全时应走重建分支')
    assertEq(res.willWrite.matchedBy, 'rebuilt', 'matchedBy 应为 rebuilt')
    assertEq(res.willWrite.activeProfileId, 'qa-rebuilt-profile-uuid', '重建分支的 activeProfileId 应为快照里的 profileId')
    assertEq(res.willWrite.profileCount, auth.accountProfiles.length + 1, '重建后 profileCount 应 +1')
    assertEq(fingerprint(AUTH_FILE).sha256, before.sha256, '重建分支的 dryRun 改动了 auth.json')
    assertEq(fingerprint(AUTH_FILE).mtimeMs, before.mtimeMs, '重建分支的 dryRun 改动了 auth.json mtime')
    assertEq(fingerprint(KEY_FILE).sha256, beforeKey.sha256, '重建分支的 dryRun 改动了 .cookie-key')
    const after = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    assertEq(after.accountProfiles.length, auth.accountProfiles.length, '账号池 profile 数量被 dryRun 改动')
    assertEq(after.activeProfileId, auth.activeProfileId, 'activeProfileId 被 dryRun 改动')
    return 'matchedBy=rebuilt，profileCount +1 且未落盘'
  })

  await test('applyAccount(dryRun)：企业版快照齐全 → 可重建且 activeProviderType=enterprise', async () => {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    const before = fingerprint(AUTH_FILE)
    const snap = {
      ...CURRENT_ACCOUNT.snapshot,
      profileId: 'qa-enterprise-profile-uuid',
      loginType: 'enterprise',
      bceUserId: 'qa-ent-user',
      bceAccountId: 'qa-ent-account',
      enterpriseApiBaseUrl: 'https://qa.example.internal/api',
      vpcSvcUrl: 'https://qa.example.internal/vpc'
    }
    const identity = dumate.profileIdentity(snap)
    assertEq(identity, 'enterprise:https://qa.example.internal/api:qa-ent-user', '企业版身份键口径不对')

    const res = await dumate.applyAccount({ platform: 'dumate', snapshot: snap }, { dryRun: true })
    assertEq(res.willWrite.createProfile, true, '企业版完整快照应可重建')
    assertEq(res.willWrite.matchedBy, 'rebuilt', 'matchedBy 应为 rebuilt')
    assertEq(res.willWrite.activeProviderType, 'enterprise', 'activeProviderType 应为 enterprise')
    assertEq(res.willWrite.activeProfileId, 'qa-enterprise-profile-uuid', 'activeProfileId 应为快照 profileId')
    assertEq(fingerprint(AUTH_FILE).sha256, before.sha256, '企业版 dryRun 改动了 auth.json')
    const after = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    assertEq(after.accountProfiles.length, auth.accountProfiles.length, '企业版 dryRun 改动了账号池')
    assertEq(after.activeProviderType, auth.activeProviderType, 'auth.json 的 activeProviderType 被改写')
    return 'enterprise:apiBase:userId，未落盘'
  })

  await test('applyAccount 负向：企业版缺 enterpriseApiBaseUrl → 报错且点明该字段', async () => {
    const snap = {
      ...CURRENT_ACCOUNT.snapshot,
      profileId: 'qa-enterprise-broken',
      loginType: 'enterprise',
      bceUserId: 'qa-ent-user-2',
      bceAccountId: 'qa-ent-account-2',
      enterpriseApiBaseUrl: null
    }
    const err = await assertRejects(() => dumate.applyAccount({ platform: 'dumate', snapshot: snap }, { dryRun: true }), '企业版缺网关')
    assert(err.message.includes('enterpriseApiBaseUrl'), `报错未点明 enterpriseApiBaseUrl，实际「${err.message}」`)
    return err.message.slice(0, 60) + '…'
  })
}

// ---------------------------------------------------------------- 6. 可执行文件

async function exeTests() {
  await test('findExe(VARIANTS.dumate)：返回已安装的真实路径', () => {
    const exe = dumate.findExe(dumate.VARIANTS.dumate)
    assert(typeof exe === 'string' && exe, 'findExe 未找到 DuMate 客户端')
    assert(fs.existsSync(exe), `findExe 返回的路径不存在：${exe}`)
    assert(/DuMate\.exe$/i.test(exe), `返回路径不是 DuMate.exe：${exe}`)
    return exe
  })
}

// ---------------------------------------------------------------- 7. 注册表

async function registryTests() {
  await test('listPlatforms()：dumate 行能力位正确', () => {
    const rows = platforms.listPlatforms()
    const row = rows.find((r) => r.id === 'dumate')
    assert(row, 'listPlatforms 中没有 dumate')
    assertEq(row.supportsCheckin, true, 'dumate.supportsCheckin')
    assertEq(row.supportsCheckinStatus, true, 'dumate.supportsCheckinStatus')
    assertEq(row.multiAccount, true, 'dumate.multiAccount')
    assertEq(row.loginMode, 'client', 'dumate.loginMode')
    assertEq(row.readOnly, false, 'dumate.readOnly')
    assertEq(row.label, 'DuMate 国内版', 'dumate.label')
    return `${row.label} / checkin=${row.supportsCheckin} / multi=${row.multiAccount} / ${row.loginMode}`
  })

  await test('listPlatforms()：其余 8 个平台能力位与改动前完全一致', () => {
    const rows = platforms.listPlatforms()
    assertEq(rows.length, 9, `平台总数应为 9（8 + dumate），实际 ${rows.length}`)
    const problems = []
    for (const [id, exp] of Object.entries(BASELINE)) {
      const row = rows.find((r) => r.id === id)
      if (!row) {
        problems.push(`${id}: 缺失`)
        continue
      }
      for (const [k, v] of Object.entries(exp)) {
        if (row[k] !== v) problems.push(`${id}.${k}: 期望 ${v} 实际 ${row[k]}`)
      }
    }
    assertEq(problems.length, 0, `能力位回归失败 → ${problems.join('；')}`)
    const multi = rows.filter((r) => r.multiAccount).map((r) => r.id)
    assertEq(JSON.stringify(multi), JSON.stringify(['dumate']), `multiAccount 应只有 dumate，实际 ${multi.join(',')}`)
    return '9 平台能力位无回归'
  })

  await test('detectAll()：不抛错、包含 dumate 账号、非 dumate 结果可解释', async () => {
    const list = await platforms.detectAll()
    assert(Array.isArray(list), 'detectAll 未返回数组')
    const dumateRows = list.filter((r) => r.platform === 'dumate')
    assert(dumateRows.length >= 1, 'detectAll 结果中没有 dumate')
    assertEq(dumateRows.filter((r) => r.detectFailed).length, 0, 'dumate 检测失败')
    const known = new Set([...Object.keys(BASELINE), 'dumate'])
    const unknown = list.filter((r) => !known.has(r.platform))
    assertEq(unknown.length, 0, `出现未知平台结果：${unknown.map((r) => r.platform).join(',')}`)
    for (const r of list) {
      if (r.detectFailed) {
        assert(typeof r.error === 'string' && r.error, `${r.platform} 检测失败但没有错误信息`)
        continue
      }
      assert(typeof r.id === 'string' && r.id.startsWith(`${r.platform}:`), `${r.platform} 的账号 id 前缀不规范：${r.id}`)
      assert(typeof r.name === 'string' && r.name, `${r.platform} 的账号缺 name`)
    }
    const summary = [...new Set(list.map((r) => r.platform))]
      .map((p) => `${p}×${list.filter((r) => r.platform === p).length}`)
      .join(' ')
    return `${list.length} 条：${summary}`
  })
}

// ---------------------------------------------------------------- 8. 语法检查

const SYNTAX_FILES = [
  'src/main/index.js',
  'src/main/preload.js',
  'src/main/platforms/index.js',
  'src/main/platforms/dumate.js',
  'src/main/util/quota.js'
]

async function syntaxTests() {
  await test('node --check：主进程改动文件语法均通过', () => {
    for (const rel of SYNTAX_FILES) {
      const abs = path.join(ROOT, rel)
      assert(fs.existsSync(abs), `文件不存在：${rel}`)
      const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
      assertEq(r.status, 0, `${rel} 语法检查失败：${(r.stderr || '').trim().split('\n')[0]}`)
    }
    return `${SYNTAX_FILES.length} 个文件通过`
  })
}

// ---------------------------------------------------------------- 9. 静态审查（自动化）

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

async function staticTests() {
  await test('安全：主进程未把 cookie/token/密钥写入 console', () => {
    const files = walk(path.join(ROOT, 'src/main')).filter((f) => f.endsWith('.js'))
    const hits = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/console\.(log|warn|error|info|debug)/.test(line)) return
        if (/cookie|token|csrf|secret|password|encryptedCookies|\.cookie-key/i.test(line)) {
          hits.push(`${path.relative(ROOT, f)}:${i + 1}`)
        }
      })
    }
    assertEq(hits.length, 0, `疑似打印敏感字段：${hits.join('、')}`)
    return `${files.length} 个主进程文件已扫描`
  })

  await test('安全：渲染层未直接触达 Node / Electron', () => {
    const files = walk(path.join(ROOT, 'src/renderer')).filter((f) => /\.(js|jsx)$/.test(f))
    const hits = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/\brequire\s*\(|ipcRenderer|__dirname|\bprocess\.env\b|\bprocess\.platform\b/.test(line)) {
          hits.push(`${path.relative(ROOT, f)}:${i + 1} → ${line.trim().slice(0, 60)}`)
        }
      })
    }
    assertEq(hits.length, 0, `渲染层出现 Node 访问：${hits.join(' | ')}`)
    return `${files.length} 个渲染层文件已扫描`
  })

  await test('一致性：IPC/工具函数/字段名两侧命名对得上', () => {
    const preload = read('src/main/preload.js')
    const mainIdx = read('src/main/index.js')
    const app = read('src/renderer/App.jsx')
    const card = read('src/renderer/components/AccountCard.jsx')
    const topbar = read('src/renderer/components/Topbar.jsx')
    const sidebar = read('src/renderer/components/Sidebar.jsx')
    const fmt = read('src/renderer/lib/format.js')
    const store = read('src/main/store.js')

    const checks = [
      [/batchAccounts:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('accounts:batch'/, preload, 'preload 未暴露 batchAccounts→accounts:batch'],
      [/ipcMain\.handle\('accounts:batch'/, mainIdx, '主进程未注册 accounts:batch'],
      [/api\.batchAccounts\(\{\s*action,\s*ids\s*\}\)/, app, 'App.jsx 未调用 api.batchAccounts({action, ids})'],
      [/export function fmtRelative/, fmt, 'format.js 未导出 fmtRelative'],
      [/fmtRelative,/, card, 'AccountCard 未从 format 引入 fmtRelative'],
      [/fmtRelative\(account\.lastUsed\)/, card, 'AccountCard 未使用 account.lastUsed'],
      [/a\.lastUsed = Date\.now\(\)/, store, 'store 未维护 lastUsed'],
      [/platform\.supportsCheckin === false/, card, 'AccountCard 未按 supportsCheckin 判定无签到 badge'],
      [/platform && platform\.readOnly \?/, card, 'AccountCard 未按 readOnly 禁用切号'],
      [/platform\.supportsCheckin &&/, card, 'AccountCard 未按 supportsCheckin 隐藏签到按钮'],
      [/canCheckin=\{canCheckin\}/, app, 'App 未把 canCheckin 传给 Topbar'],
      [/pending=\{pending\}/, app, 'App 未把 pending 传给 Topbar'],
      [/a\.isCurrent/, sidebar, 'Sidebar 未展示当前账号'],
      [/onToggleSelect=\{toggleSelect\}/, app, 'App 未把选择回调传给卡片'],
      [/account\.isCurrent \? ' current' : ''/, card, '卡片未按 isCurrent 标当前'],
      [/return \{ \.\.\.res, quota \}/, mainIdx, 'accounts:switch 未回传切号后的额度结果'],
      [/const q = r && r\.quota/, app, 'App.jsx 未消费 accounts:switch 回传的 quota 字段'],
      [/profileIdentity,/, read('src/main/platforms/dumate.js'), 'dumate 未导出 profileIdentity']
    ]
    const failed = checks.filter(([re, src]) => !re.test(src)).map(([, , label]) => label)
    assertEq(failed.length, 0, `命名/引用不一致 → ${failed.join('；')}`)
    return `${checks.length} 项交叉引用一致`
  })

  await test('样式：本次新增的组件类名都在 styles.css 里有定义', () => {
    const css = read('src/renderer/styles.css')
    const need = [
      'card-check',
      'batchbar',
      'batch-count',
      'selecting',
      'nav-sub',
      'nav-sub-empty',
      'nav-text',
      'toast-lines',
      'toast-line',
      'pack-more',
      'empty-actions',
      'progress-pill',
      'title-sub',
      'title-sub-text',
      'card.selected',
      'badge.dim',
      'tone-danger',
      'tone-warn',
      'tone-ok',
      'toast-line.fail'
    ]
    const missing = need.filter((c) => !css.includes(c))
    assertEq(missing.length, 0, `styles.css 缺少：${missing.join('、')}`)
    return `${need.length} 个类名已定义`
  })

  await test('批量 IPC：动作白名单、逐条 try/catch、每步发 batch-progress、结果字段统一', () => {
    const src = read('src/main/index.js')
    const start = src.indexOf("ipcMain.handle('accounts:batch'")
    assert(start >= 0, '未找到 accounts:batch 处理函数')
    const body = src.slice(start, src.indexOf('\n  })', start))
    assert(/\[\s*'refresh',\s*'checkin',\s*'remove'\s*\]\.includes\(action\)/.test(body), '缺少 action 白名单校验')
    assert(/throw new Error\('未知批量操作: '\s*\+\s*action\)/.test(body), '未知 action 未抛错')
    assert(/Array\.isArray\(data\.ids\)\s*\?\s*data\.ids\.filter\(Boolean\)\s*:\s*\[\]/.test(body), 'ids 归一化缺失')
    assert(/for \(const \[i, id\] of ids\.entries\(\)\)/.test(body), '未按 ids 串行遍历')
    assert(/try\s*{/.test(body) && /catch \(e\)\s*{\s*step = { ok: false, error: e\.message }/.test(body), '单条异常未被捕获成 step')
    assert(/results\.push\(\{ id, name, \.\.\.step \}\)/.test(body), '结果字段未统一成 {id,name,...step}')
    assert(/type: 'batch-progress'/.test(body), '未发 batch-progress 事件')
    assert(/done: i \+ 1, total, name/.test(body), 'batch-progress 的 done/total 字段不完整')
    assert(/该平台无签到接口/.test(body), '批量签到未对不支持平台给出说明')
    assert(/const total = ids\.length/.test(body), 'ids 为空时 total 未定义（应为 0，循环不执行）')
    return '10 项结构断言通过'
  })
}

// ---------------------------------------------------------------- 12. 第二轮增量：切号后刷新 / 批量签到前置校验

/** 取源码里某个 ipcMain.handle 的完整函数体（按 2 空格缩进的收尾 `})` 切） */
function ipcHandlerBody(src, channel) {
  const start = src.indexOf(`ipcMain.handle('${channel}'`)
  assert(start >= 0, `未找到 ipcMain.handle('${channel}')`)
  const end = src.indexOf('\n  })', start)
  assert(end > start, `${channel} 处理函数体解析失败`)
  return src.slice(start, end)
}

/** 取 App.jsx 里某个顶层函数（普通或 async）的函数体 */
function functionBody(src, name) {
  const re = new RegExp(`(?:async )?function ${name}\\(`)
  const m = src.match(re)
  assert(m, `未找到 function ${name}(`)
  const start = m.index
  const end = src.indexOf('\n  }', start)
  assert(end > start, `${name} 函数体解析失败`)
  return src.slice(start, end)
}

async function round2Tests() {
  await test('accounts:switch（静态）：markUsed → refreshOne → refreshCheckins，异常不外抛，返回值不覆盖 ok', () => {
    const body = ipcHandlerBody(read('src/main/index.js'), 'accounts:switch')

    assert(/const res = await platforms\.switchAccount\(account, opts \|\| \{\}\)/.test(body), '未调用 switchAccount')
    const iSwitch = body.indexOf('platforms.switchAccount')
    const iMarkUsed = body.indexOf('store.markUsed(id)')
    const iRefresh = body.indexOf('scheduler.refreshOne(')
    const iCheckins = body.indexOf('scheduler.refreshCheckins(')
    assert(iMarkUsed > iSwitch, 'markUsed 必须在切号成功之后调用')
    assert(iRefresh > iMarkUsed, 'refreshOne 必须在 markUsed 之后')
    assert(iCheckins > iRefresh, 'refreshCheckins 必须在 refreshOne 之后')

    // 额度刷新异常必须转成 quota:{ok:false,error}，不能把成功的切号报成失败
    assert(/let quota = \{ ok: false, error: null \}/.test(body), 'quota 初值缺失')
    assert(/quota = \{ ok: Boolean\(r\.ok\), error: r\.ok \? null : r\.error \|\| '未知原因' \}/.test(body), '成功分支未包装 quota')
    const catchQuota = /catch \(e\) \{\s*quota = \{ ok: false, error: e\.message \}/.test(body)
    assert(catchQuota, 'refreshOne 抛错未被 try/catch 兜成 quota:{ok:false,error}')

    // 签到状态刷新失败只能 warn，不能影响返回值
    const checkinGuard = /try \{\s*await scheduler\.refreshCheckins\(\)\s*\} catch \(e\) \{\s*console\.warn\([^)]*e\.message\)/m
    assert(checkinGuard.test(body), 'refreshCheckins 未包在 try/catch + console.warn 里')

    assert(/return \{ \.\.\.res, quota \}/.test(body), '返回值不是 { ...res, quota }')
    assert(!/return \{ \.\.\.res,\s*ok:/.test(body), '返回值覆盖了 res.ok，会把成功切号报成失败')
    assert(!/console\.(log|error)\(/.test(body), '切号流程里出现了 console.log/error（应只 warn）')
    return '5 段结构 + 顺序断言通过'
  })

  await test('App.jsx 切号 toast：quota.ok === false 时追加「额度刷新失败」并标 warn', () => {
    const src = read('src/renderer/App.jsx')
    const body = functionBody(src, 'handleAction')
    assert(/const q = r && r\.quota/.test(body), '未读取 switch 返回的 quota')
    assert(/if \(q && q\.ok === false\) lines\.push\(`额度刷新失败：\$\{q\.error \|\| '未知原因'\}`\)/.test(body) ||
      /if \(q && q\.ok === false\)[\s\S]{0,80}额度刷新失败/.test(body), 'quota 失败时未追加「额度刷新失败」提示')
    assert(/q && q\.ok === false \? \{ tone: 'warn' \} : \{\}/.test(body) || /tone: 'warn'/.test(body), 'quota 失败时未标 warn 语气')
    // 主行必须仍报「已切换」，避免额度失败把切号成功掩盖掉
    assert(/已切换到 \$\{account\.name\}/.test(body), '主行未保留「已切换到 …」')
    return '提示文案 + 语气 + 主行保留'
  })

  await test('App.jsx runBatch（静态）：校验在 api.batchAccounts 之前，且早返回不清空选择', () => {
    const body = functionBody(read('src/renderer/App.jsx'), 'runBatch')
    const iGuard = body.indexOf("if (action === 'checkin')")
    const iSome = body.indexOf('accounts.some(')
    const iNotify = body.indexOf('所选账号所在平台均无签到接口')
    const iReturn = body.indexOf('return', iGuard)
    const iIpc = body.indexOf('api.batchAccounts(')
    const iClear = body.indexOf('setSelected(new Set())')

    assert(iGuard > 0, 'runBatch 里没有 action === checkin 的前置校验')
    assert(iSome > iGuard, '前置校验未用 accounts.some 判定 supportsCheckin')
    assert(iNotify > iSome, '前置校验未给出「所选账号所在平台均无签到接口」文案')
    assert(iReturn > iNotify && iReturn < iIpc, '前置校验的 return 必须早于 api.batchAccounts（即不发 IPC）')
    assert(iIpc > 0, '未调用 api.batchAccounts')
    assert(iClear > iIpc, '早返回场景下不应清空选择（setSelected 只应在批量请求之后）')
    assert(/platformMap\[a\.platform\]\.supportsCheckin/.test(body), '前置校验未按 supportsCheckin 判定')
    return '顺序：校验 → notify → return → （否则）IPC → 清空选择'
  })

  await test('App.jsx runBatch 前置校验（可执行）：把源码里的判定表达式抽出来真跑一遍', () => {
    const body = functionBody(read('src/renderer/App.jsx'), 'runBatch')
    // 抽取真实表达式：(a) => selected.has(a.id) && platformMap[a.platform] && platformMap[a.platform].supportsCheckin
    const m = body.match(/const anyCheckin = accounts\.some\(\s*([\s\S]*?)\s*\)\s*\n/)
    assert(m, '未能从 App.jsx 抽出 anyCheckin 判定表达式')
    const expr = m[1].trim()
    const evaluate = new Function('accounts', 'selected', 'platformMap', `return accounts.some(${expr})`)

    const accounts = [
      { id: 'trae:1', platform: 'trae' },
      { id: 'qoder:1', platform: 'qoder' },
      { id: 'dumate:1', platform: 'dumate' }
    ]
    const platformMap = {
      trae: { supportsCheckin: false },
      qoder: { supportsCheckin: false },
      dumate: { supportsCheckin: true }
    }
    const cases = [
      [new Set(['trae:1']), false, '只选无签到平台 → 应拦下（不发 IPC）'],
      [new Set(['trae:1', 'qoder:1']), false, '全选无签到平台 → 应拦下'],
      [new Set(['trae:1', 'dumate:1']), true, '混选（含可签到）→ 应放行'],
      [new Set(['dumate:1']), true, '只选可签到平台 → 应放行'],
      [new Set(), false, '空选择 → 不进入批量'],
      [new Set(['ghost:1']), false, '选中项不在 accounts 里 → 不崩且判为无']
    ]
    for (const [selected, expected, label] of cases) {
      const got = evaluate(accounts, selected, platformMap)
      assertEq(Boolean(got), expected, `表达式求值不符：${label}`)
    }
    // platformMap 缺该平台时不能抛错（注册表还没加载完的场景）
    assertEq(evaluate([{ id: 'x:1', platform: 'unknown' }], new Set(['x:1']), {}), false, 'platformMap 缺项时应判为 false')
    return `真实表达式 ${cases.length + 1} 组输入全部符合预期`
  })

  await test('App.jsx switchView：切视图/登录后统一清理 filter 与 selected', () => {
    const src = read('src/renderer/App.jsx')
    const body = functionBody(src, 'switchView')
    assert(/setView\(next\)/.test(body), 'switchView 未设置 view')
    assert(/setFilter\('all'\)/.test(body), 'switchView 未重置 filter')
    assert(/setSelected\(new Set\(\)\)/.test(body), 'switchView 未清空 selected')

    const sidebarCall = /onView=\{switchView\}/.test(src)
    assert(sidebarCall, 'Sidebar 的 onView 未接到 switchView')

    const loginBody = functionBody(src, 'login')
    assert(/switchView\(p\.id\)/.test(loginBody), 'login 成功后未走 switchView（选中态会跨视图残留）')
    assert(/if \(p\) switchView\(p\.id\)/.test(loginBody), 'login 里的 switchView 缺少平台存在性判断')

    // 不允许再出现「手写三连」：除了 switchView 定义处，其它地方不应直接调 setSelected(new Set())
    const inlineClears = (src.match(/setSelected\(new Set\(\)\)/g) || []).length
    assert(inlineClears <= 3, `setSelected(new Set()) 出现 ${inlineClears} 次，疑似又有手写清理绕过 switchView`)
    return 'switchView 为唯一入口（Sidebar + login）'
  })

  await test('Topbar（静态）：进度胶囊移到标题区、动作区只留按钮、平台页登录按钮文案正确', () => {
    const topbar = read('src/renderer/components/Topbar.jsx')
    const app = read('src/renderer/App.jsx')

    // 进度胶囊必须挂在 .title-sub 里（否则 1280 宽度下动作区挤成两行）
    const iTitleSub = topbar.indexOf('className="title-sub"')
    const iPill = topbar.indexOf('className="progress-pill"')
    const iActions = topbar.indexOf('className="top-actions"')
    assert(iTitleSub > 0 && iPill > 0 && iActions > 0, 'Topbar 结构解析失败')
    assert(iPill > iTitleSub && iPill < iActions, '进度胶囊不在标题区（.title-sub）内')

    // 动作区的关键交互不能被搬走或漏传
    assert(/onClick=\{onCheckinAll\}/.test(topbar), '签到按钮未接 onCheckinAll')
    assert(/disabled=\{busy \|\| pending <= 0\}/.test(topbar), '签到按钮未按 pending 禁用')
    assert(/canCheckin && \(/.test(topbar), '签到按钮未按 canCheckin 门控')
    assert(/onClick=\{onDetect\}/.test(topbar), '检测按钮未接 onDetect')
    assert(/onClick=\{onRefreshAll\}/.test(topbar), '刷新按钮未接 onRefreshAll')

    // 平台页登录按钮：文案已简化为「登录账号」，不应残留 `登录 {title} 账号` 模板
    assert(/登录账号\s*<\/button>/.test(topbar), '平台页登录按钮文案不是「登录账号」')
    assert(!/登录 \{title\} 账号/.test(topbar), '仍残留旧的 `登录 {title} 账号` 文案模板')
    assert(/LOGIN_HINT\[single\.loginMode\]/.test(topbar), '平台页登录按钮丢了 loginMode 提示')

    // App 侧三个新/旧 prop 都要传到位
    for (const prop of ['progress={progress}', 'pending={pending}', 'canCheckin={canCheckin}']) {
      assert(app.includes(prop), `App 未给 Topbar 传 ${prop}`)
    }
    return '胶囊在标题区 + 5 个交互接线 + 文案替换 + 3 个 prop'
  })
}

// ---------------------------------------------------------------- 13. 第三轮增量：签到账号锁 / AI_SHOT 开发开关

/**
 * 用替身（把真正会发请求的 checkinWithHeal / checkinStatusWithHeal 换掉）驱动真实 Scheduler，
 * 这样能验证「同一账号到底会不会被发两次」，又完全不碰网络。
 */
function makeSchedulerHarness(accountList) {
  const { Scheduler } = require(path.join(ROOT, 'src/main/scheduler'))
  const accounts = accountList.map((a) => ({ ...a }))
  const store = {
    get: (id) => accounts.find((a) => a.id === id) || null,
    list: () => accounts.slice(),
    upsert: () => {},
    getSettings: () => ({})
  }
  const events = []
  const sched = new Scheduler(store, (e) => events.push(e))
  const stats = { calls: 0, busy: 0 }
  sched.checkinWithHeal = async (account) => {
    stats.calls++
    await new Promise((r) => setTimeout(r, 60))
    return { ok: true, message: `签到成功 ${account.name}` }
  }
  // 真正实现会打签到状态接口，这里只回固定结构（不产生任何网络请求）
  sched.checkinStatusWithHeal = async () => ({ ok: true, supported: true, checkedIn: true, streakDays: 1 })
  // 定时刷新链路也依赖这个，避免 checkinAll 末端再次触网
  sched.refreshCheckins = async () => []
  return { sched, stats, events, accounts }
}

async function checkinLockTests() {
  const A = { id: 'dumate:lock-a', platform: 'dumate', platformLabel: 'DuMate', name: 'A' }
  const B = { id: 'dumate:lock-b', platform: 'dumate', platformLabel: 'DuMate', name: 'B' }
  const T = { id: 'trae:lock-t', platform: 'trae', platformLabel: 'Trae', name: 'T' }

  await test('账号锁：同账号并发签到只发一次，第二路拿 busy', async () => {
    const { sched, stats } = makeSchedulerHarness([A])
    const [r1, r2] = await Promise.all([sched.checkinOne(A.id), sched.checkinOne(A.id)])
    const oks = [r1, r2].filter((r) => r.ok === true)
    const busies = [r1, r2].filter((r) => r.busy === true)
    assertEq(stats.calls, 1, '同一账号并发时真实签到次数')
    assertEq(oks.length, 1, '应恰好 1 路成功')
    assertEq(busies.length, 1, '另一路应返回 busy')
    assert(/正在进行中/.test(busies[0].message), `busy 文案不可读：${busies[0].message}`)
    assertEq(sched.checkinInflight.size, 0, '结束后锁未释放')
    return `calls=${stats.calls}, oks=1, busy=1`
  })

  await test('账号锁：不同账号并发互不阻塞（各发一次）', async () => {
    const { sched, stats } = makeSchedulerHarness([A, B])
    const [r1, r2] = await Promise.all([sched.checkinOne(A.id), sched.checkinOne(B.id)])
    assertEq(stats.calls, 2, '两个账号应各签一次')
    assertEq(Boolean(r1.ok && r2.ok), true, '两个账号都应成功')
    assertEq(sched.checkinInflight.size, 0, '结束后锁未释放')
    return `calls=${stats.calls}`
  })

  await test('账号锁：worker 抛错后锁必须释放且可重试', async () => {
    const { sched, stats } = makeSchedulerHarness([A])
    const good = sched.checkinWithHeal
    sched.checkinWithHeal = async () => {
      stats.calls++
      throw new Error('模拟网络失败')
    }
    await assertRejects(() => sched.checkinOne(A.id), '首次签到应抛错', /模拟网络失败/)
    assertEq(sched.checkinInflight.size, 0, '抛错后锁未释放（会永久卡住该账号）')
    sched.checkinWithHeal = good
    const r = await sched.checkinOne(A.id)
    assertEq(r.ok, true, '锁释放后重试应成功')
    return '抛错→释放→重试成功'
  })

  await test('账号锁：checkinAll 串行签完所有账号，末端不出重复请求', async () => {
    const { sched, stats } = makeSchedulerHarness([A, B])
    const res = await sched.checkinAll()
    assertEq(res.ok, true, 'checkinAll 应返回 ok')
    assertEq(res.results.length, 2, 'checkinAll 结果条数')
    assertEq(stats.calls, 2, '每个账号各签一次')
    assertEq(sched.checkinRunning, false, 'checkinRunning 未复位')
    assertEq(sched.checkinInflight.size, 0, '结束后锁未释放')
    return `calls=${stats.calls}`
  })

  await test('账号锁：checkinAll 进行中插单卡签到 → 返回 busy，不产生第二次请求', async () => {
    const { sched, stats } = makeSchedulerHarness([A, B])
    const all = sched.checkinAll()
    // 等锁真正被占住再插队，避免时序抖动导致用例不稳定
    const t0 = Date.now()
    while (!sched.checkinInflight.has(A.id) && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert(sched.checkinInflight.has(A.id), '未观察到 checkinAll 持有账号锁')
    const single = await sched.checkinOne(A.id)
    assertEq(single.busy, true, '批量进行中插单卡签到应返回 busy')
    const res = await all
    assertEq(res.results.length, 2, '批量结果条数')
    assertEq(stats.calls, 2, '总请求数仍应是 2（插队那次不能真发）')
    assertEq(sched.checkinInflight.size, 0, '结束后锁未释放')
    return `插队 busy=true，总 calls=${stats.calls}`
  })

  await test('账号锁：checkinAll 进行中再点一次批量 → 全局闸返回 busy', async () => {
    const { sched, stats } = makeSchedulerHarness([A, B])
    const first = sched.checkinAll()
    const second = await sched.checkinAll()
    assertEq(second.busy, true, '第二轮批量应被 checkinRunning 挡下')
    assertEq(second.results.length, 0, '被挡下时不应有结果')
    assert(/已有签到任务在进行中/.test(second.message), `文案不可读：${second.message}`)
    await first
    assertEq(stats.calls, 2, '总请求数应为 2')
    return 'checkinRunning 闸生效'
  })

  await test('账号锁：不支持签到的平台不进锁、直接返回 supported:false', async () => {
    const { sched, stats } = makeSchedulerHarness([T])
    const r = await sched.checkinOne(T.id)
    assertEq(r.ok, false, 'trae 不支持签到应返回 ok:false')
    assertEq(r.supported, false, 'supported 应为 false')
    assertEq(stats.calls, 0, '不应调用签到实现')
    assertEq(sched.checkinInflight.size, 0, '不应留下锁')
    return '未触网、未加锁'
  })

  await test('AI_SHOT 开发开关（静态）：仅环境变量开启时截图，不暴露给 IPC/渲染层', () => {
    const mainIdx = read('src/main/index.js')
    const preload = read('src/main/preload.js')
    const app = read('src/renderer/App.jsx')

    assert(/async function captureSelfShot\(win, file\)/.test(mainIdx), '未找到 captureSelfShot')
    assert(/if \(process\.env\.AI_SHOT\)/.test(mainIdx), '未按 AI_SHOT 环境变量做门控')
    const gate = mainIdx.indexOf('if (process.env.AI_SHOT)')
    const call = mainIdx.indexOf('captureSelfShot(mainWindow, process.env.AI_SHOT)')
    assert(gate >= 0 && call > gate, 'captureSelfShot 的调用未包在门控内')
    assertEq((mainIdx.match(/capturePage\(/g) || []).length, 1, 'capturePage 只应在 captureSelfShot 内出现一次')
    assert(!/ipcMain\.handle\([^)]*capture/i.test(mainIdx), '截图能力不应暴露成 IPC')
    assert(!/AI_SHOT|capturePage/.test(preload), 'preload 不应出现截图相关代码')
    assert(!/AI_SHOT|capturePage/.test(app), '渲染层不应出现截图相关代码')
    assert(/finally \{[\s\S]{0,120}app\.quit\(\)/.test(mainIdx), 'captureSelfShot 应在 finally 里退出进程')
    // 生产路径不能有定时器：截图是 on-demand，不是轮询
    assert(!/setInterval\([^)]*capture/i.test(mainIdx), '不应对截图做轮询')
    return '门控 + 唯一调用点 + 无 IPC 暴露 + finally 退出'
  })

  await test('样式：本轮顶栏/统计块响应式调整已落地', () => {
    const css = read('src/renderer/styles.css')
    assert(/\.topbar\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '.topbar 未加 flex-wrap: wrap')
    assert(/@media\s*\(max-width:\s*1100px\)/.test(css), '缺少 max-width:1100px 的窄窗媒体查询')
    // 只约束「自适应」这一契约，不锁死具体像素（工程师从 126 调到 118，属纯视觉微调）
    const m = css.match(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\((\d+)px,\s*1fr\)\)/)
    assert(m, '统计块未使用 repeat(auto-fit, minmax(Npx, 1fr)) 自适应列')
    const px = Number(m[1])
    assert(px >= 100 && px <= 140, `统计块最小列宽 ${px}px 超出合理区间 100~140`)
    return `.topbar 换行 + 1100px 媒体查询 + 统计块 auto-fit ${px}px`
  })
}

// ---------------------------------------------------------------- 10. 批量 IPC 行为（子进程 + electron mock）

async function batchIpcTests() {
  await test('accounts:batch 行为：白名单/空 ids/坏 id/无签到平台/删除/进度事件', () => {
    const r = spawnSync(process.execPath, [__filename, '--batch-ipc'], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, AAM_TEST_NO_GUARD: '1' }
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
    assertEq(r.status, 0, `批量 IPC 子用例失败：\n${out.split('\n').slice(-12).join('\n')}`)
    const okLine = out.split('\n').find((l) => l.startsWith('BATCH_IPC_OK')) || 'BATCH_IPC_OK'
    return okLine.replace('BATCH_IPC_OK ', '')
  })
}

// ---------------------------------------------------------------- 11. 构建

async function buildTests() {
  await test('构建：vite build 成功且 dist/index.html 引用的产物存在、包含新 UI 代码', () => {
    const r = spawnSync('npx vite build', {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      timeout: 240000
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    assertEq(r.status, 0, `vite build 失败：\n${out.split('\n').slice(-10).join('\n')}`)

    const html = read('dist/index.html')
    const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1])
    assert(refs.length >= 2, `dist/index.html 只引用了 ${refs.length} 个产物`)
    for (const ref of refs) {
      const abs = path.join(ROOT, 'dist', ref)
      assert(fs.existsSync(abs), `dist/index.html 引用了不存在的文件：${ref}`)
    }
    const js = refs.find((x) => x.endsWith('.js'))
    const bundle = fs.readFileSync(path.join(ROOT, 'dist', js), 'utf8')
    for (const token of ['无签到活动', '批量签到', '上次使用', '签到本平台', '所选账号所在平台均无签到接口', '额度刷新失败']) {
      assert(bundle.includes(token), `产物中缺少本次新增文案「${token}」，可能是旧构建`)
    }
    const hashes = refs.map((x) => x.split('-').pop().split('.')[0])
    return `产物 ${refs.length} 个，hash ${hashes.join(' / ')}`
  })
}

// ---------------------------------------------------------------- 子模式：批量 IPC

async function runBatchIpcChild() {
  const Module = require('module')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-batch-ipc-'))
  const events = []
  const handlers = new Map()

  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false
      this.webContents = {
        send: (ch, data) => {
          if (ch === 'scheduler:event') events.push(data)
        },
        setWindowOpenHandler() {},
        once() {},
        on() {},
        openDevTools() {}
      }
    }
    loadFile() {}
    loadURL() {}
    isDestroyed() {
      return this.destroyed
    }
    isMinimized() {
      return false
    }
    restore() {}
    focus() {}
    on() {}
    static getAllWindows() {
      return []
    }
  }

  const electronMock = {
    app: {
      requestSingleInstanceLock: () => true,
      getPath: () => tmpDir,
      getVersion: () => '33.0.0',
      whenReady: () => Promise.resolve(),
      on() {},
      quit() {},
      isPackaged: false
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler() {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) },
    session: { defaultSession: { setProxy: () => Promise.resolve(), webRequest: { onBeforeRequest() {} } } },
    shell: { openExternal() {} },
    net: {}
  }

  // 种子仓库：真实 dumate 账号 + 一个不支持签到的 trae 账号 + 一个待删除的 dumate 账号
  const dumateMod = require(path.join(ROOT, 'src/main/platforms/dumate'))
  const live = (await dumateMod.detectAccounts('dumate')).filter(Boolean)[0]
  const traeAcc = {
    id: 'trae:test-unsupported',
    platform: 'trae',
    platformLabel: 'Trae 国际版',
    name: '测试-无签到平台',
    email: null,
    uid: 'test-unsupported',
    plan: null,
    isCurrent: true,
    snapshot: {},
    updatedAt: Date.now()
  }
  const removable = {
    id: 'dumate:test-remove-me',
    platform: 'dumate',
    platformLabel: 'DuMate 国内版',
    name: '测试-待删除',
    email: null,
    uid: 'test-remove-me',
    plan: null,
    isCurrent: false,
    snapshot: { profileId: 'test-profile', cookies: [] },
    updatedAt: Date.now()
  }
  // 故意放一个平台未注册的账号：用真实适配器异常验证「单条失败不阻断后续」
  const brokenAcc = {
    id: 'nope:test-broken',
    platform: 'nope',
    platformLabel: '未知平台',
    name: '测试-适配器会抛错',
    email: null,
    uid: 'test-broken',
    plan: null,
    isCurrent: false,
    snapshot: {},
    updatedAt: Date.now()
  }
  fs.writeFileSync(
    path.join(tmpDir, 'accounts.json'),
    JSON.stringify({ version: 1, accounts: [live, traeAcc, removable, brokenAcc], settings: {} }, null, 2),
    'utf8'
  )

  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock
    return origLoad.apply(this, arguments)
  }
  let loadErr = null
  try {
    require(path.join(ROOT, 'src/main/index.js'))
  } catch (e) {
    loadErr = e
  } finally {
    Module._load = origLoad
  }
  if (loadErr) {
    console.error('BATCH_IPC_FAIL 无法加载主进程:', loadErr.message)
    process.exit(1)
  }

  await new Promise((r) => setTimeout(r, 150))

  const fail = (msg) => {
    console.error('BATCH_IPC_FAIL ' + msg)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
    process.exit(1)
  }

  const batch = handlers.get('accounts:batch')
  if (typeof batch !== 'function') fail('accounts:batch 未注册')

  // 1) 未知 action 必须抛错
  let threw = null
  try {
    await batch({}, { action: 'drop-database', ids: [live.id] })
  } catch (e) {
    threw = e
  }
  if (!threw) fail('未知 action 未抛错')
  if (!/未知批量操作/.test(threw.message)) fail(`未知 action 报错不可读：${threw.message}`)

  // 2) ids 为空：不执行、不抛错、results 为空数组
  const empty = await batch({}, { action: 'refresh', ids: [] })
  if (!empty || empty.ok !== true || !Array.isArray(empty.results) || empty.results.length !== 0) {
    fail(`ids 为空时返回异常：${JSON.stringify(empty)}`)
  }

  // 3) 好 id + 适配器抛错 id + 坏 id 混排：单条失败不阻断后续，字段统一
  events.length = 0
  const mixed = await batch({}, { action: 'refresh', ids: [live.id, brokenAcc.id, 'ghost-id'] })
  if (mixed.results.length !== 3) fail(`混排结果条数错误：${mixed.results.length}`)
  const [r0, r1, r2] = mixed.results
  if (r0.id !== live.id || r0.ok !== true || r0.message !== '额度已更新') fail(`真实账号刷新结果异常：${JSON.stringify(r0)}`)
  if (r1.ok !== false || !/未知平台/.test(String(r1.error))) fail(`适配器抛错的账号未被兜住：${JSON.stringify(r1)}`)
  if (r2.ok !== false || r2.error !== '账号不存在') fail(`坏 id 结果异常：${JSON.stringify(r2)}`)
  for (const r of mixed.results) {
    if (typeof r.id !== 'string' || typeof r.name !== 'string') fail('结果缺少 id/name 字段')
    if (!('ok' in r)) fail('结果缺少 ok 字段')
  }
  const batchEvents = events.filter((e) => e.type === 'batch-progress')
  if (batchEvents.length !== 3) fail(`batch-progress 事件数应为 3，实际 ${batchEvents.length}`)
  if (!batchEvents.every((e, i) => e.done === i + 1 && e.total === 3 && e.action === 'refresh')) {
    fail(`batch-progress 字段异常：${JSON.stringify(batchEvents)}`)
  }

  // 4) 批量签到：不支持签到的平台必须逐条标注且不调用适配器（不会产生真实签到）
  const ck = await batch({}, { action: 'checkin', ids: [traeAcc.id] })
  if (ck.results.length !== 1) fail('批量签到结果条数错误')
  if (ck.results[0].ok !== false) fail('无签到平台不应返回 ok:true')
  if (!/该平台无签到接口/.test(String(ck.results[0].message))) fail(`无签到平台未标注原因：${JSON.stringify(ck.results[0])}`)

  // 5) 批量删除：删掉后列表里不再有
  const del = await batch({}, { action: 'remove', ids: [removable.id] })
  if (del.results[0].ok !== true || del.results[0].message !== '已删除') fail(`删除结果异常：${JSON.stringify(del.results[0])}`)
  const after = await handlers.get('accounts:list')()
  if (after.some((a) => a.id === removable.id)) fail('删除后账号仍在列表中')

  // 6) 删除不存在的账号：ok:false 且不影响已返回的结果结构
  const del2 = await batch({}, { action: 'remove', ids: [removable.id] })
  if (del2.results[0].ok !== false) fail('重复删除应返回 ok:false')
  if (!/账号不存在/.test(String(del2.results[0].error))) fail('重复删除的 error 不可读')

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  console.log(`BATCH_IPC_OK 6 组用例通过（含适配器抛错兜底；进度事件 ${batchEvents.length} 条逐条发出）`)
  process.exit(0)
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (ARGS.has('--batch-ipc')) return runBatchIpcChild()

  pinAtStart = pinSources()

  await envTests()
  await detectTests()
  await quotaTests()
  await checkinStatusTests()
  await applyDryRunTests()
  await exeTests()
  await registryTests()
  await syntaxTests()
  await staticTests()
  await round2Tests()
  await checkinLockTests()
  await batchIpcTests()
  if (WITH_BUILD) await buildTests()

  // 最终护栏：全程不允许出现真实签到 POST
  await test('护栏：整轮测试未发出任何签到 POST 请求', async () => {
    const posts = countCheckinPosts()
    assertEq(posts, 0, `出现了 ${posts} 次签到 POST`)
    return `共 ${netLog.length} 次请求，POST /loginBonus ${posts} 次`
  })

  // 最终护栏：本轮结论对应的就是磁盘上这一版源码（防止编辑器在测试期间改动）
  await test('护栏：测试期间源码未被改动（指纹与本轮开始时一致）', async () => {
    const now = pinSources()
    const changed = PIN_FILES.filter((rel) => now[rel] !== pinAtStart[rel])
    assertEq(changed.length, 0, `测试期间以下文件被改动，本轮结论作废，需重跑：${changed.join('、')}`)
    return `${PIN_FILES.length} 个文件指纹稳定`
  })

  const failed = results.filter((r) => !r.ok)
  const width = Math.max(...results.map((r) => r.name.length)) + 2

  console.log('\n=== DuMate / 注册表 / 批量 IPC 测试用例 ===\n')
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL'
    const pad = ' '.repeat(Math.max(0, width - r.name.length))
    console.log(`[${mark}] ${r.name}${pad} ${String(r.ms).padStart(5)}ms  ${r.note}`)
  }

  const total = results.length
  const passed = total - failed.length
  console.log(`\n合计 ${total} 条：通过 ${passed}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('\n失败明细：')
    for (const f of failed) console.log(` - ${f.name}\n   ${f.note}`)
  }
  console.log(`\nROUTE: ${failed.length === 0 ? 'NoOne' : '见失败明细'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试脚本自身异常：', e && e.stack ? e.stack : e)
  process.exit(1)
})
