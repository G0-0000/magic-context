import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { Database } from "../packages/plugin/src/shared/sqlite";
import { contextStore } from "../packages/plugin/src/features/magic-context/__tests__/host-stalls.fixture";
import { acquireCompartmentLease, releaseCompartmentLease } from "../packages/plugin/src/features/magic-context/compartment-lease";
import { getCompartments } from "../packages/plugin/src/features/magic-context/compartment-storage";
import { getHistorianFailureState, getOrCreateSessionMeta } from "../packages/plugin/src/features/magic-context/storage";
import { runCompartmentAgent as head } from "../packages/plugin/src/hooks/magic-context/compartment-runner-incremental";
import { runCompartmentAgent as base } from "../packages/plugin/src/hooks/magic-context/compartment-runner-incremental.base-fixture";
import type { HiddenCompletionExecutor } from "../packages/plugin/src/hooks/magic-context/compartment-runner-types";
import { noteHistorianStartPass } from "../packages/plugin/src/hooks/magic-context/historian-start-read";
import { observeProducerModelsForTest } from "../packages/plugin/src/hooks/magic-context/producer-window-test-support";
import { readBoundarySnapshotRawState, type ProtectedTailBoundarySnapshot } from "../packages/plugin/src/hooks/magic-context/protected-tail-boundary";
import { getRawSessionMessageOrdinalCount, readRawSessionMessageIdOrdinalsForRange, readSessionChunk, withRawMessageProvider, type RawMessageProvider } from "../packages/plugin/src/hooks/magic-context/read-session-chunk";
import { readRawSessionMessageOrdinalByIdFromDb, readRawSessionMessageByIdFromDb, readRawSessionMessagePartsByIdFromDb, hasRawSessionMessageByIdFromDb, readRawSessionMessageOrdinalPageFromDb, countStoredRawSessionMessagesFromDb, countRawSessionMessageOrdinalsFromDb, getRawSessionSummaryEpoch, installRawSessionSummaryScan, readRawSessionMessageIdOrdinalsForRangeFromDb, readRawSessionMessagePageFromDb, scanRawSessionSummaryRows } from "../packages/plugin/src/hooks/magic-context/read-session-raw";
import { injectM0M1 } from "../packages/plugin/src/hooks/magic-context/inject-compartments";
import { V2StoreReader } from "../packages/plugin/src/v2/store-reader";
import { createV2RawMessageProvider, createV2RawMessageReader } from "../packages/plugin/src/v2/hooks/store";

const root = process.env.PROFILE_ROOT!;
assert(root?.includes("/magic-context/"));
if (!process.env.REUSE_ORDINAL_FIXTURE) await import("./long-session-freezes-proof");
await observeProducerModelsForTest(["test/fixture-historian"]);
const rawPath = join(root, "opencode.db");
if (!process.env.REUSE_ORDINAL_FIXTURE) {
const raw = new Database(rawPath);
raw.exec(`CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES ('s');
CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
CREATE INDEX part_message_id_id_idx ON part(message_id,id);
CREATE INDEX part_session_idx ON part(session_id);`);
const id = (i:number) => `m${String(i).padStart(8,"0")}`;
const part = raw.prepare("INSERT INTO part VALUES (?,?,?,0,0,?)");
raw.transaction(() => { for(let i=172620;i<=174941;i++) part.run(`p-${i}`,id(i),'s',JSON.stringify({type:'text',text:`meaningful historical source ${i}`})); })();
raw.close();
copyFileSync(rawPath, join(root, "fresh-copy.db"));
}

