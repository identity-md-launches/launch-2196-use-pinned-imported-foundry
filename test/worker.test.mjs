import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex } from '../vendor/viem.mjs';
import { FundingStore, decisionKey } from '../worker/store.mjs';
import { FundingEngine } from '../worker/engine.mjs';
import { validateLiveConfig } from '../worker/chain-adapter.mjs';
import { DuelFundingBudget } from '../worker/budget.mjs';
import { runFundingService } from '../worker/service.mjs';

const PRICE=500000000000000000n, CONTRACT='0x1111111111111111111111111111111111111111';
class LocalAdapter {
  localOnly=true; liveAuthorized=false; prices=PRICE; prepareCount=0; broadcasts=[]; results=new Map();
  funds={requestBalance:100n*PRICE,treasuryBalance:0n,pendingFees:0n,gas:100000n};
  async assertReady() {if(this.offline) throw Error('Offline');}
  async balances() {return this.funds;}
  async terms() {return {amount:this.prices};}
  async preflight() {return {approved:true};}
  async prepare(row) {this.prepareCount++; const raw=toHex(JSON.stringify({id:row.id,nonce:this.prepareCount,kind:row.kind,amount:row.amount}));return {raw,hash:keccak256(raw)};}
  async broadcast(raw) {const hash=keccak256(raw);this.broadcasts.push(raw);if(this.loseReply) throw Error('Connection lost');return hash;}
  async reconcile(row) {return this.results.get(row.hash)??{state:'absent'};}
  confirm(row) {this.results.set(row.hash,{state:'confirmed',requestId:'0x'+'a'.repeat(64),bodyHash:row.kind==='request'?keccak256(toHex(JSON.parse(row.payload).body)):null});}
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'cabal-funding-'));const path=join(dir,'ledger.db');const store=new FundingStore(path);const adapter=new LocalAdapter();
  let stores=[store]; t.after(()=>{for(const s of stores) {try{s.close();}catch{}} rmSync(dir,{recursive:true,force:true});});
  const reopen=()=>{const s=new FundingStore(path);stores.push(s);return s;};
  const engine=new FundingEngine({store,adapter,mode:'simulate',minGasWei:1n});
  const enqueue=(round=1,seat=0,body='{"v":1}')=>store.enqueue({id:decisionKey(4663,CONTRACT,'match-1',round,seat),match:'match-1',amount:PRICE,body});
  store.reserveMatch('match-1',8n*PRICE,adapter.funds.requestBalance);
  return {store,adapter,engine,enqueue,reopen};
}
test('default mode never touches an adapter or spends',async()=>{const engine=new FundingEngine({store:null,adapter:new Proxy({},{get(){throw Error('Touched adapter');}})});assert.deepEqual(await engine.runOnce(),{state:'disabled'});});
test('live execution and wrong simulation adapters fail closed',()=>{
  assert.throws(()=>new FundingEngine({store:null,adapter:{},mode:'live'}),/not authorized/);
  assert.throws(()=>new FundingEngine({store:null,adapter:{},mode:'simulate'}),/local-only/);
  assert.throws(()=>validateLiveConfig({mode:'disabled'}),/disabled/);
  assert.throws(()=>validateLiveConfig({mode:'live',liveExecutionApproved:true,chainId:1}),/network/);
});
test('8 decisions reserve once, pay once each and release unused funds',async t=>{
  const f=fixture(t); for(let r=1;r<=4;r++) for(let s=0;s<2;s++) f.enqueue(r,s);
  for(let i=0;i<8;i++) {assert.equal((await f.engine.runOnce()).state,'submitted'); const row=f.store.next();f.adapter.confirm(row);assert.equal((await f.engine.runOnce()).state,'confirmed');}
  assert.equal(f.adapter.broadcasts.length,8);assert.equal(f.store.reserved(),0n);f.store.closeMatch('match-1');
});
test('duplicate identity is idempotent but changed input is rejected',t=>{
  const f=fixture(t);const a=f.enqueue();const b=f.enqueue();assert.equal(a.id,b.id);assert.throws(()=>f.enqueue(1,0,'changed'),/different input/);
  assert.notEqual(decisionKey(4663,CONTRACT,'match-1',1,0),decisionKey(4663,CONTRACT,'match-1',1,1));
});
test('atomic reservations reject oversubscription across worker instances',t=>{
  const f=fixture(t);const second=f.reopen();const balance=10n*PRICE;
  assert.throws(()=>second.reserveMatch('match-2',8n*PRICE,balance),/Insufficient/);
  assert.throws(()=>second.reserveMatch('match-1',1n,balance),/already/);
  assert.equal(second.reserved(),8n*PRICE);
});
test('lost broadcast reply and process restart reconcile without paying again',async t=>{
  const f=fixture(t);const request=f.enqueue();f.adapter.loseReply=true;assert.equal((await f.engine.runOnce()).state,'uncertain');
  const saved=f.store.get(request.id);assert.equal(keccak256(saved.raw),saved.hash);
  f.adapter.confirm(saved);const store=f.reopen();const recovered=new FundingEngine({store,adapter:f.adapter,mode:'simulate'});
  assert.equal((await recovered.runOnce()).state,'confirmed');assert.equal(f.adapter.prepareCount,1);assert.equal(f.adapter.broadcasts.length,1);
  assert.equal(store.reserved(),7n*PRICE);
});
test('unseen transaction rebroadcasts identical signed bytes and nonce',async t=>{
  const f=fixture(t);f.enqueue();await f.engine.runOnce();await f.engine.runOnce();
  assert.equal(f.adapter.prepareCount,1);assert.equal(f.adapter.broadcasts.length,2);assert.equal(f.adapter.broadcasts[0],f.adapter.broadcasts[1]);
});
test('pending confirmation prevents new payment or automatic replacement',async t=>{
  const f=fixture(t);f.enqueue();f.enqueue(1,1);await f.engine.runOnce();const row=f.store.next();f.adapter.results.set(row.hash,{state:'pending'});
  assert.equal((await f.engine.runOnce()).state,'pending');assert.equal(f.adapter.prepareCount,1);assert.equal(f.adapter.broadcasts.length,1);
  assert.throws(()=>f.store.closeMatch('match-1'),/reconciled/);
});
test('crash during signing can retry preparation; no send occurred',async t=>{
  const f=fixture(t);const row=f.enqueue();f.store.patch(row.id,{state:'preparing'});assert.equal((await f.engine.runOnce()).state,'submitted');assert.equal(f.adapter.broadcasts.length,1);
});
test('reorg and mismatched result block further spending and keep reservations',async t=>{
  const f=fixture(t);f.enqueue();await f.engine.runOnce();f.adapter.results.set(f.store.next().hash,{state:'reorg'});
  assert.equal((await f.engine.runOnce()).state,'blocked');f.enqueue(1,1);assert.equal((await f.engine.runOnce()).state,'blocked');assert.equal(f.store.reserved(),8n*PRICE);
});
test('confirmed wrong body is never treated as the expected decision payment',async t=>{
  const f=fixture(t);f.enqueue();await f.engine.runOnce();f.adapter.results.set(f.store.next().hash,{state:'confirmed',bodyHash:'wrong'});
  assert.equal((await f.engine.runOnce()).state,'blocked');assert.equal(f.store.reserved(),8n*PRICE);
});
test('confirmed revert is recorded without automatic new paid attempt',async t=>{
  const f=fixture(t);f.enqueue();await f.engine.runOnce();f.adapter.results.set(f.store.next().hash,{state:'reverted'});
  assert.equal((await f.engine.runOnce()).state,'failed');assert.equal((await f.engine.runOnce()).state,'idle');assert.equal(f.adapter.broadcasts.length,1);f.store.closeMatch('match-1');
});
test('gas exhaustion, IMD exhaustion, price change and provider outage send nothing',async t=>{
  const f=fixture(t);f.enqueue();f.adapter.funds.gas=0n;assert.equal((await f.engine.runOnce()).state,'low_gas');
  f.adapter.funds.gas=100n;f.adapter.funds.requestBalance=0n;assert.equal((await f.engine.runOnce()).state,'low_imd');
  f.adapter.funds.requestBalance=10n*PRICE;f.adapter.prices=2n*PRICE;assert.equal((await f.engine.runOnce()).state,'price_changed');
  assert.equal(f.store.blocked(),true);
  f.adapter.offline=true;assert.equal((await f.engine.runOnce()).state,'blocked');assert.equal(f.adapter.broadcasts.length,0);
});
test('automatic maintenance prepares only fixed contract functions and is durable',async t=>{
  const f=fixture(t);f.adapter.funds.pendingFees=40n*10n**18n;assert.equal((await f.engine.runOnce()).state,'submitted');
  const harvest=f.store.next();assert.equal(harvest.kind,'harvest');f.adapter.confirm(harvest);await f.engine.runOnce();
  f.adapter.funds.pendingFees=0n;f.adapter.funds.treasuryBalance=12n*10n**18n;
  assert.equal((await f.engine.runOnce()).state,'submitted');assert.equal(f.store.next().kind,'treasury');
});
test('lease fences concurrent workers and expires safely',async t=>{
  const f=fixture(t);f.enqueue();const other=f.reopen();assert.equal(other.acquire(),true);assert.equal((await f.engine.runOnce()).state,'busy');other.release();
  const original=f.adapter.prepare.bind(f.adapter);f.adapter.prepare=async row=>{const result=await original(row);f.store.db.prepare('UPDATE leases SET until_ms=0').run();return result;};
  assert.equal((await f.engine.runOnce()).state,'unavailable');assert.equal(f.adapter.broadcasts.length,0);
});
test('16 simultaneous BO5 budgets account for 128 maximum decisions',t=>{
  const f=fixture(t);const initial=64n*10n**18n;for(let i=2;i<=16;i++) f.store.reserveMatch('match-'+i,8n*PRICE,initial);
  assert.equal(f.store.reserved(),initial);assert.throws(()=>f.store.reserveMatch('match-17',8n*PRICE,initial),/Insufficient/);
});
test('a deep reorg after confirmation halts the persistent worker before more spending',async t=>{
  const f=fixture(t);f.enqueue();await f.engine.runOnce();const row=f.store.next();f.adapter.confirm(row);
  f.adapter.results.get(row.hash).checkpoint={number:'42',hash:'canonical-at-confirmation'};
  await f.engine.runOnce();f.enqueue(1,1);f.adapter.verifyCheckpoint=async()=>false;
  assert.equal((await f.engine.runOnce()).state,'blocked');assert.equal(f.adapter.broadcasts.length,1);
  const reopened=f.reopen();assert.equal(reopened.blocked(),true);
});
test('loopback adapter rejects public RPCs even with simulation mode',async()=>{
  const {createLocalChainAdapter}=await import('../worker/chain-adapter.mjs');
  assert.throws(()=>createLocalChainAdapter({mode:'simulate',chainId:31337,rpcUrl:'https://rpc.mainnet.chain.robinhood.com'},{}),/Local EVM/);
  assert.throws(()=>createLocalChainAdapter({mode:'simulate',chainId:4663,rpcUrl:'http://127.0.0.1:8545'},{}),/Local EVM/);
});
test('server admission reserves eight decisions plus a configured buffer',async t=>{
  const f=fixture(t);const config={mode:'simulate',chainId:4663,contract:CONTRACT,requestPriceAtomic:PRICE.toString(),minimumGasBalanceWei:'1',minimumImdReserveAtomic:(2n*PRICE).toString()};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  f.adapter.funds.requestBalance=18n*PRICE;await budget.admit('match-2');assert.equal(f.store.reserved(),16n*PRICE);
  await assert.rejects(budget.admit('match-3'),/Insufficient/);
});
test('server queue freezes explicit public fields and refuses invalid oracle outputs',async t=>{
  const f=fixture(t);const config={mode:'simulate',chainId:4663,contract:CONTRACT,requestPriceAtomic:PRICE.toString()};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  const input={v:1,chainId:4663,question:'What is the remainder when the decimal integer 7 is divided by 4?',answerType:'uint256',evidence:'panel',panelSize:5,quorum:4,toleranceBps:0,guards:{min:'0',max:'3'},privatePolicy:'must not leave server',account:{private:true}};
  const row=await budget.queueDecision({matchId:'match-1',round:1,seat:0,input});const publicInput=JSON.parse(JSON.parse(row.payload).body);
  assert.equal(publicInput.privatePolicy,undefined);assert.equal(publicInput.account,undefined);assert.equal(publicInput.validForSeconds,300);
  await assert.rejects(()=>budget.queueDecision({matchId:'match-1',round:1,seat:1,input:{...input,answerType:'text'}}),/Invalid/);
});
test('background service remains inert with default disabled configuration',async()=>{
  const updates=[];await runFundingService({store:null,adapter:{},config:{},onStatus:status=>updates.push(status)});assert.deepEqual(updates,[{state:'disabled'}]);
});
test('permissionless fee settlement cannot strand unsigned maintenance ahead of requests',async t=>{
  const f=fixture(t);f.enqueue();
  const stale=f.store.enqueueMaintenance('harvest',40n*10n**18n);f.store.patch(stale.id,{state:'preparing'});
  assert.equal((await f.engine.runOnce()).state,'superseded');
  assert.equal(f.adapter.broadcasts.length,0);
  assert.equal((await f.engine.runOnce()).state,'submitted');assert.equal(f.store.next().kind,'request');
});
test('partial permissionless settlement resizes unsigned maintenance, never signed bytes',async t=>{
  const f=fixture(t);f.adapter.funds.treasuryBalance=3n*PRICE;
  const stale=f.store.enqueueMaintenance('treasury',5n*PRICE);
  assert.equal((await f.engine.runOnce()).state,'submitted');assert.equal(f.store.get(stale.id).amount,(3n*PRICE).toString());
  assert.throws(()=>f.store.resizeUnsignedMaintenance(stale.id,1n),/unsigned/);
  f.adapter.funds.treasuryBalance=1n*PRICE;
  await f.engine.runOnce();assert.equal(f.adapter.broadcasts[0],f.adapter.broadcasts[1]);
});
test('admission holds the coordinator lease across its asynchronous balance snapshot',async t=>{
  const f=fixture(t);const other=f.reopen();
  const config={mode:'simulate',requestPriceAtomic:PRICE.toString(),minimumGasBalanceWei:'1',minimumImdReserveAtomic:'0'};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  const competing=new FundingEngine({store:other,adapter:f.adapter,mode:'simulate'});
  f.adapter.balances=async()=>{assert.equal((await competing.runOnce()).state,'busy');return f.adapter.funds;};
  await budget.admit('match-2');assert.equal(f.store.reserved(),16n*PRICE);assert.equal(other.acquire(),true);other.release();
});
test('admission rejects a stale balance snapshot after lease expiry',async t=>{
  const f=fixture(t);const config={mode:'simulate',requestPriceAtomic:PRICE.toString(),minimumGasBalanceWei:'1',minimumImdReserveAtomic:'0'};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  f.adapter.balances=async()=>{f.store.db.prepare('UPDATE leases SET until_ms=0').run();return f.adapter.funds;};
  await assert.rejects(budget.admit('match-2'),/lease lost/);assert.equal(f.store.reserved(),8n*PRICE);
});

