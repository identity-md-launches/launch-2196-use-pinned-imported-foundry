// All transactions in this executable go to its own disposable loopback Anvil chain (31337).
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createPublicClient,createWalletClient,http,defineChain,concatHex,encodeDeployData,getCreate2Address,keccak256,toHex,formatEther,parseTransaction,decodeFunctionData } from '../vendor/viem.mjs';
import { privateKeyToAccount } from '../vendor/viem.mjs';
import { FundingStore,decisionKey } from '../worker/store.mjs';
import { FundingEngine } from '../worker/engine.mjs';
import { createLocalChainAdapter, REQUEST_DEADLINE_SECONDS, ABI } from '../worker/chain-adapter.mjs';

const dir=await mkdtemp(join(tmpdir(),'funding-evm-'));
const port=18549;
const rpc='http://127.0.0.1:'+port;
const child=spawn(process.env.ANVIL_BIN??'anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent','--gas-limit','100000000'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let childError; child.on('error',error=>{childError=error;}); let stderr='';child.stderr.on('data',data=>{stderr+=data.toString();});
const chain=defineChain({id:31337,name:'Local funding simulation',nativeCurrency:{name:'Test Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
// Public Anvil fixture key, never a project or funded production wallet.
const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const publicClient=createPublicClient({chain,transport:http(rpc,{timeout:2000,retryCount:0}),pollingInterval:25});
const wallet=createWalletClient({chain,account,transport:http(rpc,{timeout:2000,retryCount:0})});
let store; let count=0;
const artifact=async (file,name)=>JSON.parse(await readFile(new URL(`../out/${file}/${name}.json`,import.meta.url),'utf8'));
const mine=()=>publicClient.request({method:'anvil_mine',params:['0x2']});
async function wait(hash) {const receipt=await publicClient.waitForTransactionReceipt({hash,pollingInterval:25});assert.equal(receipt.status,'success');count++;return receipt;}
async function deploy(file,name,args=[]) {const a=await artifact(file,name);const r=await wait(await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args}));return {address:r.contractAddress,abi:a.abi};}
async function call(contract,functionName,args=[]) {return wait(await wallet.writeContract({...contract,functionName,args}));}
const read=(contract,functionName,args=[])=>publicClient.readContract({...contract,functionName,args});
try {
  let ready=false;
  for(let i=0;i<80;i++) {if(childError) throw childError;if(child.exitCode!==null) throw Error('Anvil stopped: '+stderr);
    try {ready=(await publicClient.getChainId())===31337;if(ready) break;}catch{} await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,'Local Anvil did not start');
  const tokenA=await deploy('CabalFundingHook.t.sol','Token'),tokenB=await deploy('CabalFundingHook.t.sol','Token');
  const [imd,cabal]=[tokenA,tokenB].sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const manager=await deploy('PoolManager.sol','PoolManager',[account.address]);
  const intake=await deploy('CabalFundingHook.t.sol','IntakeMock');
  const create2=await deploy('LocalCreate2.sol','LocalCreate2');
  const hookArtifact=await artifact('CabalFundingHook.sol','CabalFundingHook');
  const treasury='0x000000000000000000000000000000000000beef';
  const initCode=encodeDeployData({abi:hookArtifact.abi,bytecode:hookArtifact.bytecode.object,args:[manager.address,account.address,imd.address,intake.address,account.address,treasury]});
  const initCodeHash=keccak256(initCode);
  let salt,hookAddress;
  for(let i=0;i<1000000;i++) {salt=toHex(i,{size:32});hookAddress=getCreate2Address({from:create2.address,salt,bytecodeHash:initCodeHash});if((BigInt(hookAddress)&0x3fffn)===0x20ccn) break;}
  assert.equal(BigInt(hookAddress)&0x3fffn,0x20ccn);await call(create2,'deploy',[salt,initCode]);
  const hook={address:hookAddress,abi:hookArtifact.abi};
  const router=await deploy('PoolSwapTest.sol','PoolSwapTest',[manager.address]);
  const lp=await deploy('PoolModifyLiquidityTest.sol','PoolModifyLiquidityTest',[manager.address]);
  const key={currency0:imd.address,currency1:cabal.address,fee:12500,tickSpacing:60,hooks:hook.address};
  await call(manager,'initialize',[key,2n**96n]);
  for(const token of [imd,cabal]) for(const spender of [router.address,lp.address,hook.address]) await call(token,'approve',[spender,2n**256n-1n]);
  await call(lp,'modifyLiquidity',[key,{tickLower:-600,tickUpper:600,liquidityDelta:10n**25n,salt:toHex(0,{size:32})},'0x']);
  const before=await read(imd,'balanceOf',[account.address]);
  await call(router,'swap',[key,{zeroForOne:true,amountSpecified:-1000n*10n**18n,sqrtPriceLimitX96:4295128740n},{takeClaims:false,settleUsingBurn:false},'0x']);
  assert.equal(before-await read(imd,'balanceOf',[account.address]),1000n*10n**18n);
  await call(hook,'configureWorker',[account.address,5n*10n**17n,10n*10n**18n,true]);
  const config={mode:'simulate',chainId:31337,rpcUrl:rpc,contract:hook.address,imd:imd.address,intake:intake.address,treasury,worker:account.address,runtimeCodeHash:keccak256(await publicClient.getCode({address:hook.address})),requestPriceAtomic:'500000000000000000',dailyLimitAtomic:'10000000000000000000',maxGasPerTransactionWei:'100000000000000000',confirmations:2};
  const adapter=createLocalChainAdapter(config,wallet);
  const db=join(dir,'worker.db');store=new FundingStore(db);
  let engine=new FundingEngine({store,adapter,mode:'simulate',minGasWei:1n});
  async function cycle() {const result=await engine.runOnce();await mine();return result;}
  assert.equal((await cycle()).state,'submitted'); // harvest
  assert.equal((await cycle()).state,'confirmed');
  assert.equal(await read(hook,'requestBalance'),28n*10n**18n);
  assert.equal((await cycle()).state,'submitted'); // treasury
  assert.equal((await cycle()).state,'confirmed');
  assert.equal(await read(imd,'balanceOf',[treasury]),12n*10n**18n);
  store.reserveMatch('fixture-duel',4n*10n**18n,await read(hook,'requestBalance'));
  const rows=[];
  for(let round=1;round<=4;round++) for(let seat=0;seat<2;seat++) rows.push(store.enqueue({id:decisionKey(31337,hook.address,'fixture-duel',round,seat),match:'fixture-duel',amount:5n*10n**17n,body:JSON.stringify({v:1,question:'Local simulated decision',round,seat})}));
  const send=adapter.broadcast;let once=true;
  adapter.broadcast=async raw=>{
    if(once) {
      const tx=parseTransaction(raw),decoded=decodeFunctionData({abi:ABI,data:tx.data});
      assert.equal(decoded.functionName,'payRequest');
      const deadline=decoded.args[3],now=BigInt(Math.floor(Date.now()/1000));
      assert.ok(deadline>=now+BigInt(REQUEST_DEADLINE_SECONDS)-10n && deadline<=now+BigInt(REQUEST_DEADLINE_SECONDS));
      // Advance the disposable chain, never the wall clock: the old five-minute deadline fails here.
      await publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(now+301n)]});
    }
    const hash=await send(raw);if(once){once=false;throw Error('simulated lost RPC reply');}return hash;
  };
  assert.equal((await cycle()).state,'uncertain');
  store.close();store=new FundingStore(db);engine=new FundingEngine({store,adapter,mode:'simulate'});
  assert.equal((await cycle()).state,'confirmed'); // restart finds mined payment, does not pay again
  for(let i=1;i<8;i++) {assert.equal((await cycle()).state,'submitted');assert.equal((await cycle()).state,'confirmed');}
  assert.equal(await read(intake,'count'),8n);assert.equal(await read(hook,'requestBalance'),24n*10n**18n);
  assert.equal(await read(imd,'balanceOf',[intake.address]),4n*10n**18n);store.closeMatch('fixture-duel');
  const report={status:'passed',environment:'Disposable local Anvil chain 31337',realUniswapPoolManager:true,buyInputImd:'1000',customTaxImd:'40',requestAllocationImd:'28',treasuryPaidImd:'12',requestsPaid:8,requestSpendImd:'4',requestFundRemainingImd:'24',delayedInclusionSeconds:301,requestDeadlineSeconds:REQUEST_DEADLINE_SECONDS,lostBroadcastReplyRecoveredAfterRestart:true,duplicateRequestsPaid:0,liveChainTransactions:0,realFundsSpent:'0',notes:['All tokens, gas and wallets in this run are local fixtures.','This tests actual compiled contracts and the same transaction adapter used by the worker.','IMD intake is a mock in this test; no real swarm call or coin launch occurred.']};
  await mkdir(new URL('../reports/',import.meta.url),{recursive:true});await writeFile(new URL('../reports/local-e2e.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {store?.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null) resolve();else child.once('exit',resolve);});await rm(dir,{recursive:true,force:true});}
