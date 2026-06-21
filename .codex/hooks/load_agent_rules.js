import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const RULES_DIR = '.agents/rules'
const RULE_FILE_EXTENSIONS = new Set(['.md', '.mdc'])
const FRONTMATTER_REGEX = /^\s*---\n([\s\S]*?)\n---/
const VALID_BOOLEAN_VALUES = new Set(['true', 'false'])

function getGitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

function getRuleFiles(rulesDir) {
  return fs.readdirSync(rulesDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && RULE_FILE_EXTENSIONS.has(path.extname(entry.name)))
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()
}

function parseFrontmatter(ruleFile) {
  const content = fs.readFileSync(ruleFile, 'utf8').replace(/\r\n?/g, '\n')
  const match = content.match(FRONTMATTER_REGEX)
  if (match == null) return { error: 'invalid frontmatter' }

  const metadata = {}
  const metadataLines = match[1].split('\n').filter(line => line.trim() != '' && !line.trim().startsWith('#'))
  for (const line of metadataLines) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex == -1) return { error: 'invalid frontmatter' }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '')
    metadata[key] = value
  }

  const hasInvalidAlwaysApply = metadata.alwaysApply != null && !VALID_BOOLEAN_VALUES.has(metadata.alwaysApply)
  if (hasInvalidAlwaysApply) return { error: 'invalid frontmatter' }

  return { metadata }
}

function escapeXml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function getRulePath(rulesDir, ruleFile) {
  return path.join(RULES_DIR, path.relative(rulesDir, ruleFile)).replace(/\\/g, '/')
}

function renderRule(rulesDir, ruleFile) {
  const rulePath = getRulePath(rulesDir, ruleFile)
  const frontmatter = parseFrontmatter(ruleFile)
  if (frontmatter.error != null) return `<rule_warning path="${escapeXml(rulePath)}">Skipped: ${frontmatter.error}.</rule_warning>`

  const alwaysRead = frontmatter.metadata.alwaysApply == 'true'
  return `<rule_description path="${escapeXml(rulePath)}" alwaysRead="${alwaysRead}">
description: ${escapeXml(frontmatter.metadata.description)}
globs: ${escapeXml(frontmatter.metadata.globs)}
</rule_description>`
}

function main() {
  const rulesDir = path.join(getGitRoot(), RULES_DIR)
  if (!fs.existsSync(rulesDir)) return

  const renderedRules = getRuleFiles(rulesDir).map(ruleFile => renderRule(rulesDir, ruleFile)).join('\n\n')
  if (renderedRules == '') return

  console.log(`<shared_agent_rules source="${RULES_DIR}">
These repository rule descriptions were loaded automatically from .agents/rules at session start. Read rule files with alwaysRead="true" before work; otherwise read a rule file only when its description/globs are relevant or the user explicitly mentions it.

${renderedRules}

</shared_agent_rules>`)
}

main()
