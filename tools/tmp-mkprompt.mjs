import { buildSystemPromptV4, buildUserPromptV4 } from '/root/workspace/背单词APP开发/src/data/ai/prompts.ts'
import fs from 'node:fs'

const targets = JSON.parse(fs.readFileSync('/tmp/pilot-targets.json', 'utf8'))
const system = buildSystemPromptV4()
const user = buildUserPromptV4(targets)
fs.writeFileSync('/tmp/v4-system.txt', system)
fs.writeFileSync('/tmp/v4-user.txt', user)
console.log('system bytes', system.length, 'user bytes', user.length, 'words', targets.length)
