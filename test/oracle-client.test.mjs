import test from 'node:test';
import assert from 'node:assert/strict';
import {createOracleClient,decisionBody,checkedInput,ORACLE_ACTION,OracleTermsChanged} from '../worker/oracle-client.mjs';
const config={chainId:4663,apiUrl:'https://api.imd.fun',imd:'0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127',intake:'0xa43e6f75ee006411f79ac1c84120606c2330de82',requestPriceAtomic:'500000000000000000'};
const input={v:1,chainId:4663,question:'What is the remainder when the decimal integer 7 is divided by 4?',answerType:'uint256',evidence:'panel',panelSize:5,quorum:4,toleranceBps:0,guards:{min:'0',max:'3'}};
const body=decisionBody(input,4663);
const limits={minPanelSize:5,maxPanelSize:100};
const approved=()=>({action:'oracle.request',judged:true,blockers:[],limits:{...limits},request:{...input,window:{hours:24},validForSeconds:86400}});
const capabilities=()=>({limits:{'oracle.request':{...limits}},onchain:{chains:[{chainId:4663,asset:config.imd,intake:config.intake,decimals:18,actions:[{action:'oracle.request',version:'oracle-1',actionId:ORACLE_ACTION,amount:config.requestPriceAtomic}]}]}});
const response=data=>({ok:true,json:async()=>data});
test('free check sends the exact supported wording fields and preserves paid body fields',async()=>{
  let calls=0;
  const client=createOracleClient(config,async(url,options)=>{
    calls++;assert.equal(url,'https://api.imd.fun/requests/check');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{action:'oracle.request',input:checkedInput(body,4663)});
    for(const key of ['v','window','quorum','validForSeconds','guards']) assert.equal(JSON.parse(options.body).input[key],undefined);
    return response(approved());
  });
  assert.deepEqual(await client.preflight(body),{approved:true});assert.equal(calls,1);assert.equal(JSON.parse(body).validForSeconds,300);
});
test('wording blockers, incomplete checks, altered questions and HTTP errors fail closed',async()=>{
  const refused=approved();refused.blockers=[{code:'not_answerable'}];
  assert.deepEqual(await createOracleClient(config,async()=>response(refused)).preflight(body),{approved:false});
  for(const mutate of [r=>delete r.blockers,r=>r.judged=false,r=>r.request.question='a different question',r=>r.request.chainId=1,r=>r.request.quorum=2]) {
    const result=approved();mutate(result);await assert.rejects(createOracleClient(config,async()=>response(result)).preflight(body));
  }
  await assert.rejects(createOracleClient(config,async()=>({ok:false})).preflight(body),/unavailable/);
});
test('capability and check limit changes require operational review',async()=>{
  assert.equal((await createOracleClient(config,async()=>response(capabilities())).terms()).amount,config.requestPriceAtomic);
  for(const mutate of [r=>r.limits['oracle.request'].minPanelSize=6,r=>r.limits['oracle.request'].maxPanelSize=99,r=>r.onchain.chains[0].actions[0].amount='600000000000000000',r=>r.onchain.chains[0].actions[0].version='oracle-2',r=>r.onchain.chains[0].intake=config.imd]) {
    const cap=capabilities();mutate(cap);await assert.rejects(createOracleClient(config,async()=>response(cap)).terms(),OracleTermsChanged);
  }
  const result=approved();result.limits.minPanelSize=6;
  await assert.rejects(createOracleClient(config,async()=>response(result)).preflight(body),OracleTermsChanged);
});
test('saved jobs cannot add screening waivers, callbacks or unreviewed payment fields',()=>{
  for(const change of [{allowAmbiguous:true},{callback:{target:config.intake}},{window:{hours:1}},{validForSeconds:86400},{guards:{min:'0',max:'4'}}]) {
    assert.throws(()=>checkedInput(JSON.stringify({...JSON.parse(body),...change}),4663));
  }
  assert.throws(()=>checkedInput(body,1));
});
