'use strict'
// 诊断脚本：检测本机各平台当前登录账号（只读，不修改任何数据）
// 用法: node scripts/diag.js [--quota] [--checkin-status]

const platforms = require('../src/main/platforms')

;(async () => {
  const list = platforms.listPlatforms()
  console.log('已注册平台:', list.map((p) => `${p.label}(${p.id})`).join('  '))
  console.log('')

  const found = await platforms.detectAll()
  for (const acc of found) {
    console.log('=== ' + (acc.platformLabel || acc.platform) + ' ===')
    if (acc.detectFailed) {
      console.log('  检测失败:', acc.error)
      continue
    }
    console.log('  账号ID :', acc.id)
    console.log('  名称   :', acc.name)
    console.log('  邮箱   :', acc.email || '—')
    console.log('  uid    :', acc.uid || '—')
    console.log('  套餐   :', acc.plan || '—')
    console.log('  只读   :', acc.readOnly ? '是' : '否')

    if (process.argv.includes('--quota')) {
      try {
        const q = await platforms.refreshQuota(acc)
        console.log('  额度   :', JSON.stringify(q.summary))
      } catch (e) {
        console.log('  额度查询失败:', e.message)
      }
    }
    if (process.argv.includes('--checkin-status')) {
      const meta = platforms.registry[acc.platform]
      if (meta && meta.adapter.checkinStatus) {
        try {
          console.log('  签到状态:', JSON.stringify(await meta.adapter.checkinStatus(acc)))
        } catch (e) {
          console.log('  签到状态查询失败:', e.message)
        }
      }
    }
    console.log('')
  }

  const known = new Set(found.map((f) => f.platform))
  for (const p of list) {
    if (!known.has(p.id)) console.log(`(未检测到登录态) ${p.label}`)
  }
})().catch((e) => console.error('FATAL', e))
