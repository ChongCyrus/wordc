import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url)); const ROOT = join(HERE,'..','..'); const TOOLS=join(ROOT,'tools/e2e')
const CHROMIUM=join(TOOLS,'chromium/usr/lib/chromium/chromium'); const LIB=[join(TOOLS,'chromium/usr/lib/aarch64-linux-gnu'),join(TOOLS,'chromium/usr/lib/chromium')].join(':')
const BASE='http://127.0.0.1:4173/'; const KEY=(await readFile(join(ROOT,'.secrets/deepseek-key'),'utf8')).trim(); const OUT=join(ROOT,'docs/assets/qa/ai-0.3.26')
const browser=await chromium.launch({executablePath:CHROMIUM,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],env:{...process.env,LD_LIBRARY_PATH:LIB}})
const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}); const page=await ctx.newPage()
const logs=[]; page.on('console',m=>logs.push(m.type()+': '+m.text()))
await page.goto(BASE+'#/me/settings',{waitUntil:'domcontentloaded',timeout:60000})
await page.getByText('AI 扩充（可选）').first().waitFor({state:'visible',timeout:30000})
const aiText=async()=>{
  return await page.evaluate(()=>{
    const title=[...document.querySelectorAll('*')].find(el=>el.textContent?.trim()==='AI 扩充（可选）')
    const sec=title?.closest('section')??title?.parentElement?.parentElement
    return sec?.innerText.replace(/\s+/g,' ')??'NOT FOUND'
  })
}
console.log('initial:', (await aiText()).slice(0,600))
const enable=page.getByRole('switch',{name:'启用 AI 扩充'}); if(await enable.getAttribute('aria-checked')!=='true') await enable.click()
await page.getByLabel('AI baseURL').fill('https://api.deepseek.com')
await page.getByLabel('AI 模型').fill('deepseek-chat')
await page.getByLabel('AI API Key').fill(KEY)
console.log('mask attr after fill', await page.getByLabel('AI API Key').getAttribute('type'))
await page.getByRole('button',{name:'保存 Key',exact:true}).click()
await page.waitForTimeout(2500)
console.log('after save:', (await aiText()).slice(0,800))
const db=await page.evaluate(async()=>{const open=()=>new Promise((res,rej)=>{const r=indexedDB.open('momo-reword');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const d=await open();return await new Promise(res=>{const r=d.transaction('settings','readonly').objectStore('settings').getAll();r.onsuccess=()=>res(r.result.filter(x=>String(x.key).startsWith('ai.')));r.onerror=()=>res([])})})
console.log('db ai rows:', JSON.stringify(db).replace(/"value":"sk-[^"]+"/g,'"value":"sk-***REDACTED***"').slice(0,1500))
await page.screenshot({path:join(OUT,'probe2-after-save.png')})
await page.reload({waitUntil:'domcontentloaded'}); await page.getByText('AI 扩充（可选）').first().waitFor({state:'visible',timeout:30000}); await page.waitForTimeout(2000)
console.log('after reload:', (await aiText()).slice(0,900))
console.log('pageHasFullKey', (await page.content()).includes(KEY), 'consoleHasKey', logs.some(l=>l.includes(KEY)))
await page.screenshot({path:join(OUT,'probe2-after-reload.png')})
await browser.close()