test('oversized and malformed Unicode questions cannot enter the payment journal',async t=>{
  const f=fixture(t),config={mode:'simulate',chainId:4663,contract:CONTRACT,requestPriceAtomic:PRICE.toString()};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  const input={v:1,chainId:4663,question:'x'.repeat(2000),answerType:'uint256',evidence:'panel',panelSize:5,quorum:4,toleranceBps:0,guards:{min:'0',max:'3'}};
  let checks=0;f.adapter.preflight=async()=>{checks++;return {approved:true};};
  for(const question of ['x'.repeat(2001),'x'.repeat(2500),'😀'.repeat(1001),'x'.repeat(25)+'\ud800']) {
    await assert.rejects(budget.queueDecision({matchId:'match-1',round:1,seat:0,input:{...input,question}}),/Invalid/);
  }
  assert.equal(checks,0);assert.equal(f.store.next(),undefined);
  const row=await budget.queueDecision({matchId:'match-1',round:1,seat:0,input});assert.equal(row.state,'queued');assert.equal(checks,1);
});
test('wording refusals and unavailable checks enqueue nothing and retain the match reserve',async t=>{
  const f=fixture(t),config={mode:'simulate',chainId:4663,contract:CONTRACT,requestPriceAtomic:PRICE.toString()};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  const input={v:1,chainId:4663,question:'Choose an upgrade from these frozen server facts.',answerType:'uint256',evidence:'panel',panelSize:5,quorum:4,toleranceBps:0,guards:{min:'0',max:'3'}};
  f.adapter.preflight=async()=>({approved:false});
  await assert.rejects(budget.queueDecision({matchId:'match-1',round:1,seat:0,input}),/refused/);
  f.adapter.preflight=async()=>{throw Error('Unavailable');};
  await assert.rejects(budget.queueDecision({matchId:'match-1',round:1,seat:0,input}),/Unavailable/);
  assert.equal(f.store.next(),undefined);assert.equal(f.store.reserved(),8n*PRICE);
});
test('input is frozen before preflight and a later refusal blocks signing legacy jobs',async t=>{
  const f=fixture(t),config={mode:'simulate',chainId:4663,contract:CONTRACT,requestPriceAtomic:PRICE.toString()};
  const budget=new DuelFundingBudget({store:f.store,adapter:f.adapter,config});
  const input={v:1,chainId:4663,question:'What is the remainder when the decimal integer 7 is divided by 4?',answerType:'uint256',evidence:'panel',panelSize:5,quorum:4,toleranceBps:0,guards:{min:'0',max:'3'}};
  const expected=input.question;
  f.adapter.preflight=async body=>{assert.equal(JSON.parse(body).question,expected);input.question='mutated after awaiting';return {approved:true};};
  const row=await budget.queueDecision({matchId:'match-1',round:1,seat:0,input});
  assert.equal(JSON.parse(JSON.parse(row.payload).body).question,expected);
  f.adapter.preflight=async()=>({approved:false});assert.equal((await f.engine.runOnce()).state,'blocked');
  assert.equal(f.adapter.prepareCount,0);assert.equal(f.adapter.broadcasts.length,0);assert.equal(f.store.reserved(),8n*PRICE);
  assert.throws(()=>f.store.closeMatch('match-1'),/reconciled/);
});
test('preflight outage and lost coordinator lease never sign or broadcast',async t=>{
  const f=fixture(t);f.enqueue();
  f.adapter.preflight=async()=>{throw Error('Timeout');};assert.equal((await f.engine.runOnce()).state,'unavailable');
  f.adapter.preflight=async()=>{f.store.db.prepare('UPDATE leases SET until_ms=0').run();return {approved:true};};
  assert.equal((await f.engine.runOnce()).state,'unavailable');assert.equal(f.adapter.prepareCount,0);assert.equal(f.adapter.broadcasts.length,0);
});
test('changed oracle panel terms halt persistently before payment preparation',async t=>{
  const {OracleTermsChanged}=await import('../worker/oracle-client.mjs');
  const f=fixture(t);f.enqueue();f.adapter.terms=async()=>{throw new OracleTermsChanged();};
  assert.equal((await f.engine.runOnce()).state,'terms_changed');assert.equal(f.reopen().blocked(),true);assert.equal(f.adapter.prepareCount,0);
});
