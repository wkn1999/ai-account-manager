'use strict'
// 通用工具：路径解析、Trae ByteCrypto 加解密、Windows DPAPI、进程与启动

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, execFile } = require('child_process')

// ---------------- 路径 ----------------
const ENV = {
  APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  USERPROFILE: process.env.USERPROFILE || os.homedir()
}

function appDataDir(...p) {
  return path.join(ENV.APPDATA, ...p)
}
function localAppDataDir(...p) {
  return path.join(ENV.LOCALAPPDATA, ...p)
}
function homeDir(...p) {
  return path.join(ENV.USERPROFILE, ...p)
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function readJson(p) {
  try {
    const text = fs.readFileSync(p, 'utf8')
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function writeJsonAtomic(p, value) {
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = p + '.tmp' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

/** 覆盖客户端登录态前留一份 .bak：写坏时这是唯一能恢复原账号的手段 */
function backupFile(p) {
  try {
    if (!fs.existsSync(p)) return false
    fs.copyFileSync(p, p + '.bak')
    return true
  } catch {
    // 备份失败不应阻断用户主动的切号操作
    return false
  }
}

// ---------------- Trae ByteCrypto ----------------
const SALT_A = [
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155,
  47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76,
  149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37
]
const SALT_B = [
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181,
  74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235,
  187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125
]
const PREFIX_AES = Buffer.from([116, 99, 5, 16, 0, 0])

function sha512(buf) {
  return crypto.createHash('sha512').update(buf).digest()
}

function byteCryptoSalt() {
  const s = Buffer.alloc(64)
  for (let i = 0; i < 64; i++) s[i] = SALT_A[i] ^ SALT_B[i]
  return s
}

function byteCryptoDerive(keyMaterial) {
  const merge = Buffer.concat([sha512(keyMaterial), byteCryptoSalt()])
  const h = sha512(merge)
  return { key: h.subarray(0, 16), iv: h.subarray(16, 32) }
}

/** 加密为 Trae ByteCrypto(版本 AES) 字节串 */
function byteCryptoEncrypt(plaintext) {
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  const randomKey = crypto.randomBytes(32)
  const { key, iv } = byteCryptoDerive(randomKey)
  const payload = Buffer.concat([sha512(buf), buf])
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([PREFIX_AES, randomKey, enc])
}

/** 解密 Trae ByteCrypto 字节串，失败返回 null */
function byteCryptoDecrypt(raw) {
  if (!Buffer.isBuffer(raw) || raw.length <= 38) return null
  if (!raw.subarray(0, 6).equals(PREFIX_AES)) return null
  const randomKey = raw.subarray(6, 38)
  const ct = raw.subarray(38)
  if (ct.length === 0 || ct.length % 16 !== 0) return null
  try {
    const { key, iv } = byteCryptoDerive(randomKey)
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    const out = Buffer.concat([decipher.update(ct), decipher.final()])
    if (out.length < 64) return null
    if (!sha512(out.subarray(64)).equals(out.subarray(0, 64))) return null
    return out.subarray(64)
  } catch {
    return null
  }
}

/** 尝试把 storage.json 中的值解析为 JSON 对象（兼容明文 JSON 与 ByteCrypto 密文） */
function parseIcubeValue(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      /* fallthrough */
    }
  }
  try {
    const dec = byteCryptoDecrypt(Buffer.from(trimmed, 'base64'))
    if (dec) return JSON.parse(dec.toString('utf8'))
  } catch {
    /* ignore */
  }
  return null
}

/** 将 JSON 对象编码为 Trae storage.json 需要的密文字符串 */
function encodeIcubeValue(obj) {
  return byteCryptoEncrypt(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64')
}

// ---------------- Windows DPAPI ----------------
function dpapiUnprotect(dpapiBlob) {
  const b64 = Buffer.isBuffer(dpapiBlob) ? dpapiBlob.toString('base64') : String(dpapiBlob)
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$ErrorActionPreference='Stop';" +
    `$b=[Convert]::FromBase64String('${b64}');` +
    '$r=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Convert]::ToBase64String($r)'
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  )
  return Buffer.from(out.trim(), 'base64')
}

function dpapiProtect(plainBuf) {
  const b64 = Buffer.isBuffer(plainBuf) ? plainBuf.toString('base64') : String(plainBuf)
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$ErrorActionPreference='Stop';" +
    `$b=[Convert]::FromBase64String('${b64}');` +
    '$r=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Convert]::ToBase64String($r)'
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  )
  return Buffer.from(out.trim(), 'base64')
}

// ---------------- 进程 ----------------
function isProcessRunning(exeName) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000
    })
    return out.toLowerCase().includes(exeName.toLowerCase())
  } catch {
    return false
  }
}

function killProcess(exeName) {
  try {
    execFileSync('taskkill', ['/F', '/IM', exeName, '/T'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    })
    return true
  } catch {
    return false
  }
}

function launchApp(exePath, args = []) {
  const child = execFile(exePath, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

module.exports = {
  ENV,
  appDataDir,
  localAppDataDir,
  homeDir,
  exists,
  readJson,
  writeJsonAtomic,
  backupFile,
  sha512,
  byteCryptoEncrypt,
  byteCryptoDecrypt,
  parseIcubeValue,
  encodeIcubeValue,
  dpapiUnprotect,
  dpapiProtect,
  isProcessRunning,
  killProcess,
  launchApp,
  sleep,
  crypto
}
