'use strict'
// WorkBuddy 桌面端适配器（受限支持）
// 登录态：~/.workbuddy/**，其中 workbuddy-desktop.info / keyblob 由 WorkBuddy 自带
// Electron 私有 native 绑定（atRestSecretKey）加密，外部进程无法解密。
// 因此本适配器仅读取明文身份快照，不提供切号与签到。

const fs = require('fs')
const path = require('path')
const { homeDir, readJson } = require('../util/core')

const VARIANTS = {
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy（国内）',
    region: 'cn',
    readOnly: true
  }
}

function snapshotPath() {
  return homeDir('.workbuddy', 'storage', 'skeleton', 'account-snapshot.json')
}

function detectCurrent() {
  const p = snapshotPath()
  if (!fs.existsSync(p)) return null
  const data = readJson(p)
  const primary = data && data.primary
  if (!primary) return null
  return {
    id: `workbuddy:${primary.uid || 'unknown'}`,
    platform: 'workbuddy',
    platformLabel: VARIANTS.workbuddy.label,
    region: 'cn',
    name: primary.nickname || primary.uid,
    email: null,
    uid: primary.uid || null,
    plan: primary.isPro ? 'Pro' : primary.editionType || null,
    snapshot: { primary },
    readOnly: true,
    updatedAt: Date.now()
  }
}

async function applyAccount() {
  throw new Error('WorkBuddy 桌面端登录态使用其私有密钥加密，暂不支持外部切号')
}

async function fetchQuota() {
  return { plan: null, summary: null, items: [], message: 'WorkBuddy 额度需在客户端内查看' }
}

async function checkin() {
  return { ok: false, supported: false, message: 'WorkBuddy 签到依赖其私有登录态，暂不支持' }
}

module.exports = {
  VARIANTS,
  variants: Object.keys(VARIANTS),
  snapshotPath,
  detectCurrent,
  applyAccount,
  fetchQuota,
  checkin
}
