import { launch, newContext, setupAi, prepareClean, prepareWord, openAiPanel, makeMockState, installRouter, sleep, panelText } from './ai-qa-lib.mjs'
const browser=await launch(); const {context,page}=await newContext(browser)
await installRouter(page,makeMockState())
await prepareClean(page); await setupAi(page); await prepareWord(page,{headword:'address'})
console.log(await page.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('momo-reword');q.onsuccess=()=>r(q.result)});const all=await new Promise(r=>{const q=db.transaction('words','readonly').objectStore('words').getAll();q.onsuccess=()=>r(q.result)});const byDeck={};for(const w of all)byDeck[w.deckId]=(byDeck[w.deckId]||0)+1;return {total:all.length,byDeck, sample:all.slice(0,2).map(w=>({id:w.id,deckId:w.deckId,order:w.order,headword:w.headword,examples:w.examples?.length}))}}))
const gen=await openAiPanel(page); await sleep(600)
const scopeBtns=['今日要学','当前词库','当前词','指定含义','选择词库','自定义选词']
const dump=async(label)=>{const arr=[];for(const s of scopeBtns){const b=gen.getByRole('button',{name:s,exact:true}); if(await b.count()){const c=await b.getAttribute('class'); if(c.includes('primary')) arr.push(s)}}console.log(label,'scope=',arr.join(','),'target',(await panelText(page)).match(/目标：\d+/)?.[0],'err?',/读取生成目标失败|错误/.test(await panelText(page)))}
await dump('initial')
await gen.getByRole('button',{name:'当前词库',exact:true}).click(); await sleep(2500); await dump('current-deck')
await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(500)
const btns=gen.locator('button.mm-row'); console.log('deck labels', await btns.allInnerTexts())
await btns.first().click(); await sleep(2500); await dump('picked-first')
await gen.getByLabel('例句生成模式').selectOption('append'); await sleep(1000); await dump('append')
await context.close(); await browser.close()
