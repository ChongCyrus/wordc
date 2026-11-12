#!/usr/bin/env node
/**
 * task-112：规则清洗 v4 semantics pack 的 steps「元推理」文本（不调用 API）。
 * - 「定名「X」」/「定名'X'」→ X；
 * - 剥离开头元推理词（通读/义项/归并/其中/综上/可见/分类/统计/判断/...）；
 * - 清洗后仍含元推理词 → 丢弃该步；不足 2 步 → 整个 steps 删除（steps 可选）。
 * 用法：node tools/clean-semantics-steps.mjs --in <pack.json> --out <fixed.json> [--write]
 * 默认 --out 必填；--write 才写文件（否则只统计）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const args=process.argv.slice(2); const get=(k)=>{const i=args.indexOf(k);return i>=0?args[i+1]:null}
const input=get('--in'); const output=get('--out'); const write=args.includes('--write')
if(!input||!output){console.error('用法: --in <pack.json> --out <fixed.json> [--write]');process.exit(1)}
const STEP_BLACKLIST=['是否','看','检查','判断','确认','核对','来源','源自','来自','出自','词源','词根','希腊','拉丁','英语','法语','德语','→','->','推导','通读','义项','定名','归并','其中','综上','可见','分类','统计','归纳','标注','映射','判定','推断','总结','首先','其次','然后']
const leadRe=new RegExp('^(?:'+STEP_BLACKLIST.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')[：:，,\\s「]*')
const blacklistHit=(s)=>STEP_BLACKLIST.some(w=>s.includes(w))
function cleanStep(raw){
  let s=String(raw??'').trim()
  const named=s.match(/^定名[「"']([^」"']+)[」"']?$/)
  if(named) s=named[1].trim()
  s=s.replace(leadRe,'').replace(/^[「"']|[」"']$/g,'').trim()
  // task-112：含义编号/分组说明（如「2义同指工具义」「本条同指…」）不是语义链
  if(/^(\d+\s*义?同指|同指|该义|本条|上述义|对应义|\d+\s*义\s*[:：])/.test(s)) return null
  if(/义同指/.test(s)) return null
  if(!s || blacklistHit(s)) return null
  if([...s].length<2 || [...s].length>20) return null
  return s
}
const pack=JSON.parse(readFileSync(input,'utf8'))
let wordsChanged=0, stepsRemoved=0, stepsCleaned=0, stepsDropped=0
for(const item of pack.items??[]){
  for(const mapping of item.meaningMap??[]){
    if(!Array.isArray(mapping.steps)||mapping.steps.length===0) continue
    const before=mapping.steps
    const after=[]
    for(const step of before){const cleaned=cleanStep(step); if(cleaned&&!blacklistHit(cleaned)){if(cleaned!==step)stepsCleaned++;after.push(cleaned)} else stepsDropped++}
    if(after.length===0 && before.length>0){ stepsRemoved++; delete mapping.steps }
    else if(after.length!==before.length || after.some((s,i)=>s!==before[i])){ mapping.steps=after.length>=2?after:undefined; if(!mapping.steps){stepsRemoved++;delete mapping.steps} }
  }
  const changed=(item.meaningMap??[]).some(m=>Array.isArray(m.steps)&&m.steps.length>0) && false
}
// 统计有变化的词
function packChecksum(p){const stable=(v)=>{if(v==null)return 'null';const t=typeof v;if(t==='number')return Number.isFinite(v)?JSON.stringify(v):'null';if(t==='boolean')return v?'true':'false';if(t==='string')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(x=>x===undefined?'null':stable(x)).join(',')+']';if(t==='object'){const k=Object.keys(v).filter(x=>v[x]!==undefined).sort();return '{'+k.map(x=>JSON.stringify(x)+':'+stable(v[x])).join(',')+'}'}return 'null'};return createHash('sha256').update(stable({format:p.format,formatVersion:p.formatVersion,kind:p.kind,items:p.items})).digest('hex')}
// 重新扫描并记录改动词
const original=JSON.parse(readFileSync(input,'utf8'))
const changedWords=[]
for(let i=0;i<(pack.items??[]).length;i++){
  const a=(original.items??[])[i]; const b=(pack.items??[])[i]
  if(JSON.stringify(a?.meaningMap)!==JSON.stringify(b?.meaningMap)) changedWords.push(a?.headwordLower)
}
if(write){pack.checksum=packChecksum(pack); if(pack.meta?.stats){pack.meta.stats.stepsCleaned=stepsCleaned;pack.meta.stats.stepsDropped=stepsDropped;pack.meta.stats.stepsRemoved=stepsRemoved}; writeFileSync(output,JSON.stringify(pack)); console.log(`[clean-steps] ${input} -> ${output}: words=${changedWords.length} stepsCleaned=${stepsCleaned} stepsDropped=${stepsDropped} stepsRemoved=${stepsRemoved} checksum=${pack.checksum.slice(0,12)}…`)}
else {writeFileSync(output,JSON.stringify(pack)); console.log(`[clean-steps][dry-run] ${input}: words=${changedWords.length} stepsCleaned=${stepsCleaned} stepsDropped=${stepsDropped} stepsRemoved=${stepsRemoved} (未写原文件)`)}