function source(path:string, generation:"v1"|"v2", session:string): {provider:RawMessageProvider; close:()=>void} {
 if(generation==='v2') { const p=createV2RawMessageProvider(createV2RawMessageReader(()=>new V2StoreReader(path)),session); return {provider:{...p,readMessages:()=>{throw Error('bounded only');}},close:()=>{}}; }
 const db=new Database(path,{readonly:true});
 installRawSessionSummaryScan(db,session,scanRawSessionSummaryRows(db,session),getRawSessionSummaryEpoch(session),true);
 return {provider:{historianReadSource:()=>({path,generation}),readMessages:()=>{throw Error('bounded only');},readMessageById:(id)=>readRawSessionMessageByIdFromDb(db,session,id),readMessagePartsById:(id)=>readRawSessionMessagePartsByIdFromDb(db,session,id),hasMessageById:(id)=>hasRawSessionMessageByIdFromDb(db,session,id),readMessageOrdinalById:(id)=>readRawSessionMessageOrdinalByIdFromDb(db,session,id),readMessageOrdinalPage:(after,limit)=>readRawSessionMessageOrdinalPageFromDb(db,session,after,limit),getStoredMessageCount:()=>countStoredRawSessionMessagesFromDb(db,session),getMessageCount:()=>countRawSessionMessageOrdinalsFromDb(db,session),readMessagePage:(after,limit,end,anchor)=>readRawSessionMessagePageFromDb(db,session,after,limit,end,anchor),readMessageIdOrdinalsForRange:(from,to)=>readRawSessionMessageIdOrdinalsForRangeFromDb(db,session,from,to)},close:()=>db.close()};
}
function snapshot(sessionId:string, offset=1):ProtectedTailBoundarySnapshot {
 const count=getRawSessionMessageOrdinalCount(sessionId), end=count-4;
 const idAt=(n:number)=>readRawSessionMessageIdOrdinalsForRange(sessionId,n,n).keys().next().value??null;
 const s:ProtectedTailBoundarySnapshot={sessionId,mode:'incremental-runner',offset,offsetMessageId:idAt(offset),protectedTailStart:end,protectedTailStartMessageId:idAt(end),eligibleEndOrdinal:end,eligibleEndMessageId:idAt(end-1),rawMessageCountAtTrigger:count,rawLastMessageIdAtTrigger:idAt(count),N:0,usagePercentage:50,usageInputTokens:1000,usageSource:'live',contextLimit:128000,executeThresholdPercentage:65,triggerBudget:1000,priorBoundaryOrdinal:end,migrationFloorActive:false,providerShapeVersion:'opencode-v1',cacheNamespace:sessionId,createdAt:0,rawRangeFingerprint:'',trueRawEligibleTokens:1000,oversizeAtomicUnit:false,boundaryReason:'test-legacy'};
 s.rawRangeFingerprint=readBoundarySnapshotRawState(s).fingerprint;
 return s;
}
async function run(db:Database, session:string, boundary:ProtectedTailBoundarySnapshot, baseline:boolean, measure=false) {
 let prompt='', opened=false, maxBlock=0,last=performance.now(), delays=0;
 const heartbeat=measure?setInterval(()=>{const now=performance.now();maxBlock=Math.max(maxBlock,now-last);last=now;},1):undefined;
 const stop=()=>{if(heartbeat){maxBlock=Math.max(maxBlock,performance.now()-last);clearInterval(heartbeat);}};
 const passTimer=!baseline?setInterval(()=>{if(!opened){delays++;noteHistorianStartPass(session);}},1000):undefined;
 const executor:HiddenCompletionExecutor={capabilities:{tools:false,harness:'opencode'},open:async()=>{opened=true;stop();return {id:'proof-child'};},attempt:async(_handle,request)=>{prompt=JSON.stringify(request.body);},collect:async()=>{const range=prompt.match(/Messages (\d+)-(\d+):/);assert(range,'prompt header missing');return {text:`<compartment start="${range[1]}" end="${range[2]}" title="History"><p1>Exact publication.</p1></compartment>`,reasoning:null,lengthCapped:false,usage:{input:0,output:0,cacheRead:0,cacheWrite:0}};},close:async()=>{}};
 const holder=`proof-${session}`;assert(acquireCompartmentLease(db,session,holder));
 try { await (baseline?base:head)({client:undefined,hiddenCompletionExecutor:executor,db,sessionId:session,boundarySnapshot:boundary,historianChunkTokens:2000,directory:'/tmp',memoryEnabled:false,model:{model:'test/fixture-historian'},forceDrainQuota:true,compartmentLeaseHolderId:holder}); }
 finally {stop();if(passTimer)clearInterval(passTimer);releaseCompartmentLease(db,session,holder);}
 assert(opened,`historian did not open ${session} (delay passes=${delays}): ${JSON.stringify(getHistorianFailureState(db,session))}`);
 assert.equal(getHistorianFailureState(db,session).failureCount,0,JSON.stringify(getHistorianFailureState(db,session)));
 const compartments=db.prepare('SELECT sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,p2,p3,p4,importance,episode_type FROM compartments WHERE session_id=? ORDER BY sequence').all(session);
 const served=injectM0M1({db,sessionId:session,state:getOrCreateSessionMeta(db,session) as never,projectPath:'git:ordinal-proof',projectDirectory:root,injectDocs:false,memoryEnabled:false,historyBudgetTokens:60000,isCacheBustingPass:true});
 return {prompt,compartments,served:JSON.stringify(served.preparedMessages),maxBlock,delays};
}

