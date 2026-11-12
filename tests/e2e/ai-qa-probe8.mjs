import { launch, newContext, BASE, waitSeededHome, sleep } from './ai-qa-lib.mjs'
const browser=await launch(); const {context,page,bag}=await newContext(browser)
await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:60000}); console.log('goto')
await waitSeededHome(page); console.log('home ok')
const read=()=>page.evaluate(async()=>{const db=await new Promise((res,rej)=>{const q=indexedDB.open('momo-reword');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});const meta=await new Promise(res=>{const q=db.transaction('meta','readonly').objectStore('meta').get('packs.defaultSeeded');q.onsuccess=()=>res(q.result);q.onerror=()=>res(null)});const packs=await new Promise(res=>{const q=db.transaction('packs','readonly').objectStore('packs').count();q.onsuccess=()=>res(q.result);q.onerror=()=>res(-1)});const items=await new Promise(res=>{const q=db.transaction('packItems','readonly').objectStore('packItems').count();q.onsuccess=()=>res(q.result);q.onerror=()=>res(-1)});const allmeta=await new Promise(res=>{const q=db.transaction('meta','readonly').objectStore('meta').getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>res([])});return {meta,packs,items,metaKeys:allmeta.map(m=>m.key)}})
for(let i=0;i<8;i++){ console.log(i*5+'s', JSON.stringify(await read())); await sleep(5000) }
await context.close(); await browser.close()
