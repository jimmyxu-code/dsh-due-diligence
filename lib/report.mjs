/**
 * dd_report 的纯逻辑：把调查材料整理成 Markdown 背调报告并写入报告目录。
 *
 * 纯模块（只依赖 node 内置），可用普通 `node --test` 测试。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认报告目录名（放在用户桌面）。 */
export const DEFAULT_REPORT_DIR_NAME = '背调报告'

/** 对象类型的中文标签。 */
const TARGET_TYPE_LABELS = Object.freeze({
  company: '公司 / 组织',
  organization: '公司 / 组织',
  person: '人',
  people: '人',
  domain: '域名 / 网站',
  website: '域名 / 网站',
  username: '网名 / 账号',
  account: '网名 / 账号',
  other: '其他',
})

/** 置信度中文标签。 */
const CONFIDENCE_LABELS = Object.freeze({
  high: '高',
  medium: '中',
  low: '低',
})

/** 人物画像分区顺序与中文标题。 */
const PROFILE_SECTIONS = Object.freeze([
  ['basics', '基本信息'],
  ['occupation', '职业与机构'],
  ['education', '教育背景'],
  ['works', '作品 / 项目 / 论文'],
  ['media', '公开活动与媒体'],
  ['accounts', '公开账号'],
  ['timeline', '时间线'],
  ['risks', '公开争议与风险'],
  ['other', '其他公开信息'],
])

/** 结尾合规声明（与 persona 一致）。 */
export const COMPLIANCE_STATEMENT =
  '本报告仅基于公开信息，用于合法尽职调查与信息核验，不构成法律、投资或雇佣建议，' +
  '不构成消费报告（consumer report），不得用于自动决策。使用者应自行核实并承担合规责任。'

/**
 * 解析报告目录配置：空值用默认目录，`~` 展开为用户目录。
 * @param {string|undefined} configured 配置值。
 * @param {string} [home] 用户目录（测试可注入）。
 * @returns {string} 绝对报告目录。
 */
export function resolveReportDir(configured, home = homedir()) {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  const expanded = raw === '' ? join(home, 'Desktop', DEFAULT_REPORT_DIR_NAME) : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  return expanded
}

/**
 * 对象类型标签。
 * @param {string} targetType 类型。
 * @returns {string} 中文标签。
 */
export function targetTypeLabel(targetType) {
  const key = typeof targetType === 'string' ? targetType.trim().toLowerCase() : ''
  return TARGET_TYPE_LABELS[key] ?? TARGET_TYPE_LABELS.other
}

/**
 * 把时间戳格式化成 `YYYYMMDD-HHmmss`（本地时间）。
 * @param {number} [now] 毫秒时间戳。
 * @returns {string} 时间标签。
 */
export function timeLabel(now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 生成安全文件名片段：去掉路径分隔符与危险字符，限制长度。
 * @param {string} target 对象名。
 * @returns {string} 文件名片段。
 */
export function safeFileStem(target) {
  const text = typeof target === 'string' ? target.trim() : ''
  const cleaned = text
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  return cleaned === '' ? 'target' : cleaned.slice(0, 60)
}

/**
 * 转义 Markdown 表格单元格（竖线、换行）。
 * @param {unknown} value 值。
 * @returns {string} 单元格文本。
 */
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

/**
 * 校验并归一化一条 finding。
 * @param {any} finding 原始 finding。
 * @param {number} now 当前时间。
 * @returns {{ claim: string, source: string, url: string|null, fetched_at: string, confidence: string, detail: string }} 归一化 finding。
 */
function normalizeFinding(finding, now) {
  const claim = typeof finding?.claim === 'string' && finding.claim.trim() !== '' ? finding.claim.trim() : '（未填写结论）'
  const url = typeof finding?.url === 'string' && finding.url.trim() !== '' ? finding.url.trim() : null
  const confidence = ['high', 'medium', 'low'].includes(finding?.confidence) ? finding.confidence : 'medium'
  const source = typeof finding?.source === 'string' && finding.source.trim() !== '' ? finding.source.trim() : '未标注'
  const fetchedAt = typeof finding?.fetched_at === 'string' && finding.fetched_at !== '' ? finding.fetched_at : new Date(now).toISOString()
  const detail = typeof finding?.detail === 'string' ? finding.detail.replace(/\r?\n/g, ' ').slice(0, 500) : ''
  return { claim, source, url, fetched_at: fetchedAt, confidence, detail }
}

/**
 * 归一化人物画像分区：只保留非空字符串数组。
 * @param {unknown} profile 画像对象。
 * @returns {Array<{ key: string, title: string, items: string[] }>} 非空分区。
 */
export function normalizeProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const out = []
  const seen = new Set()
  for (const [key, title] of PROFILE_SECTIONS) {
    seen.add(key)
    const value = profile[key]
    const items = (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim())
    if (items.length > 0) out.push({ key, title, items })
  }
  for (const [key, value] of Object.entries(profile)) {
    if (seen.has(key)) continue
    const items = (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim())
    if (items.length > 0) out.push({ key, title: key, items })
  }
  return out
}

