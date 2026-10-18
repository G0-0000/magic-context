import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../packages/plugin/src/shared/sqlite';
import { initializeDatabase } from '../packages/plugin/src/features/magic-context/storage-db';
import { getLastCompartmentEndMessage, isPartialCompartmentEnd } from '../packages/plugin/src/features/magic-context/compartment-storage';
import { getSourceContents } from '../packages/plugin/src/features/magic-context/storage-source';
import { getTriggerTagTokenUpperBound, TAG_OWNER_APPENDED_WITH_SHAPE_SQL } from '../packages/plugin/src/features/magic-context/storage-tags';
import { readAllTrailingBlankDecisions } from '../packages/plugin/src/features/magic-context/storage-replay-document';
import { prepareLegacyToolSkeletonConversions } from '../packages/plugin/src/hooks/magic-context/apply-operations';
import { readRawSessionMessageIdOrdinalsForRangeFromDb, scanRawSessionSummaryRows, installRawSessionSummaryScan, getRawSessionSummaryEpoch } from '../packages/plugin/src/hooks/magic-context/read-session-raw';
import type { TagTarget } from '../packages/plugin/src/hooks/magic-context/tag-messages';
const root = process.env.PROFILE_ROOT!;
if (!root?.includes('/magic-context/')) throw Error('throwaway PROFILE_ROOT required');
mkdirSync(root, {recursive:true});
const db = new Database(join(root,'context.db'));
initializeDatabase(db);
const raw = new Database(join(root,'opencode.db'));
raw.exec(`CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);`);
const id=(i:number)=>`m${String(i).padStart(8,'0')}`;
const pad='representative message metadata '.repeat(40);
raw.transaction(()=>{const s=raw.prepare("INSERT INTO message VALUES (?,'s',?,?,?)");for(let i=1;i<=174941;i++)s.run(id(i),i,i,JSON.stringify({role:i%2?'user':'assistant',pad}));})();
db.transaction(()=>{
 const t=db.prepare("INSERT INTO tags(session_id,tag_number,message_id,type,status,drop_mode,token_count) VALUES ('s',?,?,'tool',?,?,50)");
 const src=db.prepare("INSERT INTO source_contents(tag_id,session_id,content,created_at) VALUES (?,'s',?,0)");
 for(let i=1;i<=227840;i++){t.run(i,id(i),i<=136969?'dropped':'active',i%2?'truncated':'full');src.run(i,'source '.repeat(100));}
 const c=db.prepare("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES ('s',?,?,?,?,?,'episode',?,0)");
 for(let i=0;i<2465;i++)c.run(i,i*70+1,i*70+70,id(i*70+1),id(i*70+70),'summary '.repeat(1000));
})();
function measure(name:string, fn:()=>unknown){const times=[];for(let i=0;i<5;i++){const st=performance.now();fn();times.push(+(performance.now()-st).toFixed(2));}console.log(JSON.stringify({name,ms:times}));}
console.log(JSON.stringify({bun:Bun.version,counts:{messages:174941,tags:227840,dropped:136969,compartments:2465}}));
measure('last compartment',()=>getLastCompartmentEndMessage(db,'s'));
measure('source 300',()=>getSourceContents(db,'s',Array.from({length:300},(_,i)=>136969-i)));
measure('trailing decisions',()=>readAllTrailingBlankDecisions(db,'s',''));
measure('trigger bound scoped',()=>getTriggerTagTokenUpperBound(db,'s',227500));
measure('trigger bound unscoped',()=>getTriggerTagTokenUpperBound(db,'s'));
measure('partial compartment',()=>isPartialCompartmentEnd(db,'s',id(174940)));
measure('foreign shape',()=>db.prepare(TAG_OWNER_APPENDED_WITH_SHAPE_SQL).all(227840,'s','tag-identity:s','s'));
const targets = new Map<number,TagTarget>();
for(let i=136700;i<=136969;i++)targets.set(i,{canDrop:()=>true,cannotRemove:()=>false,inputStringBytes:()=>50} as unknown as TagTarget);
measure('head fold conversions',()=>{const p=prepareLegacyToolSkeletonConversions(db,'s',targets);if(!p.isCurrent(db))throw Error('stale');});
const baseOps=await import('../packages/plugin/src/hooks/magic-context/apply-operations.base-fixture');
measure('base fold conversions',()=>{const p=baseOps.prepareLegacyToolSkeletonConversions(db,'s',targets);if(!p.isCurrent(db))throw Error('stale');});
const baseRaw=await import('../packages/plugin/src/hooks/magic-context/read-session-raw.base-fixture');
measure('base ordinal late range',()=>baseRaw.readRawSessionMessageIdOrdinalsForRangeFromDb(raw,'s',174900,174941));
const warm=performance.now();
installRawSessionSummaryScan(raw,'s',scanRawSessionSummaryRows(raw,'s'),getRawSessionSummaryEpoch('s'),true);
console.log(JSON.stringify({stage:'worker-equivalent rank seed (not pass)',ms:performance.now()-warm}));
measure('exact ordinal late range unchanged',()=>readRawSessionMessageIdOrdinalsForRangeFromDb(raw,'s',174900,174941));
const narrowSQL = `SELECT id, CASE WHEN json_valid(data) THEN json_type(data) = 'object' ELSE 0 END AS valid FROM message WHERE session_id=? AND CASE WHEN json_valid(data) THEN NOT (COALESCE(json_type(data,'$.summary'),'')='true' AND COALESCE(json_extract(data,'$.finish'),'')='stop') ELSE 1 END ORDER BY time_created,id LIMIT ? OFFSET ?`;
measure('exact narrow SQL late range',()=>raw.prepare(narrowSQL).all('s',42,174899));
measure('exact ordinal full range',()=>readRawSessionMessageIdOrdinalsForRangeFromDb(raw,'s',1,Number.MAX_SAFE_INTEGER));
measure('exact narrow SQL full range',()=>raw.prepare(narrowSQL).all('s',Number.MAX_SAFE_INTEGER,0));
db.close();raw.close();

