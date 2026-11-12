import { launch, newContext, setupAi, prepareClean, prepareWord, openAiPanel, makeMockState, installRouter, sleep, panelText } from './ai-qa-lib.mjs'
const browser=await launch(); const {context,page}=await newContext(browser)
await installRouter(page,makeMockState())
await prepareClean(page); await setupAi(page); await prepareWord(page,{headword:'address'})
const gen=await openAiPanel(page); await sleep(800)
await gen.getByLabel('例句生成模式').selectOption('append'); await sleep(800)
const before=(await panelText(page)).match(/目标：(\d+)/)?.[1]; console.log('word target', before)
await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(500)
const first=gen.locator('button.mm-row').first(); console.log('deck', (await first.innerText()).trim())
const t0=Date.now(); await first.click()
let last=null
for(let i=0;i<120;i++){ await sleep(1000); const t=(await panelText(page)).match(/目标：(\d+)/)?.[1]; if(t!==last){ console.log('t=',((Date.now()-t0)/1000).toFixed(1)+'s target',t); last=t } if(t===before && i>2){} }
await context.close(); await browser.close()
