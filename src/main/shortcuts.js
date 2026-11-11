'use strict'
// 桌面快捷方式：只用 Electron 自带 shell.readShortcutLink / writeShortcutLink
// 为什么：本机安全策略会拦截 PowerShell COM(WScript.Shell)，不能用它读写 .lnk；
//        Electron 这两个 API 只在 Windows/macOS 有效，其它平台给可读错误而不是崩。

const fs = require('fs')
const path = require('path')
const { exists } = require('./util/core')
const { appPaths } = require('./util/vscdb')

const DEFAULT_NAME = 'AI账号管家'
const OPERATIONS = ['create', 'update', 'replace']

function electronParts() {
  try {
    const electron = require('electron')
    if (electron && typeof electron === 'object') {
      return { app: electron.app || null, shell: electron.shell || null }
    }
  } catch {
    // 纯 Node 自检没有 electron API，用只读兜底解析
  }
  return { app: null, shell: null }
}

function shortcutSupported() {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function sanitizeName(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.lnk$/i, '')
    .trim()
  return clean || DEFAULT_NAME
}

function shortcutPath(name) {
  return path.join(appPaths().desktop, `${sanitizeName(name)}.lnk`)
}

/**
 * 纯 Node（无 Electron shell API）时的只读兜底：解析 .lnk 里内嵌的目标路径。
 * 为什么：scripts/vault-probe.js 要在不启动 Electron 的情况下列出「桌面快捷方式当前指向」。
 */
