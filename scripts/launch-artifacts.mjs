// Offline artifact preparation only. Never connects to a chain or broadcasts.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {encodeAbiParameters,encodeDeployData,getCreate2Address,keccak256,toHex} from '../vendor/viem.mjs';
const OWNER='0x4251627b712762b6e81799698a05c6c9dff35c5d';
export const PERMISSIONS=['beforeInitialize','beforeSwap','afterSwap','beforeSwapReturnDelta','afterSwapReturnDelta'];
export function validateManifest(manifest,terms,tokenAbi,hookAbi) {
  assert.deepEqual(Object.keys(manifest).sort(),['hook','kind','notes','pool','token']);
  assert.equal(manifest.kind,'univ4_hook');
  assert.deepEqual(manifest.token,{contract:'LaunchToken',name:'Cabal Coin',symbol:'CABAL',decimals:18});
  assert.deepEqual(manifest.pool,{pairedCurrency:'0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127',fee:12500,tickSpacing:60,initialPrice:'79228162514264337593543950336'});
  assert.deepEqual(manifest.hook,{contract:'CabalFundingHook',constructorArgs:['$poolManager','$factory',manifest.pool.pairedCurrency,'0xa43e6f75ee006411f79ac1c84120606c2330de82','$owner',OWNER],permissions:PERMISSIONS});
  assert.deepEqual(terms,{onchain:'univ4_hook',chainId:4663,pairWith:'imd',owner:OWNER,economics:{poolBps:8800,remainderTo:OWNER}});
  const tokenConstructor=tokenAbi.find(a=>a.type==='constructor'),hookConstructor=hookAbi.find(a=>a.type==='constructor');
  assert.equal(tokenConstructor.stateMutability,'nonpayable');assert.deepEqual(tokenConstructor.inputs,[]);
  assert.equal(hookConstructor.stateMutability,'nonpayable');assert.deepEqual(hookConstructor.inputs.map(i=>i.type),Array(6).fill('address'));
  const names=hookAbi.filter(a=>a.type==='function').map(a=>a.name);
  for(const forbidden of ['mint','pause','unpause','upgradeTo','upgradeToAndCall','sweep','setTreasury','setIntake','setTax','setSplit']) assert.ok(!names.includes(forbidden));
}
export function mineHook(factory,initCodeHash,start=0n) {
  for(let n=start;n<start+1000000n;n++) {
    const salt=toHex(n,{size:32}),address=getCreate2Address({from:factory,salt,bytecodeHash:initCodeHash});
    if((BigInt(address)&0x3fffn)===0x20ccn) return {salt,address};
  }
  throw Error('No hook salt found in bounded search');
}
async function main() {
  // AST identifies each immutable by name, not by a guessed byte offset.
  execFileSync('forge',['build','--offline','--ast'],{stdio:['ignore','pipe','pipe'],cwd:new URL('../',import.meta.url)});
  const json=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url)));
  const manifest=await json('launch.json'),terms=await json('deployment/launch-terms.json');
  const token=await json('out/LaunchToken.sol/LaunchToken.json'),hook=await json('out/CabalFundingHook.sol/CabalFundingHook.json');
  validateManifest(manifest,terms,token.abi,hook.abi);
  const protocol=await json('reports/protocol-review.json'),review=await json('reports/production-router-review.json');
  assert.equal(protocol.status,'passed');assert.equal(review.status,'passed');assert.equal(review.cases.length,2);
  const values={manager:protocol.addresses.manager,factory:protocol.addresses.factory,imd:protocol.addresses.imd,intake:protocol.addresses.intake,owner:terms.owner,treasury:terms.owner};
  const args=Object.values(values);
  const constructorBytes=encodeAbiParameters(Array(6).fill({type:'address'}),args);
  const initCode=encodeDeployData({abi:hook.abi,bytecode:hook.bytecode.object,args});
  assert.equal(initCode,hook.bytecode.object+constructorBytes.slice(2));
  assert.match(initCode,/^0x[0-9a-f]+$/i);assert.deepEqual(hook.bytecode.linkReferences,{});
  const initCodeHash=keccak256(initCode),mined=mineHook(values.factory,initCodeHash);
  let runtime=hook.deployedBytecode.object.slice(2);
  const immutableMap={};
  for(const contract of hook.ast.nodes.filter(n=>n.nodeType==='ContractDefinition')) for(const node of contract.nodes) {
    if(node.nodeType==='VariableDeclaration' && node.mutability==='immutable') immutableMap[node.id]=node.name;
  }
  for(const [id,refs] of Object.entries(hook.deployedBytecode.immutableReferences)) {
    const value=values[immutableMap[id]];assert.ok(value,'Unknown immutable');
    const encoded=encodeAbiParameters([{type:'address'}],[value]).slice(2);
    for(const {start,length} of refs) {assert.equal(length,32);runtime=runtime.slice(0,start*2)+encoded+runtime.slice((start+length)*2);}
  }
  runtime='0x'+runtime;assert.ok((runtime.length-2)/2<=24576);
  const runtimeHash=keccak256(runtime),tokenRuntimeHash=keccak256(token.deployedBytecode.object);
  for(const c of review.cases) {
    assert.deepEqual(c.hookConstructorArgs,args);assert.equal(c.hookInitCodeHash,initCodeHash);
    assert.equal(c.hookRuntimeKeccak256,runtimeHash);assert.equal(c.tokenRuntimeKeccak256,tokenRuntimeHash);assert.equal(c.defaultDisabledVerified,true);
  }
  assert.equal(mined.address.toLowerCase(),review.cases[0].hookAddress.toLowerCase());
  const plan={status:'prepared_not_deployed',chainId:4663,kind:'univ4_hook',factory:values.factory,poolManager:values.manager,owner:terms.owner,treasury:terms.owner,
    manifestFile:'launch.json',termsFile:'deployment/launch-terms.json',policyVersion:protocol.policy.version,
    hook:{source:'src/CabalFundingHook.sol',contract:'CabalFundingHook',constructorArgs:args,constructorBytes,creationCodeKeccak256:keccak256(hook.bytecode.object),initCodeKeccak256:initCodeHash,proposedCreate2Salt:mined.salt,predictedAddress:mined.address,permissionMask:'0x20cc',addressMask:'0x3fff',runtimeKeccak256:runtimeHash,runtimeBytes:(runtime.length-2)/2},
    token:{source:'src/LaunchToken.sol',contract:'LaunchToken',constructorArgs:[],creationCodeKeccak256:keccak256(token.bytecode.object),runtimeKeccak256:tokenRuntimeHash,totalSupplyAtomic:'1000000000000000000000000000',addressStatus:'Assigned by factory CREATE2 using the actual launch number; no production token address claimed.'},
    deploymentState:{paymentsEnabled:false,workerConfigured:false,maxRequestAmount:'0',dailyLimit:'0'},
    boundPoolStatus:'Verify keccak256(abi.encode(positionOf(actualLaunchNumber).key)) after launch; the token address and pool ID are not known before its launch number.',
    protocolSnapshot:{blockNumber:protocol.blockNumber,blockHash:protocol.blockHash},
    limits:['Proposed hook address is deterministic for these exact constructor bytes, factory and salt, not a deployment receipt. The IMD deployer may choose another valid salt.','No source attestation, launch number, contributor Merkle root or authorization signature is fabricated. IMD supplies those after acceptance.','The final deployer must freeze 8800 pool bps and the named remainder, keep factory LP custody, and verify the actual pool before enabling payments.']};
  await mkdir(new URL('../deployment/abi/',import.meta.url),{recursive:true});
  const put=(name,data)=>writeFile(new URL('../deployment/'+name,import.meta.url),data);
  await put('abi/LaunchToken.json',JSON.stringify(token.abi,null,2)+'\n');await put('abi/CabalFundingHook.json',JSON.stringify(hook.abi,null,2)+'\n');
  await put('LaunchToken.creation.hex',token.bytecode.object+'\n');await put('CabalFundingHook.init.hex',initCode+'\n');
  await put('LaunchToken.runtime.hex',token.deployedBytecode.object+'\n');await put('CabalFundingHook.runtime.hex',runtime+'\n');
  await put('artifacts.json',JSON.stringify(plan,null,2)+'\n');
  console.log(JSON.stringify({status:plan.status,hook:mined.address,mask:'0x20cc',hookRuntimeHash:runtimeHash,tokenRuntimeHash}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
