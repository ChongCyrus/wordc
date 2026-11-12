import { launch, newContext, BASE, setupAi, prepareClean, prepareWord, openAiPanel, makeMockState, installRouter, sleep, panelTarget, panelText } from './ai-qa-lib.mjs'
const browser=await launch(); for (const base of ['http://127.0.0.1:4174/','http://127.0.0.1:4173/']) {
  console.log('\n### BASE', base)
  const {context,page}=await newContext(browser); page.setDefaultTimeout(15000)
  await installRouter(page,makeMockState())
  await prepareClean(page); await setupAi(page); await prepareWord(page,{headword:'address'})
  const gen=await openAiPanel(page); await sleep(600)
  await gen.getByLabel('例句生成模式').selectOption('append'); await sleep(800)
  console.log('word target',await panelTarget(page))
  await gen.getByRole('button',{name:'当前词库',exact:true}).click()
  for (const ms of [300,1000,3000,6000]) { await sleep(ms); console.log('current deck scope +'+ms, await panelTarget(page), (await panelText(page)).includes('没有可生成的词')) }
  await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(500)
  const btns=gen.locator('button.mm-row'); console.log('deck labels', await btns.allInnerTexts())
  await btns.first().click(); await sleep(3000); console.log('after deck click target', await panelTarget(page))
  await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(100); await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(3000)
  console.log('after re-click scope target', await panelTarget(page), 'startDisabled', await gen.getByRole('button',{name:'开始生成',exact:true}).isDisabled())
  await gen.getByRole('button',{name:'选择词库',exact:true}).click(); await sleep(100); await btns.nth(1).click(); await sleep(6000)
  console.log('after deck2 target', await panelTarget(page))
  await context.close()
}
await browser.close()
