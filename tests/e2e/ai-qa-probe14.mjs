import { launch, newContext, setupAi, prepareClean, prepareWord, openAiPanel, makeMockState, installRouter, sleep, panelText } from './ai-qa-lib.mjs'
const browser=await launch(); const {context,page}=await newContext(browser)
await installRouter(page,makeMockState())
await prepareClean(page); await setupAi(page); await prepareWord(page,{headword:'address'})
console.log('settings', await page.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('momo-reword');q.onsuccess=()=>r(q.result)});const s=await new Promise(r=>{const q=db.transaction('settings','readonly').objectStore('settings').getAll();q.onsuccess=()=>r(q.result)});return s.filter(x=>['data.selectedDeckId','study.dailyGoal'].includes(x.key))}))
console.log('decks', await page.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('momo-reword');q.onsuccess=()=>r(q.result)});const d=await new Promise(r=>{const q=db.transaction('decks','readonly').objectStore('decks').getAll();q.onsuccess=()=>r(q.result)});return d.map(x=>({id:x.id,name:x.name,count:x.wordCount}))}))
const gen=await openAiPanel(page); await sleep(600)
const scopeBtns=['今日要学','当前词库','当前词','指定含义','选择词库','自定义选词']
const dump=async(label)=>{const arr=[];for(const s of scopeBtns){const b=gen.getByRole('button',{name:s,exact:true}); if(await b.count()) arr.push(s+':'+(await b.getAttribute('class'))) }console.log(label, arr, 'target', (await panelText(page)).match(/目标：\d+/)?.[0])}
await dump('initial')
await gen.getByRole('button',{name:'当前词库',exact:true}).click(); await sleep(2000); await dump('after deck')
await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(500); await dump('after select')
const btns=gen.locator('button.mm-row'); await btns.first().click(); await sleep(2000); await dump('after click deck')
await gen.getByLabel('例句生成模式').selectOption('append'); await sleep(1000); await dump('after append')
await gen.getByRole('button',{name:'当前词',exact:true}).click(); await sleep(1000); await dump('after word')
await context.close(); await browser.close()