// The baseline modules are extracted verbatim with git show before this script runs.
const { createTagger } = await import('../packages/plugin/src/features/magic-context/tagger');
const { tagMessages } = await import('../packages/plugin/src/hooks/magic-context/tag-messages');
const { applyFlushedStatuses, renderConvertedToolSkeletons } = await import('../packages/plugin/src/hooks/magic-context/apply-operations');
const { tagTranscript } = await import('../packages/plugin/src/shared/tag-transcript');
const { createPiTranscript } = await import('../packages/pi-plugin/src/transcript-pi');
const { adaptPayload } = await import('../packages/plugin/src/v2/hooks/payload');
let seed=0xc0ffee;
const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const assertEqual=(a:unknown,b:unknown,label:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`differential mismatch ${label}`);};
for (const host of ['oc1','oc2','pi'] as const) {
 const left=new Database(':memory:'); const right=new Database(':memory:');
 initializeDatabase(left);initializeDatabase(right);
 let fold=0, deferred=0, publication=0;
 for(let pass=0;pass<300;pass++) {
  const session=`${host}-${pass}`;
  const phase=pass%3===0?'fold':pass%3===1?'defer':'historian-publication';
  const spec=Array.from({length:6},(_,i)=>({id:`call-${i}`,input:{command:'λ'.repeat(Math.floor(rng()*1600))},reasoning:rng()<0.2,incomplete:rng()<0.1,mode:['truncated','full','skeleton_real'][Math.floor(rng()*3)],status:rng()<0.8?'dropped':'active'}));
  const tailUser=rng()<0.75;
  const keep=new Set(spec.filter(()=>rng()<0.2).map(s=>s.id));
  function run(connection:Database,baseline:boolean) {
   const tagger=createTagger();
   let targets:Map<number,TagTarget>;
   let finish:()=>unknown;
   if(host==='pi') {
    const source:unknown[]=spec.flatMap((s,i)=>[
     {role:'assistant',timestamp:i*3,content:[...(s.reasoning?[{type:'thinking',thinking:'reasoning'}]:[]),{type:'toolCall',id:s.id,name:'bash',arguments:s.input}]},
     ...(s.incomplete?[]:[{role:'toolResult',toolCallId:s.id,toolName:'bash',timestamp:i*3+1,content:[{type:'text',text:'tool result'}]}]),
    ]);
    if(tailUser)source.push({role:'user',content:'next prompt',timestamp:30});
    const transcript=createPiTranscript(source,session,source.map((_,i)=>`entry-${i}`),{preserveReasoningToolArcs:true});
    targets=tagTranscript(session,transcript,tagger,connection).targets;
    finish=()=>{transcript.commit();transcript.finalizeToolRemovals();return transcript.getOutputMessages();};
   } else {
    const source=spec.map((s,i)=>({info:{id:`m-${i}`,role:'assistant',sessionID:session},parts:[...(s.reasoning?[{type:'reasoning',text:'reasoning'}]:[]),{type:'tool',tool:'bash',callID:s.id,state:{status:s.incomplete?'running':'completed',input:s.input,output:'tool result'}}]}));
    if(tailUser)source.push({info:{id:'m-next',role:'user',sessionID:session},parts:[{type:'text',text:'next prompt'}]} as never);
    if(host==='oc2') {
     const context={sessionID:session,model:{providerID:'provider',id:'model'},agent:'build',system:[],tools:{},options:{},messages:spec.flatMap((s,i)=>[
      {id:`m-${i}`,role:'assistant',content:[...(s.reasoning?[{type:'reasoning',text:'reasoning'}]:[]),{type:'tool-call',id:s.id,name:'bash',input:s.input}]},
      ...(s.incomplete?[]:[{id:`r-${i}`,role:'user',content:[{type:'tool-result',id:s.id,name:'bash',resultType:'success',result:{type:'text',value:'tool result'}}]}]),
     ])};
     if(tailUser)context.messages.push({id:'m-next',role:'user',content:[{type:'text',text:'next prompt'}]} as never);
     const adapted=adaptPayload(context as never);
     const tagged=tagMessages(session,adapted.messages,tagger,connection);
     targets=tagged.targets;
     finish=()=>{tagged.batch.finalize();adapted.commit();return context.messages;};
    } else {
     const tagged=tagMessages(session,source as never,tagger,connection);
     targets=tagged.targets;finish=()=>{tagged.batch.finalize();return source;};
    }
   }
   const tags=connection.prepare("SELECT tag_number,message_id FROM tags WHERE session_id=? AND type='tool'").all(session) as {tag_number:number,message_id:string}[];
   for(const row of tags){const s=spec.find(s=>s.id===row.message_id)!;connection.prepare('UPDATE tags SET status=?,drop_mode=? WHERE session_id=? AND tag_number=?').run(s.status,s.mode,session,row.tag_number);}
   const extra=connection.prepare("INSERT INTO tags(session_id,tag_number,message_id,type,status,drop_mode) VALUES (?,?,'off-wire','tool','dropped','truncated')");
   for(let i=100;i<120;i++)extra.run(session,i);
   applyFlushedStatuses(session,connection,targets);
   if(phase==='fold') {
    const prepare=baseline?baseOps.prepareLegacyToolSkeletonConversions:prepareLegacyToolSkeletonConversions;
    const p=prepare(connection,session,targets,{keepFullDrop:(id)=>id!==null&&keep.has(id)});
    if(!p.isCurrent(connection))throw Error('unexpected contention');
    p.persist(connection);renderConvertedToolSkeletons(targets,p.converted);
   }
   return {wire:finish(),modes:connection.prepare('SELECT tag_number,status,drop_mode FROM tags WHERE session_id=? ORDER BY tag_number').all(session)};
  }
  assertEqual(run(left,true),run(right,false),`${host} ${phase} ${pass}`);
  if(phase==='fold')fold++;else if(phase==='defer')deferred++;else publication++;
 }
 console.log(JSON.stringify({differential:host,passes:300,fold,defer:deferred,historianPublication:publication,servedBytes:'identical',storedDropModes:'identical',ordinals:'production readers unchanged'}));
 left.close();right.close();
}

