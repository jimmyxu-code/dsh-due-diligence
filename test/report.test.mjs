/**
 * dd_report 纯逻辑测试：报告结构、证据表、文件名、目录解析、写盘。
 * 运行：node --test test/report.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMPLIANCE_STATEMENT,
  buildReportMarkdown,
  resolveReportDir,
  safeFileStem,
  targetTypeLabel,
  timeLabel,
  writeReport,
} from '../lib/report.mjs'

test('buildReportMarkdown renders the required sections and evidence rows', () => {
  const markdown = buildReportMarkdown({
    target: 'Apple Inc.',
    target_type: 'company',
    summary: '苹果公司为美国上市公司，SEC CIK 0000320193。',
    findings: [
      {
        claim: 'SEC 登记 CIK 0000320193',
        source: 'sec-edgar',
        url: 'https://data.sec.gov/submissions/CIK0000320193.json',
        fetched_at: '2026-11-07T03:00:00.000Z',
        confidence: 'high',
        detail: 'Apple Inc.',
      },
      {
        claim: 'GLEIF 命中 LEI',
        source: 'gleif',
        url: 'https://api.gleif.org/api/v1/lei-records/5493001KJTIIGC8Y1R12',
        confidence: 'medium',
        detail: '含竖线 | 与换行\n测试',
      },
    ],
    open_questions: ['是否为同一法律实体？'],
    next_steps: ['补充中国工商信息。'],
  })
  assert.match(markdown, /^# 背调报告：Apple Inc\./m)
  assert.match(markdown, /## 一、结论摘要/)
  assert.match(markdown, /## 二、证据表/)
  assert.match(markdown, /## 三、疑点与待核实/)
  assert.match(markdown, /## 四、下一步/)
  assert.match(markdown, /## 五、合规声明/)
  assert.match(markdown, /SEC 登记 CIK 0000320193/)
  assert.match(markdown, /https:\/\/data\.sec\.gov\/submissions\/CIK0000320193\.json/)
  assert.match(markdown, /含竖线 \\\| 与换行 测试/)
  assert.ok(markdown.includes(COMPLIANCE_STATEMENT))
  assert.match(markdown, /公司 \/ 组织/)
})

test('buildReportMarkdown tolerates empty findings and undefined fields', () => {
  const markdown = buildReportMarkdown({ target: '张三', target_type: 'person', summary: '公开信息有限。' })
  assert.match(markdown, /暂无结构化证据/)
  assert.match(markdown, /（无）/) // 无疑点
  assert.match(markdown, /合规声明/)
})

test('targetTypeLabel and safeFileStem normalize inputs', () => {
  assert.equal(targetTypeLabel('company'), '公司 / 组织')
  assert.equal(targetTypeLabel('PERSON'), '人')
  assert.equal(targetTypeLabel('domain'), '域名 / 网站')
  assert.equal(targetTypeLabel('username'), '网名 / 账号')
  assert.equal(targetTypeLabel(''), '其他')
  assert.equal(safeFileStem('Apple Inc.'), 'Apple-Inc')
  assert.equal(safeFileStem('a/b:c*d?e'), 'a-b-c-d-e')
  assert.equal(safeFileStem('   '), 'target')
  assert.ok(safeFileStem('x'.repeat(200)).length <= 60)
})

test('resolveReportDir defaults to ~/Desktop/背调报告 and expands ~', () => {
  assert.equal(resolveReportDir(undefined, '/home/tester'), '/home/tester/Desktop/背调报告')
  assert.equal(resolveReportDir('', '/home/tester'), '/home/tester/Desktop/背调报告')
  assert.equal(resolveReportDir('~/reports', '/home/tester'), '/home/tester/reports')
  assert.equal(resolveReportDir('/tmp/dd-reports', '/home/tester'), '/tmp/dd-reports')
})

test('timeLabel is a stable local timestamp', () => {
  const label = timeLabel(Date.UTC(2026, 10, 7, 3, 4, 5))
  assert.match(label, /^\d{8}-\d{6}$/)
})

test('writeReport writes a Markdown file into the configured directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dd-report-test-'))
  const result = await writeReport(
    {
      target: 'example.com',
      target_type: 'domain',
      summary: '证书与存档可用。',
      findings: [{ claim: 'RDAP 可查', source: 'rdap', url: 'https://rdap.org/domain/example.com', confidence: 'high' }],
    },
    { reportDir: dir, now: Date.UTC(2026, 10, 7, 3, 4, 5) },
  )
  assert.equal(result.dir, dir)
  assert.match(result.filename, /^背调报告-example\.com-\d{8}-\d{6}\.md$/)
  assert.ok(result.bytes > 0)
  const content = await readFile(result.path, 'utf8')
  assert.match(content, /# 背调报告：example\.com/)
  assert.match(content, /RDAP 可查/)
  assert.match(content, /合规声明/)
})

test('buildReportMarkdown renders a person profile section before evidence', () => {
  const markdown = buildReportMarkdown({
    target: '张三',
    target_type: 'person',
    summary: '公开信息画像。',
    profile: {
      basics: ['公开姓名：张三'],
      occupation: ['某公司工程师'],
      education: ['某大学计算机系'],
      accounts: ['GitHub：@zhangsan'],
      timeline: ['2020 年加入某公司'],
    },
    findings: [{ claim: '公开主页', source: 'GitHub', url: 'https://github.com/zhangsan', confidence: 'high' }],
    open_questions: ['是否为同一人？'],
  })
  assert.match(markdown, /## 二、人物画像/)
  assert.match(markdown, /### 基本信息/)
  assert.match(markdown, /### 职业与机构/)
  assert.match(markdown, /### 教育背景/)
  assert.match(markdown, /### 公开账号/)
  assert.match(markdown, /### 时间线/)
  assert.match(markdown, /## 三、证据表/)
  assert.match(markdown, /## 四、疑点与待核实/)
  assert.match(markdown, /## 五、下一步/)
  assert.match(markdown, /## 六、合规声明/)
})
