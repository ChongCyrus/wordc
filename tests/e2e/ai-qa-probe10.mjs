import { launch, newContext, BASE, waitSeededHome, setupAi, injectPlanForWord, enterAnnotation, openAiPanel, makeMockState, installMock, sleep } from './ai-qa-lib.mjs'
const browser=await launch(); const {context,page}=await newContext(browser); page.setDefaultTimeout(15000)
await installMock(page, makeMockState())
await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:60000}); await waitSeededHome(page)
await page.evaluate(async()=>{const db=await new Promise((res,rej)=>{const q=indexedDB.open('momo-reword');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});await new Promise((res,rej)=>{const tx=db.transaction(['meta','packs','packItems','contentRejects'],'readwrite');tx.objectStore('meta').put({key:'packs.defaultSeeded',value:{version:6},updatedAt:Date.now()});tx.objectStore('packs').clear();tx.objectStore('packItems').clear();tx.objectStore('contentRejects').clear();tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})})
await page.reload({waitUntil:'domcontentloaded'}); await waitSeededHome(page)
await setupAi(page); await injectPlanForWord(page,1,{headword:'address'}); await page.reload({waitUntil:'domcontentloaded'}); await waitSeededHome(page)
await page.getByRole('button',{name:/开始学习|继续学习/}).first().click(); await page.waitForURL(/\/study/); await page.locator('.board-stage').first().waitFor({state:'visible'}); await sleep(400)
await page.mouse.click(195,380); await page.locator('.meanings').first().waitFor({state:'visible'})
const gen=await openAiPanel(page)
for(let i=0;i<10;i++){ await sleep(500); const txt=(await gen.innerText()).replace(/\s+/g,' '); console.log((i+1)*500+'ms target=',txt.match(/目标：(\d+)/)?.[1], 'startDisabled=',await gen.getByRole('button',{name:'开始生成',exact:true}).isDisabled()) }
// switch meanings and watch
await gen.getByRole('button',{name:'指定含义',exact:true}).click()
for(let i=0;i<8;i++){ await sleep(500); const txt=(await gen.innerText()).replace(/\s+/g,' '); console.log('meanings '+(i+1)*500+'ms target=',txt.match(/目标：(\d+)/)?.[1], 'warn=',/请至少选择|请先勾选/.test(txt), 'startDisabled=',await gen.getByRole('button',{name:'开始生成',exact:true}).isDisabled()) }
await context.close(); await browser.close()
