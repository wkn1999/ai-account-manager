'use strict'
// 账号仓库：多账号存储、当前账号标记、标签等
// 支持使用 Electron safeStorage 加密落盘（若调用方注入）

const fs = require('fs')
const path = require('path')

class AccountStore {
  /**
   * @param {string} dir 数据目录
   * @param {{encrypt?: (s:string)=>Buffer, decrypt?: (b:Buffer)=>string}} [safeStorage]
   */
  constructor(dir, safeStorage) {
    this.dir = dir
    this.file = path.join(dir, 'accounts.json')
    this.safeStorage = safeStorage || null
    this.data = { version: 1, accounts: [], settings: {} }
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = fs.readFileSync(this.file)
      let text
      if (raw.length > 4 && raw[0] === 0x7b) {
        text = raw.toString('utf8') // 明文 JSON
      } else if (this.safeStorage && this.safeStorage.decrypt) {
        text = this.safeStorage.decrypt(raw)
      } else {
        return
      }
      const parsed = JSON.parse(text)
      if (parsed && Array.isArray(parsed.accounts)) this.data = parsed
    } catch {
      /* 读取失败时保持空数据 */
    }
  }

  save() {
    const text = JSON.stringify(this.data, null, 2)
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    if (this.safeStorage && this.safeStorage.encrypt) {
      try {
        fs.writeFileSync(tmp, this.safeStorage.encrypt(text))
      } catch {
        fs.writeFileSync(tmp, text, 'utf8')
      }
    } else {
      fs.writeFileSync(tmp, text, 'utf8')
    }
    fs.renameSync(tmp, this.file)
  }

  list(platform) {
    return platform ? this.data.accounts.filter((a) => a.platform === platform) : this.data.accounts
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id) || null
  }

  /** 按 platform + uid/email 去重写入（存在则更新快照） */
  upsert(account) {
    const idx = this.data.accounts.findIndex((a) => a.id === account.id)
    if (idx >= 0) {
      this.data.accounts[idx] = { ...this.data.accounts[idx], ...account }
    } else {
      this.data.accounts.push(account)
    }
    this.save()
    return idx >= 0 ? this.data.accounts[idx] : account
  }

  remove(id) {
    const before = this.data.accounts.length
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id)
    this.save()
    return this.data.accounts.length !== before
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch }
    this.save()
    return this.data.settings
  }

  getSettings() {
    return this.data.settings || {}
  }

  markUsed(id) {
    const a = this.get(id)
    if (a) {
      a.lastUsed = Date.now()
      a.isCurrent = true
      for (const other of this.data.accounts) {
        if (other.platform === a.platform && other.id !== a.id) other.isCurrent = false
      }
      this.save()
    }
  }

  markCurrent(platform, id) {
    for (const a of this.data.accounts) {
      if (a.platform === platform) a.isCurrent = a.id === id
    }
    this.save()
  }
}

module.exports = { AccountStore }
