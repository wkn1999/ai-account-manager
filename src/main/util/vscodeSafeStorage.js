'use strict'
// 读取 Chromium / VS Code 系（Electron）应用的 safeStorage 加密数据
// 格式：Local State 的 os_crypt.encrypted_key（base64("DPAPI"+blob)）→ DPAPI 解出 32 字节 AES key
// 密文格式：b"v10" + 12 字节 nonce + AES-256-GCM(ciphertext+tag)

const crypto = require('crypto')
const fs = require('fs')
const { readJson, dpapiUnprotect, dpapiProtect } = require('./core')

// 每次 DPAPI 解主密钥都要 spawn 一次 PowerShell（约 0.5s），检测/刷新时按文件修改时间复用
const masterKeyCache = new Map()

/** 从 Local State 文件取出 32 字节主密钥 */
function loadMasterKey(localStatePath) {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(localStatePath).mtimeMs
  } catch {
    /* 文件缺失时交给 readMasterKey 抛出原有错误 */
  }
  const hit = masterKeyCache.get(localStatePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.key
  const key = readMasterKey(localStatePath)
  masterKeyCache.set(localStatePath, { key, mtimeMs })
  return key
}

function readMasterKey(localStatePath) {
  const state = readJson(localStatePath)
  if (!state || !state.os_crypt || !state.os_crypt.encrypted_key) {
    throw new Error('Local State 中未找到 os_crypt.encrypted_key')
  }
  const raw = Buffer.from(state.os_crypt.encrypted_key, 'base64')
  // 前 5 字节为 "DPAPI" 标识
  const blob = raw.subarray(0, 5).toString('utf8') === 'DPAPI' ? raw.subarray(5) : raw
  return dpapiUnprotect(blob)
}

function decryptV10(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 15) throw new Error('密文过短')
  if (buf.subarray(0, 3).toString('utf8') !== 'v10') throw new Error('不是 v10 密文')
  const nonce = buf.subarray(3, 15)
  const data = buf.subarray(15)
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(0, data.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function encryptV10(key, plainBuf) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from('v10', 'utf8'), nonce, enc, tag])
}

/** 部分应用把密文存成 {"type":"Buffer","data":[...]} */
function bufferFromJsonValue(value) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') {
    const t = value.trim()
    if (t.startsWith('{')) {
      try {
        const j = JSON.parse(t)
        if (j && j.type === 'Buffer' && Array.isArray(j.data)) return Buffer.from(j.data)
      } catch {
        /* ignore */
      }
    }
    return Buffer.from(value, 'base64')
  }
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data)
  return null
}

function tryDecrypt(key, buf) {
  try {
    return decryptV10(key, buf)
  } catch {
    return null
  }
}

module.exports = { loadMasterKey, decryptV10, encryptV10, bufferFromJsonValue, tryDecrypt }
