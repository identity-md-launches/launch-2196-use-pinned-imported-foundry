// Free public screening probes only; no Intake calls or paid requests.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createOracleClient,decisionBody} from '../worker/oracle-client.mjs';
const config=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url)));
const samples=[['oversized','x'.repeat(2500)],['original-fixture','Choose an upgrade from these frozen server facts for seat zero, round one of this duel.'],['public-sample','What is the remainder when the decimal integer 7 is divided by 4?']];
const cases={};
for(const [name,question] of samples) {
  const input={question,chainId:4663,panelSize:5,answerType:'uint256',evidence:'panel',toleranceBps:0};
  const response=await fetch(config.apiUrl+'/requests/check',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({action:'oracle.request',input}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();
  cases[name]={httpStatus:response.status,questionLength:question.length,judged:result.judged,blockers:result.blockers,error:result.error,detail:result.detail,limits:result.limits};
  if(name==='oversized') assert.equal(response.status,400);
  if(name==='original-fixture') assert.ok(result.blockers?.length>0);
  if(name==='public-sample') assert.deepEqual(result.blockers,[]);
}
const client=createOracleClient(config);await client.terms();
const body=decisionBody({v:1,chainId:4663,question:samples[2][1],panelSize:5,quorum:4,answerType:'uint256',evidence:'panel',toleranceBps:0,guards:{min:'0',max:'3'}},4663);
assert.equal((await client.preflight(body)).approved,true);
await writeFile(new URL('../reports/oracle-preflight-review.json',import.meta.url),JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),endpoint:config.apiUrl+'/requests/check',publicTransactions:0,paidRequests:0,cases,adapterLiveReadCheckPassed:true,
  limitations:['The endpoint accepts only its shorter documented wording input, not v/window/quorum/validForSeconds/guards. Those paid fields are fixed locally.','The public arithmetic sample is a screening smoke test, not a game decision, oracle verdict or paid admission.','Private game questions were neither supplied nor invented; each real question must pass screening before payment.']},null,2)+'\n');
console.log('Free screening checks passed; no paid request made.');
