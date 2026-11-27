import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { FONT_SCALE_OPTIONS, DEFAULT_FONT_SCALE } from '../src/composables/useFontScale.ts'

test('1. 档位映射：6 档 id/factor 与 spec 一致，默认 standard', () => {
  const expected = [
    { id: 'compact', label: '紧凑', factor: 0.8 },
    { id: 'small', label: '小', factor: 0.9 },
    { id: 'standard', label: '标准', factor: 1 },
    { id: 'large', label: '大', factor: 1.12 },
    { id: 'xlarge', label: '更大', factor: 1.25 },
    { id: 'huge', label: '特大', factor: 1.4 },
  ]

  assert.equal(FONT_SCALE_OPTIONS.length, 6, '必须包含 6 个档位')
  assert.equal(DEFAULT_FONT_SCALE, 'standard', '默认档位必须为 standard')

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]
    const act = FONT_SCALE_OPTIONS[i]
    assert.equal(act.id, exp.id, `档位 [${i}] id 匹配`)
    assert.equal(act.label, exp.label, `档位 [${exp.id}] label 匹配`)
    assert.equal(act.factor, exp.factor, `档位 [${exp.id}] factor 匹配`)
  }
})

test('2. 裸 px 守卫：扫描 src/**/*.{vue,css} 与 design/studiolo-redesign/*.css，匹配 font-size: <n>px 的数量必须为 0', () => {
  const srcDir = path.resolve(process.cwd(), 'src')
  const designDir = path.resolve(process.cwd(), 'design/studiolo-redesign')

  function getFiles(dir) {
    let results = []
    const list = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of list) {
      const fullPath = path.join(dir, item.name)
      if (item.isDirectory()) {
        results = results.concat(getFiles(fullPath))
      } else if (item.isFile() && (item.name.endsWith('.vue') || item.name.endsWith('.css'))) {
        results.push(fullPath)
      }
    }
    return results
  }

  const designFiles = fs.readdirSync(designDir, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith('.css'))
    .map(item => path.join(designDir, item.name))

  const files = [...getFiles(srcDir), ...designFiles]
  assert.ok(files.length > 0, '扫描到 src 与 design 样式与组件文件')

  const nakedPxRegex = /font-size\s*:\s*[0-9.]+px/g
  const violations = []

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8')
    const matches = content.match(nakedPxRegex)
    if (matches && matches.length > 0) {
      violations.push({ file: path.relative(process.cwd(), file), count: matches.length, matches })
    }
  }

  assert.deepEqual(violations, [], `发现裸 px font-size，数量必须为 0: ${JSON.stringify(violations)}`)
})

test('3. 变量声明存在：--fs: 1 与 6 个 [data-font-size=...] 块都存在', () => {
  const cssFile = path.resolve(process.cwd(), 'src/styles/main.css')
  const content = fs.readFileSync(cssFile, 'utf-8')

  assert.ok(/:root\s*\{[^}]*--fs:\s*1/s.test(content) || /--fs:\s*1;/.test(content), '必须声明默认 --fs: 1')

  const requiredSelectors = [
    { sel: '[data-font-size="compact"]', factor: '0.8' },
    { sel: '[data-font-size="small"]', factor: '0.9' },
    { sel: '[data-font-size="standard"]', factor: '1' },
    { sel: '[data-font-size="large"]', factor: '1.12' },
    { sel: '[data-font-size="xlarge"]', factor: '1.25' },
    { sel: '[data-font-size="huge"]', factor: '1.4' },
  ]

  for (const { sel, factor } of requiredSelectors) {
    assert.ok(content.includes(sel), `样式中必须包含选择器 ${sel}`)
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`${escaped}\\s*\\{[^}]*--fs:\\s*${factor}`, 's')
    assert.ok(regex.test(content), `选择器 ${sel} 必须定义 --fs: ${factor}`)
  }
})
