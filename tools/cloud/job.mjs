#!/usr/bin/env node
/**
 * 统一云端任务入口（Agent 调度用）。
 *
 * 用法：
 *   node tools/cloud/job.mjs --provider local  --cmd "pnpm test -- --run"
 *   node tools/cloud/job.mjs --provider github --cmd "pnpm test -- --run"
 *   node tools/cloud/job.mjs --provider ssh    --cmd "pnpm test -- --run"
 *
 * 说明：
 * - local：本机执行，验证契约。
 * - github：workflow_dispatch 触发 .github/workflows/cloud-task.yml，轮询 run，拉日志/artifact。
 * - ssh：在远程 Linux 执行（需要 CLOUD_SSH_HOST/USER/KEY），适合以后的 ECS。
 * - fc/eci：尚未接入（需要阿里云 AccessKey 与计费开通），会明确报错。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const provider = arg('--provider', 'local')
const command = arg('--cmd')
const cwd = resolve(arg('--cwd', process.cwd()))
const timeoutMs = Number(arg('--timeout', '900')) * 1000
const image = arg('--image')
const jobId = arg('--id', `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`)
const outDir = resolve(arg('--out', '.cloud-jobs'), jobId)
if (!command) { console.error('缺少 --cmd'); process.exit(2) }
mkdirSync(outDir, { recursive: true })
const record = { jobId, provider, command, cwd, image, startedAt: new Date().toISOString() }

function finish(patch, code) {
  Object.assign(record, patch, { endedAt: new Date().toISOString() })
  writeFileSync(resolve(outDir, 'job.json'), JSON.stringify(record, null, 2))
  console.log(JSON.stringify(record, null, 2))
  process.exit(code)
}

async function runLocal() {
  const logPath = resolve(outDir, 'stdout.log')
  const errPath = resolve(outDir, 'stderr.log')
  const out = createWriteStream(logPath)
  const err = createWriteStream(errPath)
  const child = spawn('/bin/bash', ['-lc', command], { cwd })
  child.stdout.pipe(out); child.stderr.pipe(err)
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    finish({ exitCode: code, signal, logs: { stdout: logPath, stderr: errPath } }, code ?? 1)
  })
  child.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }, 1) })
}

async function githubApi(method, path, body) {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('缺少 GITHUB_TOKEN')
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-cloud-job', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res
}

async function runGithub() {
  const repo = process.env.CLOUD_GITHUB_REPO || 'ChongCyrus/wordc'
  const ref = process.env.CLOUD_GITHUB_REF || 'main'
  const wf = process.env.CLOUD_GITHUB_WORKFLOW || 'cloud-task.yml'
  await githubApi('POST', `/repos/${repo}/actions/workflows/${wf}/dispatches`, { ref, inputs: { job_id: jobId, command, timeout_sec: String(Math.floor(timeoutMs / 1000)) } })
  const deadline = Date.now() + timeoutMs
  let run = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await githubApi('GET', `/repos/${repo}/actions/runs?event=workflow_dispatch&per_page=10`)
    const runs = (await res.json()).workflow_runs || []
    run = runs.find((x) => x.name?.includes('cloud task') && (x.display_title || '').includes(jobId))
    if (run && run.status === 'completed') break
  }
  if (!run) throw new Error(`未找到 run（job ${jobId}）`)
  const res = await githubApi('GET', `/repos/${repo}/actions/runs/${run.id}/logs`)
  const logPath = resolve(outDir, 'action.log')
  writeFileSync(logPath, await res.text())
  finish({ runId: run.id, runUrl: run.html_url, conclusion: run.conclusion, logs: logPath }, run.conclusion === 'success' ? 0 : 1)
}

async function runSsh() {
  const host = process.env.CLOUD_SSH_HOST
  const user = process.env.CLOUD_SSH_USER || 'root'
  const key = process.env.CLOUD_SSH_KEY
  if (!host) throw new Error('缺少 CLOUD_SSH_HOST（以后 ECS 配置时提供）')
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']
  if (key) sshArgs.push('-i', key)
  const child = spawn('ssh', [...sshArgs, `${user}@${host}`, `cd ~/workspace 2>/dev/null || true; ${command}`], { cwd })
  const logPath = resolve(outDir, 'ssh.log')
  const out = createWriteStream(logPath)
  child.stdout.pipe(out); child.stderr.pipe(out)
  child.on('exit', (code) => finish({ exitCode: code, logs: logPath }, code ?? 1))
}

try {
  if (provider === 'local') await runLocal()
  else if (provider === 'github') await runGithub()
  else if (provider === 'ssh') await runSsh()
  else if (provider === 'fc' || provider === 'eci') throw new Error(`${provider} 尚未接入：需要阿里云 AccessKey、地域、OSS/SLS 与计费开通`)
  else throw new Error(`未知 provider: ${provider}`)
} catch (e) {
  finish({ error: e.message }, 1)
}