/**
 * 生成 Markdown 背调报告。
 * @param {{
 *   target: string,
 *   target_type: string,
 *   summary: string,
 *   findings?: any[],
 *   open_questions?: string[],
 *   next_steps?: string[],
 *   profile?: Record<string, string[]>,
 *   now?: number,
 * }} input 报告输入。
 * @returns {string} Markdown 全文。
 */
export function buildReportMarkdown(input) {
  const now = Number.isFinite(input?.now) ? input.now : Date.now()
  const target = typeof input?.target === 'string' && input.target.trim() !== '' ? input.target.trim() : '未命名对象'
  const targetType = targetTypeLabel(input?.target_type)
  const summary = typeof input?.summary === 'string' && input.summary.trim() !== '' ? input.summary.trim() : '（未填写结论摘要）'
  const findings = (Array.isArray(input?.findings) ? input.findings : []).map((finding) => normalizeFinding(finding, now))
  const questions = (Array.isArray(input?.open_questions) ? input.open_questions : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
  const nextSteps = (Array.isArray(input?.next_steps) ? input.next_steps : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
  const profileSections = normalizeProfile(input?.profile)

  const lines = []
  lines.push(`# 背调报告：${target}`, '')
  lines.push(`- **对象**：${target}`)
  lines.push(`- **对象类型**：${targetType}`)
  lines.push(`- **生成时间**：${new Date(now).toISOString()}`)
  lines.push(`- **生成工具**：DSH 背调模式（dsh-due-diligence）`)
  lines.push('')
  lines.push('## 一、结论摘要', '')
  lines.push(summary, '')
  let sectionIndex = 2
  const CN_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  const cn = (index) => CN_NUMERALS[index] ?? String(index)
  if (profileSections.length > 0) {
    lines.push(`## ${cn(sectionIndex)}、人物画像`, '')
    for (const section of profileSections) {
      lines.push(`### ${section.title}`, '')
      for (const item of section.items) lines.push(`- ${item}`)
      lines.push('')
    }
    sectionIndex += 1
  }
  lines.push(`## ${cn(sectionIndex)}、证据表`, '')
  sectionIndex += 1
  if (findings.length === 0) {
    lines.push('（暂无结构化证据；请先用 dd_company / dd_username / dd_domain / dd_name 查询后再生成报告。）', '')
  } else {
    lines.push('| # | 结论（claim） | 来源（source） | URL | 抓取时间（fetched_at） | 置信度 | 细节 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    findings.forEach((finding, index) => {
      lines.push(
        `| ${index + 1} | ${cell(finding.claim)} | ${cell(finding.source)} | ${cell(finding.url)} | ${cell(finding.fetched_at)} | ${CONFIDENCE_LABELS[finding.confidence] ?? '中'} | ${cell(finding.detail)} |`,
      )
    })
    lines.push('')
  }
  lines.push(`## ${cn(sectionIndex)}、疑点与待核实`, '')
  sectionIndex += 1
  if (questions.length === 0) lines.push('（无）')
  else for (const question of questions) lines.push(`- ${question}`)
  lines.push('')
  lines.push(`## ${cn(sectionIndex)}、下一步`, '')
  sectionIndex += 1
  if (nextSteps.length === 0) lines.push('- 补充交叉来源、人工复核关键结论，并保留原始 URL 与抓取时间。')
  else for (const step of nextSteps) lines.push(`- ${step}`)
  lines.push('')
  lines.push(`## ${cn(sectionIndex)}、合规声明`, '')
  lines.push(COMPLIANCE_STATEMENT)
  lines.push('')
  return lines.join('\n')
}

/**
 * 写入报告文件。
 * @param {{
 *   target: string,
 *   target_type: string,
 *   summary: string,
 *   findings?: any[],
 *   open_questions?: string[],
 *   next_steps?: string[],
 *   profile?: Record<string, string[]>,
 * }} input 报告输入。
 * @param {{
 *   reportDir?: string,
 *   now?: number,
 *   mkdirImpl?: typeof mkdir,
 *   writeFileImpl?: typeof writeFile,
 *   home?: string,
 * }} [options] 选项。
 * @returns {Promise<{ path: string, dir: string, markdown: string, bytes: number, filename: string }>} 写入结果。
 */
export async function writeReport(input, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const dir = resolveReportDir(options.reportDir, options.home)
  const filename = `背调报告-${safeFileStem(input?.target)}-${timeLabel(now)}.md`
  const path = join(dir, filename)
  const markdown = buildReportMarkdown({ ...input, now })
  const mkdirImpl = options.mkdirImpl ?? mkdir
  const writeFileImpl = options.writeFileImpl ?? writeFile
  await mkdirImpl(dir, { recursive: true })
  await writeFileImpl(path, markdown, 'utf8')
  return { path, dir, filename, markdown, bytes: Buffer.byteLength(markdown, 'utf8') }
}
