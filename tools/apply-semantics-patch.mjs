#!/usr/bin/env node
/** 把 v4 重生成 pack 的语义按 headword 覆盖回旧 pack（保留旧 pack 其余词），task-99。 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const args=process.argv.slice(2); const get=(k)=>{const i=args.indexOf(k);return i>=0?args[i+1]:null}
const basePath=get('--base'), patchPath=get('--patch'), outPath=get('--out')
if(!basePath||!patchPath||!outPath){console.error('用法: --base <old.pack.json> --patch <new.pack.json> --out <out.pack.json> [--deck id]');process.exit(1)}
function stable(v){if(v==null)return 'null';const t=typeof v;if(t==='number')return Number.isFinite(v)?JSON.stringify(v):'null';if(t==='boolean')return v?'true':'false';if(t==='string')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(x=>x===undefined?'null':stable(x)).join(',')+']';if(t==='object'){const k=Object.keys(v).filter(x=>v[x]!==undefined).sort();return '{'+k.map(x=>JSON.stringify(x)+':'+stable(v[x])).join(',')+'}'}return 'null'}
const base=JSON.parse(readFileSync(basePath,'utf8')); const patch=JSON.parse(readFileSync(patchPath,'utf8'))
const byLower=new Map((patch.items??[]).map(item=>[String(item.headwordLower??item.headword).toLowerCase(),item]))
let replaced=0,added=0
const seen=new Set()
base.items=(base.items??[]).map(item=>{const key=String(item.headwordLower??item.headword).toLowerCase();seen.add(key);const p=byLower.get(key);if(p){replaced++;return p}return item})
for(const item of patch.items??[]){const key=String(item.headwordLower??item.headword).toLowerCase();if(seen.has(key))continue;seen.add(key);base.items.push(item);added++}
base.meta=base.meta??{}
if(get('--deck')) base.meta.deckId=get('--deck')
base.meta.promptVersion=patch.meta?.promptVersion??'v4.0-semantics-grouped'
base.meta.stats={...(base.meta.stats??{}),patchedWords:replaced,addedWords:added,coreSenses:(base.items??[]).reduce((n,it)=>n+(it.coreSenses?.length??0),0),mappedMeanings:(base.items??[]).reduce((n,it)=>n+(it.meaningMap?.length??0),0)}
base.checksum=createHash('sha256').update(stable({format:base.format,formatVersion:base.formatVersion,kind:base.kind,items:base.items})).digest('hex')
writeFileSync(outPath,JSON.stringify(base))
console.log(`[apply-patch] ${basePath} <- ${patchPath}: replaced=${replaced} added=${added} items=${base.items.length} checksum=${base.checksum.slice(0,12)}…`)
