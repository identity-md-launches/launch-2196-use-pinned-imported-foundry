// Local fork only. Public RPC is behind a read-only allowlist; no real signing keys are used.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,defineChain,encodeDeployData,encodeAbiParameters,getCreate2Address,keccak256,toHex,parseAbi,formatEther} from '../vendor/viem.mjs';
import {prepareProductionRouter,reviewProductionTrades} from './review-router-cases.mjs';

const productionRouter=process.argv.includes('--production-router');

const upstream='https://rpc.mainnet.chain.robinhood.com';
const publicMethods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getProof','net_version']);
const methodCounts={};
async function remote(method,params=[]) {
  assert.ok(publicMethods.has(method),'Public RPC mutation refused: '+method);
  methodCounts[method]=(methodCounts[method]??0)+1;
  const response=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
  assert.ok(response.ok,'RPC HTTP error');
  const result=await response.json();if(result.error) throw Error(JSON.stringify(result.error));return result.result;
}
const forkBlock=await remote('eth_getBlockByNumber',['latest',false]);
assert.equal(Number(await remote('eth_chainId')),4663);
const proxy=createServer(async(req,res)=>{
  try {
    let data='';for await(const chunk of req){data+=chunk;if(data.length>100000) throw Error('RPC body too large');}
    const message=JSON.parse(data);
    const run=async m=>({jsonrpc:'2.0',id:m.id,result:await remote(m.method,m.params)});
    const result=Array.isArray(message)?await Promise.all(message.map(run)):await run(message);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:'Read-only proxy refused or unavailable'}));}
});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(18552,'127.0.0.1',resolve);});
const rpc='http://127.0.0.1:18551';
const child=spawn(process.env.ANVIL_BIN??'anvil',['--host','127.0.0.1','--port','18551','--chain-id','31337','--fork-url','http://127.0.0.1:18552','--fork-block-number',BigInt(forkBlock.number).toString(),'--silent','--gas-limit','100000000'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let startupError;child.on('error',e=>startupError=e);let stderr='';child.stderr.on('data',d=>stderr+=d);
const chain=defineChain({id:31337,name:'Local factory compatibility fork',nativeCurrency:{name:'Fixture Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const client=createPublicClient({chain,transport:http(rpc,{timeout:60000,retryCount:0}),pollingInterval:50});
// Default Anvil account, unlocked only by the local node. No private key is read or needed.
const actor='0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const wallet=createWalletClient({chain,account:actor,transport:http(rpc,{timeout:60000,retryCount:0})});
const addresses={factory:'0xa25b02a1e93903b790e6aaf7da1b8b8d50294645',imd:'0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127',intake:'0xa43e6f75ee006411f79ac1c84120606c2330de82',fees:'0xf053525ffe8f8d8973339e36ee8d455690fb73cb',payee:'0x4e0fa57bde726079356537e2f34d671e9f41adbc'};
const artifact=async(file,name)=>JSON.parse(await readFile(new URL(`../out/${file}/${name}.json`,import.meta.url),'utf8'));
const factoryAbi=JSON.parse(await readFile(new URL('../test/fixtures/IMDLaunchFactory.abi.json',import.meta.url),'utf8'));
const factory={address:addresses.factory,abi:factoryAbi};
const ercAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
const imd={address:addresses.imd,abi:ercAbi};
const read=(c,functionName,args=[])=>client.readContract({...c,functionName,args});
async function wait(hash,expected='success'){
  // Anvil automines. Poll receipts directly: the L2 fork's block-number watcher can cache a
  // synthetic tip and miss a receipt when several fixture transactions mine in rapid sequence.
  for(let i=0;i<100;i++) {try {const receipt=await client.getTransactionReceipt({hash});assert.equal(receipt.status,expected);return receipt;}catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;}await new Promise(r=>setTimeout(r,100));}
  throw Error('Local transaction did not mine: '+hash);
}
async function call(c,functionName,args=[],account=actor){return wait(await wallet.writeContract({...c,functionName,args,account,gas:15000000n}));}
async function deploy(file,name,args=[]){const a=await artifact(file,name);const receipt=await wait(await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,gas:15000000n}));return{address:receipt.contractAddress,abi:a.abi};}
const owner='0x4251627b712762b6e81799698a05c6c9dff35c5d';
const report={status:'running',snapshot:{chainId:4663,blockNumber:Number(BigInt(forkBlock.number)),blockHash:forkBlock.hash},localChainId:31337,publicTransactions:0,realFundsSpent:'0',publicRpcMethods:methodCounts,addresses,runtimeHashes:{},cases:[]};
try {
  let ready=false;
  for(let i=0;i<120;i++) {if(startupError) throw startupError;if(child.exitCode!==null) throw Error('Anvil stopped: '+stderr);try{ready=(await client.getChainId())===31337;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Fork node unavailable');
  addresses.manager=(await read(factory,'poolManager')).toLowerCase();
  for(const [name,address] of Object.entries(addresses).filter(([n])=>n!=='payee')) {const code=await client.getCode({address});assert.ok(code&&code!=='0x');report.runtimeHashes[name]=keccak256(code);}
  assert.equal((await read(factory,'poolManager')).toLowerCase(),addresses.manager);
  assert.equal((await read(factory,'fees')).toLowerCase(),addresses.fees);
  const deployer=await read(factory,'deployer');
  assert.equal(await read(factory,'SWARM_BPS'),1000);
  await client.request({method:'anvil_impersonateAccount',params:[owner]});
  await client.request({method:'anvil_setBalance',params:[owner,toHex(100n*10n**18n)]});
  const fees={address:addresses.fees,abi:parseAbi(['function poolFee() view returns(uint24)','function REQUESTER_BPS() view returns(uint16)','function feeRecipient() view returns(address)'])};
  assert.equal(await read(fees,'poolFee'),12500);assert.equal(await read(fees,'REQUESTER_BPS'),8000);
  const networkRecipient=await read(fees,'feeRecipient');
  await client.request({method:'anvil_impersonateAccount',params:[deployer]});
  await client.request({method:'anvil_setBalance',params:[deployer,toHex(100n*10n**18n)]});
  // Artificial ERC-20 balance on the disposable fork; preserve the deployed IMD runtime.
  // Probe mapping slots and restore unsuccessful probes. Never touch a real holder's balance.
  let balanceSlot;
  for(let slot=0;slot<32;slot++) {
    const key=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[actor,BigInt(slot)]));
    const original=await client.getStorageAt({address:addresses.imd,slot:key});
    await client.request({method:'anvil_setStorageAt',params:[addresses.imd,key,toHex(300n*10n**18n,{size:32})]});
    if(await read(imd,'balanceOf',[actor])===300n*10n**18n){balanceSlot=slot;break;}
    await client.request({method:'anvil_setStorageAt',params:[addresses.imd,key,original??toHex(0,{size:32})]});
  }
  assert.notEqual(balanceSlot,undefined,'Could not locate fixture balance storage');report.fixtureBalanceMappingSlot=balanceSlot;
  console.log('Read-only snapshot verified; local balance fixture prepared.');
  const router=productionRouter
    ? await prepareProductionRouter({client,read,call,actor,imd,addresses,report})
    : await deploy('PoolSwapTest.sol','PoolSwapTest',[addresses.manager]);
  const math=await deploy('FactoryReviewMath.sol','FactoryReviewMath');
  const tokenArtifact=await artifact('LaunchToken.sol','LaunchToken');
  const hookArtifact=await artifact('CabalFundingHook.sol','CabalFundingHook');
  if(!productionRouter)await call(imd,'approve',[router.address,2n**256n-1n]);
  const treasury=owner;
  const zero=toHex(0,{size:32});
  for(const wantToken0 of [true,false]) {
    // Each ordering starts from the same funded fixture; adversarial price moves
    // must not depend on a previous scenario's remaining simulated balance.
    const caseSnapshot=await client.request({method:'evm_snapshot',params:[]});
    let launchNumber=18000000000000000000n+(wantToken0?0n:10000n),tokenAddress;
    for(let i=0;i<100;i++,launchNumber++) {tokenAddress=getCreate2Address({from:addresses.factory,salt:toHex(launchNumber,{size:32}),bytecodeHash:keccak256(tokenArtifact.bytecode.object)});if((BigInt(tokenAddress)<BigInt(addresses.imd))===wantToken0)break;}
    assert.equal(BigInt(tokenAddress)<BigInt(addresses.imd),wantToken0);
    assert.equal((await read(factory,'predictToken',[launchNumber,tokenArtifact.bytecode.object])).toLowerCase(),tokenAddress.toLowerCase());
    const initCode=encodeDeployData({abi:hookArtifact.abi,bytecode:hookArtifact.bytecode.object,args:[addresses.manager,addresses.factory,addresses.imd,addresses.intake,owner,treasury]});
    const initCodeHash=keccak256(initCode);
    let salt,hookAddress;
    for(let i=0;i<1000000;i++){salt=toHex(i+(wantToken0?0:1000000),{size:32});hookAddress=getCreate2Address({from:addresses.factory,salt,bytecodeHash:initCodeHash});if((BigInt(hookAddress)&0x3fffn)===0x20ccn)break;}
    assert.equal(BigInt(hookAddress)&0x3fffn,0x20ccn);
    assert.equal((await read(factory,'predictHook',[initCode,salt])).toLowerCase(),hookAddress.toLowerCase());
    const [price,lower,upper,liquidity]=await read(math,'seed',[wantToken0,880000000n*10n**18n]);
    const params={launchNumber,kind:toHex('univ4_hook',{size:32}),tokenCreationCode:tokenArtifact.bytecode.object,hookCreationCode:initCode,hookSalt:salt,hookFlags:0x20ccn,totalSupply:10n**27n,poolBps:8800,remainderTo:owner,merkleRoot:keccak256(toHex('LOCAL FIXTURE ONLY')),contributorLockSeconds:3600n,sweepDelaySeconds:31536000n,pairedCurrency:addresses.imd,fee:12500,tickSpacing:60,sqrtPriceX96:price,tickLower:lower,tickUpper:upper,liquidity,record:{kind:zero,launchNumber,recordedAt:BigInt(forkBlock.timestamp),sourceCommit:zero,manifestHash:zero,attestationHash:zero,verifierKey:zero,sourceRepoUrl:''},agentIds:[],requester:owner};
    // No path exists from this client to a public mutation: wallet transport is fixed loopback.
    const deployed=await call(factory,'launch',[params],deployer);
    console.log('Local factory deployment and pool seeding passed; token0='+wantToken0);
    const hook={address:hookAddress,abi:hookArtifact.abi};
    assert.equal(await read(hook,'initialized'),true);assert.equal(await read(hook,'paymentsEnabled'),false);
    assert.equal((await read(hook,'owner')).toLowerCase(),owner);
    assert.equal((await read(hook,'treasury')).toLowerCase(),owner);
    assert.equal(await read(hook,'worker'),'0x0000000000000000000000000000000000000000');
    assert.equal(await read(hook,'maxRequestAmount'),0n);assert.equal(await read(hook,'dailyLimit'),0n);
    const [key]=await read(factory,'positionOf',[launchNumber]);assert.equal(key.hooks.toLowerCase(),hookAddress.toLowerCase());
    const token={address:tokenAddress,abi:tokenArtifact.abi};
    assert.equal(await read(token,'PVP_MINIMUM_HOLDING'),50_000n*10n**18n);
    assert.equal(await read(token,'isPvpEligible',[actor]),false);
    assert.equal(await read(token,'isPvpEligible',[owner]),true);
    const remainderBalance=await read(token,'balanceOf',[owner]);
    const poolTokenBalance=await read(token,'balanceOf',[addresses.manager]);
    assert.ok(remainderBalance>=20_000_000n*10n**18n);
    assert.equal(remainderBalance+poolTokenBalance,900_000_000n*10n**18n,'pool + remainder must be exactly 90%');
    const liquidityDust=remainderBalance-20_000_000n*10n**18n;
    assert.ok(liquidityDust<10n**12n,'unexpected seed dust');
    assert.equal(await read(token,'totalSupply'),10n**27n);
    assert.equal(key.fee,12500);assert.equal(key.tickSpacing,60);
    const poolId=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]));
    assert.equal(await read(hook,'boundPool'),poolId);
    const deployedRuntime=await client.getCode({address:hookAddress});
    assert.equal((await read(hook,'factory')).toLowerCase(),addresses.factory);
    assert.equal((await read(hook,'manager')).toLowerCase(),addresses.manager);
    // Local trade inventory only: allocation was verified above, then the remainder holder
    // transfers 20m CABAL to the disposable trader for the existing liquidity-boundary cases.
    await call(token,'transfer',[actor,20_000_000n*10n**18n],owner);
    let tradingReview;
    if(productionRouter) {
      tradingReview=await reviewProductionTrades({client,read,call,actor,imd,token,hook,key,router,
        sendRevert:async c=>wait(await wallet.writeContract({...c,gas:15000000n}),'reverted')});
    } else {
    await call(token,'approve',[router.address,2n**256n-1n]);
    const swap=async(buy,exactInput,amount)=>{const zeroForOne=buy===(!wantToken0);return call(router,'swap',[key,{zeroForOne,amountSpecified:exactInput?-amount:amount,sqrtPriceLimitX96:zeroForOne?4295128740n:1461446703485210103287273052203988822378723970341n},{takeClaims:false,settleUsingBurn:false},'0x']);};
    const initialImd=await read(imd,'balanceOf',[actor]);
    await swap(true,true,100n*10n**18n);
    assert.equal(initialImd-await read(imd,'balanceOf',[actor]),100n*10n**18n);assert.equal(await read(hook,'pendingFees'),4n*10n**18n);
    await swap(false,true,100000n*10n**18n);await swap(true,false,100000n*10n**18n);await swap(false,false,10n**17n);
    }
    const total=await read(hook,'pendingFees');await call(hook,'harvest',[total]);
    assert.equal(await read(hook,'requestBalance'),total*7n/10n);assert.equal(await read(hook,'treasuryBalance'),total-total*7n/10n);
    const treasuryBefore=await read(imd,'balanceOf',[treasury]);const due=await read(hook,'treasuryBalance');await call(hook,'payTreasury',[due]);assert.equal((await read(imd,'balanceOf',[treasury]))-treasuryBefore,due);
    const beforeFund=await read(hook,'requestBalance');const payerBefore=await read(imd,'balanceOf',[owner]);const networkBefore=await read(imd,'balanceOf',[networkRecipient]);
    await call(factory,'claimFees',[launchNumber]);
    assert.equal(await read(hook,'requestBalance'),beforeFund);assert.equal(await read(hook,'pendingFees'),0n);
    const payerFee=await read(imd,'balanceOf',[owner])-payerBefore;const networkFee=await read(imd,'balanceOf',[networkRecipient])-networkBefore;
    assert.ok(payerFee>0n&&networkFee>0n);assert.equal(payerFee,(payerFee+networkFee)*8n/10n);
    await call(hook,'configureWorker',[actor,5n*10n**17n,10n**18n,true],owner);
    const payeeBefore=await read(imd,'balanceOf',[addresses.payee]);
    await call(hook,'payRequest',[keccak256(toHex('local-fork-decision-'+wantToken0)),toHex('{"question":"Local fixture only; not submitted to any swarm"}'),5n*10n**17n,BigInt(forkBlock.timestamp)+86400n]);
    assert.equal(await read(hook,'requestBalance'),beforeFund-5n*10n**17n);assert.equal(await read(imd,'balanceOf',[addresses.payee])-payeeBefore,5n*10n**17n);
    assert.equal(await read(imd,'allowance',[hookAddress,addresses.intake]),0n);
    report.cases.push({tokenSortsFirst:wantToken0,localFixture:true,tokenAddress,hookAddress,hookSalt:salt,hookConstructorArgs:[addresses.manager,addresses.factory,addresses.imd,addresses.intake,owner,treasury],hookInitCodeHash:keccak256(initCode),hookRuntimeKeccak256:keccak256(deployedRuntime),tokenRuntimeKeccak256:keccak256(await client.getCode({address:tokenAddress})),boundPool:poolId,initializerSender:addresses.factory,owner,treasury,poolBps:8800,remainderBps:200,swarmBps:1000,liquidityDustToRemainderAtomic:liquidityDust.toString(),seedTokenAmountAtomic:poolTokenBalance.toString(),defaultDisabledVerified:true,factoryDeploymentPassed:true,initCallbackPassed:true,permissionMask:'0x20cc',swapModesPassed:4,customTaxCollectedImd:formatEther(total),requestShareImd:formatEther(beforeFund),treasuryPaidImd:formatEther(due),platformFeeCollectionPassed:true,platformPayerFeeImd:formatEther(payerFee),platformNetworkFeeImd:formatEther(networkFee),realIntakeCodePaymentPassedLocally:true,approvalCleared:true,deploymentGasUsed:deployed.gasUsed.toString(),hookRuntimeBytes:((await client.getCode({address:hookAddress})).length-2)/2,...(tradingReview?{tradingReview}:{})});
    console.log(JSON.stringify(report.cases.at(-1)));
    assert.equal(await client.request({method:'evm_revert',params:[caseSnapshot]}),true);
  }
  report.generatedAt=new Date().toISOString();report.status='passed';
  report.limits=['Local fork exercises deployed factory, pool manager, IMD and intake code; no real launch or oracle admission occurred.','Owner/treasury/remainder/requester use the authorized project address; an Anvil account receives artificial IMD via a local storage override and the IMD deployer is impersonated only in the disposable fork.','Token launch number, cap/range, Merkle root, record and signatures are fixtures, not an approved IMD manifest.','Trading uses the Uniswap test router, not the production IMD web trading router.','Off-chain IMD manifest admission, audits, price quoting and UI router integration still require their own verification.'];
  if(productionRouter) report.limits.splice(3,2,'Trading uses the deployed production UniversalRouter, V4Quoter and Permit2 with the observed IMD UI encoding. The actual browser wallet flow was not clicked and no real pool exists yet.','IMD off-chain manifest acceptance and independent review remain. Recheck production frontend/deployment addresses and quotes against the final live pool before trading opens.');
} catch(error) {report.status='failed';report.failure=error.shortMessage??error.message;throw error;}
finally {await writeFile(new URL('../reports/'+(productionRouter?'production-router-review.json':'factory-fork-review.json'),import.meta.url),JSON.stringify(report,null,2)+'\n');child.kill();await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