const { copyFileSync }=await import('node:fs');
const { injectM0M1 }=await import('../packages/plugin/src/hooks/magic-context/inject-compartments');
const { getOrCreateSessionMeta }=await import('../packages/plugin/src/features/magic-context/storage');
copyFileSync(join(root,'context.db'),join(root,'base-context.db'));
for(const baseline of [true,false]) {
 const connection=new Database(join(root,baseline?'base-context.db':'context.db'));
 const state=getOrCreateSessionMeta(connection,'s');
 const originalPrepare=connection.prepare.bind(connection);
 let stats:Record<string,{calls:number,rows:number,ms:number}>={};
 connection.prepare=((sql:string)=>{
  const stmt=originalPrepare(sql);
  const name=sql.includes('SELECT tag_number AS tagNumber')?'conversion rows':sql.includes('MAX(end_message)')?'last compartment':sql.includes('FROM source_contents')?'sources':sql.includes('FROM session_replay_decisions')?'replay decisions':sql.includes('AS null_count')?'trigger bound':sql.includes('end_message_id=? AND end_block_index')?'partial end':sql.includes('0 AS shape, NULL AS tag_count')?'foreign shape':null;
  if(!name)return stmt;
  return new Proxy(stmt,{get(object,key){const value=Reflect.get(object,key);if(key==='all'||key==='get'||key==='run')return(...args:unknown[])=>{const start=performance.now();const out=value.apply(object,args);const record=stats[name]??={calls:0,rows:0,ms:0};record.calls++;record.rows+=Array.isArray(out)?out.length:out?1:0;record.ms+=performance.now()-start;return out;};return typeof value==='function'?value.bind(object):value;}});
 }) as typeof connection.prepare;
 for(const phase of ['fold','defer','historian-publication'] as const){
  stats={};let preparations=0,validations=0,conversionMs=0;
  if(phase==='historian-publication')connection.prepare("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES ('s',2465,172551,172620,'m00172551','m00172620','new episode','new historian summary',1)").run();
  const start=performance.now();
  const out=injectM0M1({db:connection,sessionId:'s',state:state as never,projectPath:'git:long-session-proof',projectDirectory:root,injectDocs:false,memoryEnabled:false,historyBudgetTokens:60000,isCacheBustingPass:phase!=='defer',onFoldPrepare:()=>{
   preparations++;const st=performance.now();const p=(baseline?baseOps.prepareLegacyToolSkeletonConversions:prepareLegacyToolSkeletonConversions)(connection,'s',targets);conversionMs+=performance.now()-st;
   return(writer)=>{validations++;const t=performance.now();if(!p.isCurrent(writer))throw Error('contention');p.persist(writer);conversionMs+=performance.now()-t;};
  }});
  console.log(JSON.stringify({pass:phase,baseline,totalSyncMs:performance.now()-start,preparations,validations,conversionMs,targets:targets.size,readers:stats,outputMessages:out.preparedMessages?.length}));
 }
 connection.close();
}
