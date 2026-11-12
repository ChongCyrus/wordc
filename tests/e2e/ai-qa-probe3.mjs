import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url'
const HERE=dirname(fileURLToPath(import.meta.url)); const ROOT=join(HERE,'..','..'); const TOOLS=join(ROOT,'tools/e2e')
const CHROMIUM=join(TOOLS,'chromium/usr/lib/chromium/chromium'); const LIB=[join(TOOLS,'chromium/usr/lib/aarch64-linux-gnu'),join(TOOLS,'chromium/usr/lib/chromium')].join(':')
const BASE='http://127.0.0.1:4173/'; const KEY=(await readFile(join(ROOT,'.secrets/deepseek-key'),'utf8')).trim()
const browser=await chromium.launch({executablePath:CHROMIUM,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],env:{...process.env,LD_LIBRARY_PATH:LIB}})
const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}); const page=await ctx.newPage()
await page.goto(BASE+'#/me/settings',{waitUntil:'domcontentloaded',timeout:60000}); await page.getByText('AI 扩充（可选）').first().waitFor({state:'visible'})
const snap=async(label)=>{const t=await page.locator('body').innerText(); console.log(label,'hasConfigured=',t.includes('已配置：'),'mask=',t.match(/已配置：[^\n]*/)?.[0]??null,'inputValue=',(await page.getByLabel('AI API Key').inputValue()).slice(0,20),'inputType=',await page.getByLabel('AI API Key').getAttribute('type'))}
const enable=page.getByRole('switch',{name:'启用 AI 扩充'}); if(await enable.getAttribute('aria-checked')!=='true') await enable.click()
await page.getByLabel('AI baseURL').fill('https://api.deepseek.com'); await page.getByLabel('AI 模型').fill('deepseek-chat'); await page.getByLabel('AI API Key').fill(KEY)
await page.getByRole('button',{name:'保存 Key',exact:true}).click()
await page.waitForTimeout(300); await snap('300ms')
await page.waitForTimeout(2000); await snap('2.3s')
await page.waitForTimeout(3000); await snap('5.3s')
// click elsewhere?
await page.locator('body').click({position:{x:10,y:10}}).catch(()=>{})
await page.waitForTimeout(800); await snap('after blur')
await browser.close()
