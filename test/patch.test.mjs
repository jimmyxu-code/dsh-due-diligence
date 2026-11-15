/**
 * 静态检查：背调 mode = 联网检索 + 本插件 OSINT 工具，没有本机/代理类工具。
 * 运行：node --test test/patch.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'

const root = new URL('../', import.meta.url)

/**
 * 读取插件内文件文本。
 * @param {string} path 相对路径。
 * @returns {string} 文本。
 */
function read(path) {
  return readFileSync(new URL(path, root), 'utf8')
}

test('manifest declares the bundle patch, locale and icon resources', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, 'dsh-due-diligence')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.ok(manifest.files.includes('lib/*.mjs'))
  assert.ok(manifest.files.includes('data/*'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(manifest.files.includes('icon.svg'))
  assert.equal(manifest.dependencies, undefined, '插件必须无运行时依赖')
})

test('patch declares the dd preset with order 6 and the required persona', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id: preset-dd/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(patch, /id: dd\b/)
  assert.match(patch, /name: 背调/)
  assert.match(patch, /order: 6/)
  assert.match(patch, /@deepseek-ai\/dsh-persona/)
  assert.match(patch, /complete: true/)
  assert.match(patch, /includeRuntimeContext: false/)
})

test('persona carries the legal and reporting policy required by P1', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /合法用途/) // 合法用途与授权
  assert.match(patch, /授权/)
  assert.match(patch, /社工库/) // 不碰社工库
  assert.match(patch, /不伪造/) // 不伪造
  assert.match(patch, /先判断对象类型/) // 先确认对象类型
  assert.match(patch, /置信度/) // 结论分级
  assert.match(patch, /high.*medium.*low/s) // 三级置信度
  assert.match(patch, /引用来源 URL/) // 引用来源
  assert.match(patch, /dd_report/) // 报告格式
  assert.match(patch, /合规声明/) // 结尾合规声明
  assert.match(patch, /consumer report/i)
  assert.match(patch, /PIPL/)
  assert.match(patch, /FCRA/)
  assert.match(patch, /LinkedIn/) // 禁止抓取平台提示
  assert.match(patch, /GSXT/)
  assert.match(patch, /天眼查/)
  // 人物画像优先：不能再只做真伪判断。
  assert.match(patch, /人物画像/)
  assert.match(patch, /web_queries/)
  assert.match(patch, /3–6 轮 web_search/)
  assert.match(patch, /web_fetch 2–5 个关键页面/)
  assert.match(patch, /只回答「有没有这个人/)
  assert.match(patch, /基本信息/)
  assert.match(patch, /职业与机构/)
  assert.match(patch, /时间线/)
})

test('patch mounts time-context, tool-web, tool-dd and compaction', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /@deepseek-ai\/dsh-time-context/)
  assert.match(patch, /@deepseek-ai\/dsh-tool-web/)
  assert.match(patch, /fetch: true/)
  assert.match(patch, /searchTimeoutMs: 60000/)
  assert.match(patch, /searchMaxResults: 4/)
  assert.match(patch, /searchSummaryMaxChars: 200/)
  assert.match(patch, /fetchMaxOutputChars: 60000/)
  assert.match(patch, /searchMaxQueries: 3/)
  assert.match(patch, /id: tool-dd/)
  assert.match(patch, /name: 'dsh-due-diligence'/)
  assert.match(patch, /@deepseek-ai\/dsh-compaction-basic/)
  assert.match(patch, /@deepseek-ai\/dsh-command-compact/)
  assert.match(patch, /@deepseek-ai\/dsh-compaction-tool-result-pruner/)
})

test('patch keeps every local, shell, delegation and manager tool out of the dd mode', () => {
  const patch = read('cordis.patch.yml')
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-tool-(bash|pwsh|fs|fs-search|jobs|subagent|workflow|todo|goal|skill|present|ask-user|working-directory)\b/)
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-plugin-manager/)
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-plan-mode/)
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-agent-instructions/)
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-experimental-tool-agent-team/)
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-tool-computer-use/)
  assert.doesNotMatch(patch, /dsh-orb/)
})

test('display metadata and icon are present', () => {
  const zh = JSON.parse(read('locale/zh.json'))
  const en = JSON.parse(read('locale/en.json'))
  assert.equal(typeof zh.meta.title, 'string')
  assert.ok(zh.meta.title.length > 0)
  assert.match(zh.meta.description, /背调|尽调/)
  assert.equal(typeof en.meta.title, 'string')
  assert.equal(typeof en.meta.description, 'string')
  assert.ok(statSync(new URL('icon.svg', root)).size > 0)
  assert.match(read('icon.svg'), /^<svg[\s>]/)
})

test('the host side registers tools without importing @deepseek-ai packages', () => {
  const index = read('index.js')
  assert.match(index, /export const name = 'dsh-due-diligence'/)
  assert.match(index, /export const inject = \['tools'\]/)
  assert.match(index, /ctx\.tools\.register/)
  assert.match(index, /createToolDefinitions/)
  // link: 安装的 workspace 插件无法解析 @deepseek-ai/* 裸导入（2026-11-07 实测），必须零依赖。
  assert.doesNotMatch(index, /from '@deepseek-ai\//)
})

test('sherlock data and license are packaged', () => {
  const data = JSON.parse(read('data/sherlock-sites.json'))
  const siteCount = Object.keys(data).filter((key) => !key.startsWith('$')).length
  assert.ok(siteCount >= 400, `expected >=400 sites, got ${siteCount}`)
  assert.match(read('data/SHERLOCK-LICENSE.txt'), /MIT|Permission is hereby granted/)
  const exclusions = read('data/false-positive-exclusions.txt').trim().split(/\r?\n/).filter((line) => line !== '')
  assert.ok(exclusions.length >= 40, `expected >=40 exclusions, got ${exclusions.length}`)
})

test('host side stays minimal: no registry listeners, no tool restrictions', () => {
  const source = read('index.js')
  // 只检查代码本身，避免注释里的复盘说明误报。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 2026-11-07 事故复盘：在 tools/change 监听里反复 ctx.tools.restrict 会形成事件回环，
  // 导致 Host 反复失败退出。这里锁死「只注册、不监听、不 restrict」的稳定形态。
  assert.doesNotMatch(code, /ctx\.tools\.restrict/)
  assert.doesNotMatch(code, /tools\/change/)
  assert.doesNotMatch(code, /ctx\.on\(/)
  assert.doesNotMatch(code, /ctx\.effect\(/)
  assert.match(code, /for \(const tool of tools\) \{/)
  assert.match(code, /ctx\.tools\.register\(tool\)/)
})
