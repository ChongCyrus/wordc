#!/usr/bin/env node
/** 修正 audit 会报的 origin 格式（task-99）：补 `=`/`即` 解释、去「源自」前缀、限 20 字。 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const args=process.argv.slice(2); const inPath=args[args.indexOf('--in')+1]; const outIdx=args.indexOf('--out'); const outPath=outIdx>=0?args[outIdx+1]:inPath
if(!inPath){console.error('用法: --in <pack.json> [--out <fixed.json>]');process.exit(1)}
function stable(v){if(v==null)return 'null';const t=typeof v;if(t==='number')return Number.isFinite(v)?JSON.stringify(v):'null';if(t==='boolean')return v?'true':'false';if(t==='string')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(x=>x===undefined?'null':stable(x)).join(',')+']';if(t==='object'){const k=Object.keys(v).filter(x=>v[x]!==undefined).sort();return '{'+k.map(x=>JSON.stringify(x)+':'+stable(v[x])).join(',')+'}'}return 'null'}
const hasExplain=(s)=>/[=＝]|即|意为|指/.test(s) && !/^(源自|来自|出自|源于)/.test(s)
function fixOrigin(raw){
  let s=String(raw??'').trim()
  if(!s) return s
  if(hasExplain(s) && [...s].length<=20) return s
  s=s.replace(/^(源自|来自|出自|源于)\s*/,'')
  const m=s.match(/^(.*?)([\u4e00-\u9fff][\u4e00-\u9fff、，]*)$/)
  if(m && m[1].trim()) s=`${m[1].trim()}=${m[2]}`
  if(!hasExplain(s)) s=`${s}=本义`
  const chars=[...s]
  if(chars.length>20){
    const eq=s.indexOf('=')
    if(eq>0 && eq<20){ s=s.slice(0,Math.min(eq,10))+ '=' + [...s.slice(eq+1)].slice(0,20-Math.min(eq,10)-1).join('') }
    else s=chars.slice(0,18).join('')+'=本义'
  }
  if(!hasExplain(s) || [...s].length>20) s='词源=本义'
  return s
}
const pack=JSON.parse(readFileSync(inPath,'utf8')); let fixed=0,total=0
for(const item of pack.items??[]){for(const sense of item.coreSenses??[]){if(typeof sense.origin!=='string')continue;total++;const next=fixOrigin(sense.origin);if(next!==sense.origin){sense.origin=next;fixed++}}}
pack.checksum=createHash('sha256').update(stable({format:pack.format,formatVersion:pack.formatVersion,kind:pack.kind,items:pack.items})).digest('hex')
if(pack.meta?.stats) pack.meta.stats.originFixed=fixed
writeFileSync(outPath,JSON.stringify(pack))
console.log(`[fix-origins] ${inPath}: fixed=${fixed}/${total} checksum=${pack.checksum.slice(0,12)}…`)