for(const cold of [false,true]) {
 const path=join(root,cold?'fresh-copy.db':'opencode.db');
 const s=source(path,'v1','s');
 for(const baseline of [true,false]) {
  const contextPath=join(root,`large-${cold}-${baseline}.db`);copyFileSync(join(root,'context.db'),contextPath);
  const context=new Database(contextPath);
  try { await withRawMessageProvider('s',s.provider,async()=>{const boundary=snapshot('s',172621);const result=await run(context,'s',boundary,baseline,true);console.log(JSON.stringify({fixture:'original 174941 / 227840 tags / 2466 compartments (original script publication included)',freshCopy:cold,baseline,maxBlockMs:result.maxBlock,startDelayPasses:result.delays,published:getCompartments(context,'s').length}));if(!baseline)assert(result.maxBlock<50,'main thread start block >=50ms');}); }
  finally{context.close();}
 }
 s.close();
}

let seed=0xc0ffee;
const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
for(const generation of ['v1','v2'] as const) {
 const path=join(root,`random-${generation}.db`), writer=new Database(path);
 writer.exec(generation==='v1'?`CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE INDEX part_message_id_id_idx ON part(message_id,id); CREATE INDEX part_session_idx ON part(session_id);`:`CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);`);
 const left=contextStore(join(root,`${generation}-left.db`)),right=contextStore(join(root,`${generation}-right.db`));
 const delayDistribution:Record<string,number>={};
 try {
  for(let pass=0;pass<300;pass++) {
   const session=`${generation}-random-${pass}`,count=16+Math.floor(rng()*24);
   writer.transaction(()=>{for(let i=1;i<=count;i++) {
    const rowId=`${session}-m${i}`,text=`${pass}/${i}: `+'λ source '.repeat(1+Math.floor(rng()*30));
    if(generation==='v1') {
     writer.prepare('INSERT OR IGNORE INTO session VALUES (?)').run(session);
     const summary=i%11===0,info={role:i%2?'user':'assistant',summary:i%3===0?1:summary,finish:summary?'stop':'length'};
     writer.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(rowId,session,i,i,JSON.stringify(info));
     writer.prepare('INSERT INTO part VALUES (?,?,?,0,0,?)').run(`p-${rowId}`,rowId,session,JSON.stringify({type:'text',text}));
    } else writer.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run(rowId,session,i%11===0?'compaction':i%13===0?'idle':i%2?'user':'assistant',i*3,i,JSON.stringify({content:[{type:'text',text}]}));
   }})();
   const s=source(path,generation,session);
   try {await withRawMessageProvider(session,s.provider,async()=>{
    const boundary=snapshot(session);
    const before=await run(left,session,boundary,true);
    const after=await run(right,session,boundary,false);
    assert.equal(after.prompt,before.prompt,`${generation} prompt ${pass}`);
    assert.deepEqual(after.compartments,before.compartments,`${generation} publication ${pass}`);
    assert.equal(after.served,before.served,`${generation} served bytes ${pass}`);
    delayDistribution[after.delays]=(delayDistribution[after.delays]??0)+1;
   });}finally{s.close();}
  }
  console.log(JSON.stringify({differential:generation,passes:300,servedBytes:'identical',prompts:'identical',publishedCompartmentsAndBoundaries:'identical',delayDistribution,passIntervalMs:1000}));
 }finally{left.close();right.close();writer.close();}
}
console.log('ORDINAL OFFTHREAD PROOF PASSED');
