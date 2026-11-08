#!/usr/bin/env node
/**
 * 发布说明合规检查。
 *
 * `.release-notes/<版本>.md` 会原样成为 GitHub Release 正文，是公开文档。
 * 只允许「新增 / 修复 / 优化」三类条目，不得夹带本地对话、本地计划、
 * 评估结论、开发过程与验证数据（AGENTS.md §5.1）。
 *
 * 用法：
 *   node scripts/check-release-notes.mjs
 *
 * 当前版本还没有说明文件时跳过；不检查历史文件，避免把旧文档的包袱
 * 变成日常开发的阻塞。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const file = join(root, '.release-notes', `${version}.md`)
const rel = `.release-notes/${version}.md`

if (!existsSync(file)) {
  console.log(`SKIP  ${rel}（当前版本还没有发布说明）`)
  process.exit(0)
}

const ALLOWED_HEADINGS = new Set(['新增', '修复', '优化'])

/** 命中即视为把内部信息带进了公开文档 */
// 关键词刻意做成「组合」而不是裸词：桌面版的「本地服务」「本地调用」
// 是正常的用户可见描述，不能因为出现「本地」二字就误杀。
const BANNED = [
  { re: /详见|参见|参阅/, why: '引用了本地资料' },
  { re: /本地(?:对话|计划|文档|执行|开发)|对话|会话决策|拍板|裁决|用户确认|用户要求|本轮|待你/, why: '本地对话或会话决策' },
  { re: /执行计划|计划文档|\.workbuddy|tmp[/\\]|AGENTS\.md|[A-Za-z]:[/\\]Projects/, why: '本地计划或内部文件路径' },
  { re: /审计|评估报告|第三方报告|经评估|评估后|未采纳|不立项|不夹带|另排议题|另立议题|另行排期|备选方案/, why: '评估结论或未采纳的备选方案' },
  { re: /回归用例|测试用例|\d+\s*(?:个)?(?:测试文件|用例)|npm run verify|全绿|退出码|验证矩阵|go test|gofmt/, why: '验证数据或测试细节' },
  { re: /本次只|没有改动|未改动|随版本同步更新|桌面版与内置内核/, why: '内部范围声明或迭代史' },
  { re: /Phase\s*\d|提交信息|打 tag|推送/, why: '开发过程或发布流程' },
]

const text = readFileSync(file, 'utf8')
const problems = []
const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())

if (headings.length === 0) problems.push('缺少「新增 / 修复 / 优化」二级标题')
for (const h of headings) {
  if (!ALLOWED_HEADINGS.has(h)) problems.push(`不允许的章节「## ${h}」（只准新增/修复/优化）`)
}

text.split(/\r?\n/).forEach((line, i) => {
  const at = `第 ${i + 1} 行`
  if (/^\s*>/.test(line)) {
    problems.push(`${at}：说明/引用块（> ...）不允许，内容请归入对应章节或删掉`)
    return
  }
  if (/^\s*```/.test(line)) {
    problems.push(`${at}：正文不允许代码块`)
    return
  }
  if (/^\s*\|/.test(line)) {
    problems.push(`${at}：正文不允许表格`)
    return
  }
  for (const { re, why } of BANNED) {
    if (re.test(line)) {
      problems.push(`${at}：${why} —— ${line.trim().slice(0, 60)}`)
      return
    }
  }
})

if (problems.length > 0) {
  console.error(`FAIL  ${rel}`)
  for (const p of problems) console.error(`      - ${p}`)
  console.error('\n发布说明里出现了不该公开的内容：只保留「用户能看到的变化」，其余全部删掉。')
  process.exit(1)
}

console.log(`PASS  ${rel} —— 只有新增 / 修复 / 优化，无内部信息`)
