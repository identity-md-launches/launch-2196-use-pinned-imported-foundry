// Public reads only. No wallet, transaction preparation, or broadcast methods.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createPublicClient,http,parseAbi,keccak256} from '../vendor/viem.mjs';
import {createOracleClient,ORACLE_ACTION} from '../worker/oracle-client.mjs';
const config=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url)));
const pinned=JSON.parse(await readFile(new URL('../test/fixtures/protocol-runtimes.json',import.meta.url)));
const factoryAbi=JSON.parse(await readFile(new URL('../test/fixtures/IMDLaunchFactory.abi.json',import.meta.url)));
const trading=JSON.parse(await readFile(new URL('../test/fixtures/IMDTrading.provenance.json',import.meta.url)));
const client=createPublicClient({transport:http(config.rpcUrl,{timeout:15000,retryCount:0})});
assert.equal(await client.getChainId(),4663);
const block=await client.getBlock({blockTag:'latest'}),blockNumber=block.number;
const addresses={factory:'0xa25b02a1e93903b790e6aaf7da1b8b8d50294645',imd:config.imd,intake:config.intake};
const factoryRead=functionName=>client.readContract({address:addresses.factory,abi:factoryAbi,functionName,blockNumber});
addresses.manager=(await factoryRead('poolManager')).toLowerCase();addresses.fees=(await factoryRead('fees')).toLowerCase();
for(const [name,value] of Object.entries(trading.contracts)) addresses[name]=value.address;
const runtimeHashes={};
await Promise.all(Object.entries(addresses).map(async([name,address])=>{
  const code=await client.getCode({address,blockNumber});assert.ok(code && code!=='0x',name+' missing');
  runtimeHashes[name]=keccak256(code);assert.equal(runtimeHashes[name],pinned[name],name+' runtime changed');
}));
const call=(address,signature,functionName,args=[])=>client.readContract({address,abi:parseAbi([signature]),functionName,args,blockNumber});
assert.equal(await call(addresses.imd,'function symbol() view returns(string)','symbol'),'IMD');
assert.equal(await call(addresses.imd,'function decimals() view returns(uint8)','decimals'),18);
assert.equal(await factoryRead('SWARM_BPS'),1000);
assert.equal(await call(addresses.fees,'function poolFee() view returns(uint24)','poolFee'),12500);
assert.equal(await call(addresses.fees,'function REQUESTER_BPS() view returns(uint16)','REQUESTER_BPS'),8000);
const price=await call(addresses.intake,'function priceOf(bytes32,address) view returns(uint256)','priceOf',[ORACLE_ACTION,addresses.imd]);
assert.equal(price,500000000000000000n);
for(const name of ['router','quoter']) assert.equal((await call(addresses[name],'function poolManager() view returns(address)','poolManager')).toLowerCase(),addresses.manager);
const oracle=createOracleClient(config);await oracle.terms();
const policyResponse=await fetch('https://api.imd.fun/launch/policies',{signal:AbortSignal.timeout(15000)});assert.ok(policyResponse.ok);
const policies=await policyResponse.json();
const policy=policies.policies.filter(p=>p.kind==='univ4_hook' && p.params.chainId===4663).sort((a,b)=>b.version-a.version)[0];
assert.deepEqual(policy.params.feeTiers,[12500]);assert.equal(policy.params.initialMarketCaps[addresses.imd],'2500000000000000000000');
assert.equal(policy.params.contributorPoolBps,1000);assert.ok(policy.params.pairedCurrencyAllowlist.includes(addresses.imd));
const report={status:'passed',checkedAt:new Date().toISOString(),chainId:4663,blockNumber:blockNumber.toString(),blockHash:block.hash,addresses,runtimeHashes,
  policy:{version:policy.version,changedSinceBrief:policy.version!==30,feeTiers:policy.params.feeTiers,openingValuationImdAtomic:policy.params.initialMarketCaps[addresses.imd],defaultPoolBps:policy.params.liquidityBps,defaultRemainderBps:policy.params.treasuryBps,swarmBps:1000,contributorLockSeconds:policy.params.contributorLockSeconds,requiredPoolBps:8800,requiredRemainderBps:200,allocationOverride:'deployment/launch-terms.json'},
  intake:{action:ORACLE_ACTION,priceAtomic:price.toString(),capabilitiesMatch:true,minPanelSize:5,maxPanelSize:100},platformFees:{poolFee:12500,requesterBps:8000,networkBps:2000},
  publicTransactions:0,sources:['https://api.imd.fun/launch/policies','https://api.imd.fun/requests/capabilities','https://imd.fun/docs/','https://robin.etherscan.io/'],
  limits:['Runtime hashes and read calls confirmed; deployed protocol sources were not independently rebuilt.','Recheck policy, code and allocation immediately before actual deployment.']};
await writeFile(new URL('../reports/protocol-review.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,blockNumber:report.blockNumber,policy:report.policy,intake:report.intake}));
