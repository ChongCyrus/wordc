import { launch, newContext, setupAi, prepareClean, prepareWord, openAiPanel, makeMockState, installRouter, sleep, panelText } from './ai-qa-lib.mjs'
const browser=await launch(); const {context,page}=await newContext(browser); const logs=[]; page.on('console',m=>logs.push(m.type()+': '+m.text().slice(0,300)))
await installRouter(page,makeMockState())
await prepareClean(page); await setupAi(page); await prepareWord(page,{headword:'address'})
const gen=await openAiPanel(page); await sleep(600); await gen.getByLabel('例句生成模式').selectOption('append'); await sleep(800)
await gen.getByRole('button',{name:'当前词库',exact:true}).click(); await sleep(3000)
console.log('TEXT:', (await panelText(page)).replace(/\n/g,' | '))
console.log('logs:', logs.slice(-10))
await context.close(); await browser.close()