function readLnkTarget(file) {
  try {
    const buf = fs.readFileSync(file)
    const flags = buf.length >= 24 ? buf.readUInt32LE(20) : 0
    const unicodeRe = /[A-Za-z]:[\\/][A-Za-z0-9\\/._\-\u4e00-\u9fa5 ]{2,240}?\.exe/gi
    const isUnicode = (flags & 0x80) !== 0
    const scanExe = (text) => {
      const matched = String(text || '').match(new RegExp(unicodeRe.source, 'gi'))
      if (!matched || !matched.length) return null
      return matched.sort((a, b) => b.length - a.length)[0].trim()
    }
    // ICON_LOCATION 常写成「路径.exe,0」，需剥掉 iconIndex；WORKING_DIR 是目录，不能当目标
    const cleanExe = (text) => {
      let s = String(text || '').trim()
      s = s.replace(/^["']+/, '').replace(/["']+$/, '')
      s = s.replace(/,\s*\d+\s*$/, '').trim()
      if (!/\.exe$/i.test(s) || !/[A-Za-z]:[\\/]/.test(s)) return null
      return s
    }
    // ShellLinkHeader 固定 76 字节，之后依次是 IDList、LinkInfo、StringData。
    // IsUnicode 是 bit7(0x80)，bit2(0x4) 是 HasName；从 0 偏移解码整个 buffer 会因
    // StringData 落在奇数偏移而 UTF-16 字节对错位，所以每条字符串都要从自身 0 偏移独立切片解码。
    let idListEnd = 76
    let linkInfoSize = 0
    let strOff = 76
    let structuredOk = buf.length >= 76
    if (structuredOk && (flags & 1)) {
      if (buf.length < 78) structuredOk = false
      else {
        idListEnd = 76 + 2 + buf.readUInt16LE(76)
        strOff = idListEnd
      }
    }
    if (structuredOk && (flags & 2)) {
      if (buf.length < strOff + 4) structuredOk = false
      else {
        linkInfoSize = buf.readUInt32LE(strOff)
        strOff += linkInfoSize
      }
    }
    if (strOff < 0 || strOff > buf.length) structuredOk = false

    // 1) 结构化 StringData：按 NAME → RELATIVE_PATH → WORKING_DIR → ARGS → ICON_LOCATION 顺序逐条读
    if (structuredOk) {
      const fields = [
        [0x4, 'name'],
        [0x8, 'relativePath'],
        [0x10, 'workingDir'],
        [0x20, 'args'],
        [0x40, 'iconLocation']
      ]
      const unit = isUnicode ? 2 : 1
      const encoding = isUnicode ? 'utf16le' : 'latin1'
      const found = []
      let cursor = strOff
      for (const [bit, label] of fields) {
        if (!(flags & bit)) continue
        if (cursor + 2 > buf.length) break
        const count = buf.readUInt16LE(cursor)
        cursor += 2
        const byteLen = count * unit
        if (byteLen < 0 || cursor + byteLen > buf.length) break
        const text = buf.slice(cursor, cursor + byteLen).toString(encoding)
        cursor += byteLen
        if (label !== 'workingDir') {
          const hit = cleanExe(text)
          if (hit) found.push({ label, text: hit })
        }
      }
      for (const label of ['iconLocation', 'relativePath', 'args', 'name']) {
        const hit = found.find((item) => item.label === label)
        if (hit) return hit.text
      }
      // 逐条没命中时整体解码 StringData 区域再扫一次（区域从自身 0 偏移起，天然对齐）
      const regionHit = cleanExe(scanExe(buf.slice(strOff).toString(encoding)))
      if (regionHit) return regionHit
    }

    // 2) 双对齐兜底：shift=0 / shift=1 各解码一遍，覆盖任意奇数偏移与非标准结构
    for (const shift of [0, 1]) {
      const hit = cleanExe(scanExe(buf.slice(shift).toString('utf16le')))
      if (hit) return hit
    }

    // 3) LinkInfo 的 ANSI LocalBasePath + CommonPathSuffix
    if ((flags & 2) && linkInfoSize > 28 && buf.length >= idListEnd + 28) {
      const baseOff = buf.readUInt32LE(idListEnd + 16)
      const suffixOff = buf.readUInt32LE(idListEnd + 24)
      if (linkInfoSize <= buf.length - idListEnd) {
        const readCString = (start) => {
          let end = start
          while (end < buf.length && end < idListEnd + linkInfoSize && buf[end] !== 0) end++
          return buf.slice(start, end)
        }
        const base = readCString(idListEnd + baseOff)
        const suffix = readCString(idListEnd + suffixOff)
        const ansi = Buffer.concat([base, suffix]).toString('latin1').trim()
        const hit = cleanExe(ansi)
        if (hit) return hit
      }
    }

    // 4) 最后按 ANSI 扫全 buffer，仍读不到就返回 null
    return cleanExe(scanExe(buf.toString('latin1')))
  } catch {
    return null
  }
}

/** 读不到时字段给 null，不抛；supported 说明当前系统是否具备 .lnk 读写能力 */
function getShortcut(options = {}) {
  const opts = options || {}
  const name = sanitizeName(opts.name || DEFAULT_NAME)
  const file = shortcutPath(name)
  const paths = appPaths()
  const base = {
    exists: exists(file),
    path: file,
    name,
    target: null,
    args: null,
    cwd: null,
    icon: null,
    description: null,
    appExe: paths.appExe,
    desktopDir: paths.desktop,
    supported: shortcutSupported()
  }
  if (!base.exists) return base
  const { shell } = electronParts()
  if (shell && typeof shell.readShortcutLink === 'function') {
    try {
      const link = shell.readShortcutLink(file) || {}
      return {
        ...base,
        target: link.target || null,
        args: link.args || null,
        cwd: link.cwd || null,
        icon: link.icon || null,
        description: link.description || null
      }
    } catch {
      // 读失败落到字段为 null 的结果，不把异常抛给渲染层
    }
  }
  return { ...base, target: readLnkTarget(file) }
}

function setShortcut(options = {}) {
  const opts = options || {}
  if (!shortcutSupported()) {
    throw new Error('桌面快捷方式读写仅支持 Windows / macOS，当前系统不支持')
  }
  const { shell } = electronParts()
  if (!shell || typeof shell.writeShortcutLink !== 'function') {
    throw new Error('当前环境没有可用的快捷方式 API，请在 Electron 主进程内调用')
  }
  const name = sanitizeName(opts.name || DEFAULT_NAME)
  const target = String(opts.target || appPaths().appExe)
  const icon = String(opts.icon || target)
  const file = shortcutPath(name)
  // 目标不存在时拒绝：写一个指向空路径的快捷方式只会让用户点开报错
  if (!exists(target)) throw new Error(`快捷方式目标不存在：${target}，请检查 target 参数`)
  const operation = OPERATIONS.includes(String(opts.operation)) ? String(opts.operation) : 'replace'
  const link = {
    target,
    cwd: opts.cwd ? String(opts.cwd) : path.dirname(target),
    args: opts.args ? String(opts.args) : '',
    description: opts.description ? String(opts.description) : DEFAULT_NAME,
    icon,
    iconIndex: 0
  }
  let ok = false
  try {
    ok = shell.writeShortcutLink(file, operation, link)
  } catch (e) {
    throw new Error(`写入快捷方式失败：${e.message}`)
  }
  if (!ok) throw new Error('写入快捷方式失败：系统未接受该快捷方式，请检查路径与权限')
  return { ok: true, path: file }
}

function removeShortcut(options = {}) {
  const opts = options || {}
  const name = sanitizeName(opts.name || DEFAULT_NAME)
  const file = shortcutPath(name)
  if (!exists(file)) {
    return { ok: true, removed: false, path: file, message: '快捷方式本就不存在，无需删除' }
  }
  try {
    fs.unlinkSync(file)
  } catch (e) {
    throw new Error(`删除快捷方式失败：${e.message}`)
  }
  return { ok: true, removed: true, path: file, message: '快捷方式已删除' }
}

module.exports = {
  DEFAULT_NAME,
  shortcutPath,
  getShortcut,
  setShortcut,
  removeShortcut
}
