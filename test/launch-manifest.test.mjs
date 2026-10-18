import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateManifest} from '../scripts/launch-artifacts.mjs';
import {encodeDeployData,keccak256,getCreate2Address} from '../vendor/viem.mjs';
const json=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url)));
const manifest=await json('launch.json'),terms=await json('deployment/launch-terms.json');
const tokenAbi=await json('deployment/abi/LaunchToken.json'),hookAbi=await json('deployment/abi/CabalFundingHook.json');
test('launch manifest matches callable constructors and preserves the explicit supply allocation',()=>{
  validateManifest(manifest,terms,tokenAbi,hookAbi);
  for(const mutate of [m=>m.kind='evm_project',m=>m.hook.constructorArgs[0]='0x0000000000000000000000000000000000000000',m=>m.hook.constructorArgs.reverse(),m=>m.hook.permissions.pop(),m=>m.pool.fee=0]) {
    const bad=structuredClone(manifest);mutate(bad);assert.throws(()=>validateManifest(bad,terms,tokenAbi,hookAbi));
  }
  for(const economics of [{poolBps:8000,remainderTo:terms.owner},{...terms.economics,initialMarketCapWei:'2500000000000000000000'}]) assert.throws(()=>validateManifest(manifest,{...terms,economics},tokenAbi,hookAbi));
});
test('shipped deployment bytes reproduce the mined hook and both fork runtime hashes',async()=>{
  const artifact=await json('deployment/artifacts.json');
  const init=(await readFile(new URL('../deployment/CabalFundingHook.init.hex',import.meta.url),'utf8')).trim();
  const runtime=(await readFile(new URL('../deployment/CabalFundingHook.runtime.hex',import.meta.url),'utf8')).trim();
  assert.equal(keccak256(init),artifact.hook.initCodeKeccak256);assert.equal(keccak256(runtime),artifact.hook.runtimeKeccak256);
  assert.equal(init.slice(-artifact.hook.constructorBytes.length+2),artifact.hook.constructorBytes.slice(2));
  const predicted=getCreate2Address({from:artifact.factory,salt:artifact.hook.proposedCreate2Salt,bytecodeHash:keccak256(init)});
  assert.equal(predicted,artifact.hook.predictedAddress);assert.equal(BigInt(predicted)&0x3fffn,0x20ccn);
  const tokenCode=(await readFile(new URL('../deployment/LaunchToken.creation.hex',import.meta.url),'utf8')).trim();
  assert.equal(encodeDeployData({abi:tokenAbi,bytecode:tokenCode,args:[]}),tokenCode);
  const report=await json('reports/production-router-review.json');
  for(const c of report.cases) {assert.equal(c.hookRuntimeKeccak256,artifact.hook.runtimeKeccak256);assert.equal(c.tokenRuntimeKeccak256,artifact.token.runtimeKeccak256);}
});
