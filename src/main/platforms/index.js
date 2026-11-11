'use strict'
// 平台注册表：统一对外提供 检测 / 导入 / 切号 / 额度 / 签到 能力

const trae = require('./trae')
const qoder = require('./qoder')
const codebuddy = require('./codebuddy')
const workbuddy = require('./workbuddy')
const dumate = require('./dumate')
const codex = require('./codex')
const { launchApp } = require('../util/core')

const SPECS = [
  { adapter: trae, variants: trae.variants },
  // qoder-cn 的签到能力位声明在 qoder.VARIANTS['qoder-cn'].checkin 上（注册表读的就是它），
  // 国际版 qoder 仍为 false：签到端点未验证，不能在卡片上放出点了没反应的按钮
  { adapter: qoder, variants: qoder.variants },
  { adapter: codebuddy, variants: codebuddy.variants },
  { adapter: workbuddy, variants: workbuddy.variants },
  { adapter: dumate, variants: dumate.variants },
  { adapter: codex, variants: codex.variants }
]

const registry = {}
for (const spec of SPECS) {
  for (const variant of spec.variants) {
    registry[variant] = { adapter: spec.adapter, variant, meta: spec.adapter.VARIANTS[variant] }
  }
}

/**
 * 签到能力按 variant 显式声明：同一家的国际版 / 国内版开放情况不同，
 * 靠 region 猜会让国际版卡片上出现一个点了没反应的按钮。
 */
function supportsCheckin(platform) {
  const entry = registry[platform]
  if (!entry) return false
  return Boolean(entry.adapter.checkin) && entry.meta.checkin === true && !entry.meta.readOnly
}

function supportsCheckinStatus(platform) {
  const entry = registry[platform]
  if (!entry) return false
  return Boolean(entry.adapter.checkinStatus) && entry.meta.checkin === true && !entry.meta.readOnly
}

function listPlatforms() {
  return Object.entries(registry).map(([id, { meta, adapter }]) => {
    const row = {
      id,
      label: meta.label,
      region: meta.region || null,
      // 可选字段：有的平台只有一个地区版本，界面上不需要再拼「国际/国内」
      regionLabel: meta.regionLabel || null,
      readOnly: Boolean(meta.readOnly || adapter.readOnly),
      supportsCheckin: supportsCheckin(id),
      supportsCheckinStatus: supportsCheckinStatus(id),
      multiAccount: Boolean(adapter.detectAccounts),
      loginMode: adapter.loginInteractive ? 'oauth' : adapter.findExe ? 'client' : 'none'
    }
    // 只在变体声明了签到说明时带出该字段，其余平台返回对象保持一字不变
    if (meta.checkinNote) row.checkinNote = meta.checkinNote
    return row
  })
}

/** 检测本机所有平台的登录账号；支持多 profile 的平台一次返回全部 */
async function detectAll() {
  const results = []
  for (const [id, { adapter }] of Object.entries(registry)) {
    try {
      const found = adapter.detectAccounts ? await adapter.detectAccounts(id) : [await adapter.detectCurrent(id)]
      for (const acc of found) if (acc) results.push(acc)
    } catch (e) {
      results.push({ platform: id, error: e.message, detectFailed: true })
    }
  }
  return results
}

/** 导入当前登录态为账号（返回归一化账号对象） */
async function importCurrent(platform) {
  const entry = registry[platform]
  if (!entry) throw new Error('未知平台: ' + platform)
  const acc = await entry.adapter.detectCurrent(platform)
  if (!acc) throw new Error('未在该平台检测到登录态')
  return acc
}

/** 导入一个平台的全部本机账号（DuMate 这类原生多 profile 的客户端） */
async function importAll(platform) {
  const entry = registry[platform]
  if (!entry) throw new Error('未知平台: ' + platform)
  if (!entry.adapter.detectAccounts) return [await importCurrent(platform)]
  const list = (await entry.adapter.detectAccounts(platform)).filter(Boolean)
  if (list.length === 0) throw new Error('未在该平台检测到登录态')
  return list
}

async function switchAccount(account, opts) {
  const entry = registry[account.platform]
  if (!entry) throw new Error('未知平台: ' + account.platform)
  return entry.adapter.applyAccount(account, opts)
}

async function refreshQuota(account) {
  const entry = registry[account.platform]
  if (!entry) throw new Error('未知平台: ' + account.platform)
  return entry.adapter.fetchQuota(account)
}

async function checkin(account) {
  const entry = registry[account.platform]
  if (!entry) throw new Error('未知平台: ' + account.platform)
  if (!supportsCheckin(account.platform)) return { ok: false, supported: false, message: '该平台不支持签到' }
  return entry.adapter.checkin(account)
}

/** 读取今日签到状态；平台没有该接口时返回 supported:false，不当作错误 */
async function checkinStatus(account) {
  const entry = registry[account.platform]
  if (!entry) throw new Error('未知平台: ' + account.platform)
  if (!supportsCheckinStatus(account.platform)) {
    return { ok: true, supported: false, message: '该平台未提供签到接口' }
  }
  try {
    return await entry.adapter.checkinStatus(account)
  } catch (e) {
    return { ok: false, supported: true, message: e.message }
  }
}

/**
 * 登录一个新账号。
 * ChatGPT 走应用内 OAuth，其余平台只能把客户端拉起来让用户自己登录 —— 我们没有它的登录协议。
 */
async function login(platform, onUrl) {
  const entry = registry[platform]
  if (!entry) throw new Error('未知平台: ' + platform)
  if (entry.adapter.loginInteractive) {
    const acc = await entry.adapter.loginInteractive(platform, onUrl)
    return { mode: 'oauth', account: acc }
  }
  if (!entry.adapter.findExe) throw new Error('该平台不支持在本应用登录')
  const exe = entry.adapter.findExe(entry.meta)
  if (!exe) throw new Error(`没有检测到 ${entry.meta.label} 客户端，请先安装再登录`)
  launchApp(exe)
  return {
    mode: 'client',
    message: `已启动 ${entry.meta.label}，请在客户端完成登录，检测到新账号后会自动导入`
  }
}

module.exports = {
  registry,
  listPlatforms,
  supportsCheckin,
  supportsCheckinStatus,
  detectAll,
  importCurrent,
  importAll,
  switchAccount,
  refreshQuota,
  checkin,
  checkinStatus,
  login
}
