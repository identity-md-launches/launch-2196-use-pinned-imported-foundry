// Write a portable evidence index inside this repository. Never reads operator state or copies keys.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const json=async path=>JSON.parse(await readFile(new URL(path,root)));
const solidity=await json('reports/solidity-tests.json');
const tests=Object.values(solidity).flatMap(s=>Object.entries(s.test_results).map(([name,t])=>({name,status:t.status,fuzzRuns:t.kind?.Fuzz?.runs??0})));
assert.ok(tests.length>=22 && tests.every(t=>t.status==='Success'));
const tap=await readFile(new URL('reports/worker-tests.tap',root),'utf8');
const testCount=Number(tap.match(/# tests (\d+)/)?.[1]);assert.ok(testCount>=36 && /# fail 0\b/.test(tap));
const e2e=await json('reports/local-e2e.json');assert.equal(e2e.status,'passed');assert.equal(e2e.delayedInclusionSeconds,301);
const factory=await json('reports/factory-fork-review.json'),router=await json('reports/production-router-review.json');
for(const review of [factory,router]) {assert.equal(review.status,'passed');assert.equal(review.cases.length,2);assert.equal(review.publicTransactions,0);}
assert.ok(router.cases.every(c=>c.tradingReview.quotes.length===4 && c.tradingReview.quotes.every(q=>q.quoteMatchesExecution)));
const config=await json('config.example.json');assert.equal(config.mode,'disabled');assert.equal(config.liveExecutionApproved,false);assert.equal(config.contract,null);assert.equal(config.worker,null);
assert.equal(config.treasury,'0x4251627b712762b6e81799698a05c6c9dff35c5d');
const artifacts=await json('deployment/artifacts.json');
assert.ok(router.cases.every(c=>c.hookRuntimeKeccak256===artifacts.hook.runtimeKeccak256));
const report={createdAt:new Date().toISOString(),status:'local_validation_passed_live_disabled',contractTests:tests.length,randomizedCases:tests.reduce((n,t)=>n+t.fuzzRuns,0),workerAndArtifactTests:testCount,
  fuzzSeed:'0x25b0e155b7d99a4afe16ce19daf869cbff1cc18990f23669c40b4f5e6ad46323',
  checks:{build:'forge build --offline',solidity:'forge test --offline',worker:'node --test test/*.test.mjs',accountingAndRecovery:'scripts/simulate.mjs',factory:'scripts/review-factory.mjs',productionRouter:'scripts/review-factory.mjs --production-router',protocol:'scripts/check-protocol.mjs',freeOracleChecks:'scripts/check-oracle.mjs',artifacts:'scripts/launch-artifacts.mjs'},
  review:{independent:false,importedFindingsFixed:4,retainedLifecycleRisk:'immutable Intake/action can strand request funding',newHighOrCriticalFindingsReproduced:0},
  publicChainTransactions:0,paidLiveRequests:0,realFundsSpent:'0',activation:{enabled:false,coinLaunched:false,gameConnected:false,remaining:['IMD source attestation/admission and final deployment','owner-configured worker and gas/spending/operating-reserve limits','separate IMD reserve funding and native ETH gas funding','project-hosted durable coordinator and verified game-result integration','final live pool/router checks and a paid live validation']},
  limits:['Agent implementation review, not independent audit or protocol source rebuild. Slither/Mythril were not run.','Fork exercises deployed runtime. Actual browser wallet flow and paid oracle admission/delivery were not tested.','Two confirmations and latest canonical checkpoint checks are not a guarantee of L1 finality.','The oracle wording check is a free screen, not a paid admission guarantee.'],tests};
await writeFile(new URL('reports/validation.json',root),JSON.stringify(report,null,2)+'\n');
const entries=[];
async function walk(folder) {
  for(const item of await readdir(new URL(folder+'/',root),{withFileTypes:true})) {
    const path=folder+'/'+item.name;if(path==='test/scratch') continue;
    if(item.isDirectory()) await walk(path);else if(item.isFile()) entries.push(path);else throw Error('Unexpected source symlink');
  }
}
for(const folder of ['src','worker','test','lib','scripts','vendor','deployment','reports']) await walk(folder);
entries.push('README.md','ADAPTATION.md','launch.json','foundry.toml','package.json','package-lock.json','config.example.json','vendor-integrity.json','.gitignore');
const files=[];
for(const path of entries.sort()) {
  const bytes=await readFile(new URL(path,root));
  // Reports and generated outputs must never include machine-specific stack paths.
  if(path.startsWith('reports/') || path.startsWith('deployment/') || path==='vendor/viem.mjs') assert.ok(!/(?:\/root\/|\/tmp\/cabal|[A-Za-z]:[\\/]Users[\\/])/.test(bytes.toString()),'Nonportable generated output');
  files.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
await writeFile(new URL('source-integrity.json',root),JSON.stringify({files},null,2)+'\n');
console.log(JSON.stringify({sourceFiles:files.length,contractTests:tests.length,randomizedCases:report.randomizedCases,workerAndArtifactTests:testCount,liveExecution:false}));
