// Local-fork regression cases for IMD Explorer's observed production trading path.
// This module creates no transport or signer; the caller confines writes to loopback.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parseAbi,encodeAbiParameters,keccak256,formatEther,toFunctionSelector} from '../vendor/viem.mjs';
export const trading={router:'0x8876789976decbfcbbbe364623c63652db8c0904',quoter:'0x8dc178efb8111bb0973dd9d722ebeff267c98f94',permit2:'0x000000000022d473030f116ddee9f6b43ac78ba3'};
const poolFields=[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}];
const permitAbi=parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)','function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)']);
const permit={address:trading.permit2,abi:permitAbi};
const max160=(1n<<160n)-1n,expiry=Number((1n<<48n)-1n);
export function encodeTrade(key,zeroForOne,amount,limit,exactInput=true) {
  const swap=encodeAbiParameters([{type:'tuple',components:[{name:'poolKey',type:'tuple',components:poolFields},{name:'zeroForOne',type:'bool'},{name:exactInput?'amountIn':'amountOut',type:'uint128'},{name:exactInput?'amountOutMinimum':'amountInMaximum',type:'uint128'},{name:'minHopPriceX36',type:'uint256'},{name:'hookData',type:'bytes'}]}],[{poolKey:key,zeroForOne,[exactInput?'amountIn':'amountOut']:amount,[exactInput?'amountOutMinimum':'amountInMaximum']:limit,minHopPriceX36:0n,hookData:'0x'}]);
  const [input,output]=zeroForOne?[key.currency0,key.currency1]:[key.currency1,key.currency0];
  const payment=encodeAbiParameters([{type:'address'},{type:'uint256'}],[input,exactInput?amount:limit]);
  const receipt=encodeAbiParameters([{type:'address'},{type:'uint256'}],[output,exactInput?limit:amount]);
  return {commands:'0x10',inputs:[encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[exactInput?'0x060c0f':'0x080c0f',[swap,payment,receipt]])]};
}
export async function prepareProductionRouter({client,read,call,actor,imd,addresses,report}) {
  const abi=JSON.parse(await readFile(new URL('../test/fixtures/IMDUniversalRouter.abi.json',import.meta.url),'utf8'));
  const quoterAbi=JSON.parse(await readFile(new URL('../test/fixtures/IMDV4Quoter.abi.json',import.meta.url),'utf8'));
  const router={address:trading.router,abi,quoter:{address:trading.quoter,abi:quoterAbi}};
  report.productionTrading={addresses:trading,frontendUrl:'https://explorer.imd.fun/_next/static/chunks/1fjby1-gan7u4.js',extendedSwapParams:true,command:'0x10',exactInputActions:'0x060c0f',slippageBps:100,deadlineSeconds:600};
  for(const [name,address] of Object.entries(trading)){const code=await client.getCode({address});assert.ok(code&&code!=='0x');report.runtimeHashes[name]=keccak256(code);}
  assert.equal((await read(router,'poolManager')).toLowerCase(),addresses.manager);
  assert.equal((await read(router.quoter,'poolManager')).toLowerCase(),addresses.manager);
  await call(imd,'approve',[trading.permit2,(1n<<256n)-1n]);
  await call(permit,'approve',[imd.address,trading.router,max160,expiry]);
  assert.equal((await read(permit,'allowance',[actor,imd.address,trading.router]))[0],max160);
  return router;
}
export async function reviewProductionTrades({client,read,call,actor,imd,token,hook,key,router,sendRevert}) {
  await call(token,'approve',[trading.permit2,(1n<<256n)-1n]);
  await call(permit,'approve',[token.address,trading.router,max160,expiry]);
  const zeroFor=buy=>buy===(key.currency0.toLowerCase()===imd.address.toLowerCase());
  const quote=async(buy,exactInput,amount)=>{
    const before=await read(hook,'totalFees');
    const [result]=await read(router.quoter,exactInput?'quoteExactInputSingle':'quoteExactOutputSingle',[{poolKey:key,zeroForOne:zeroFor(buy),exactAmount:amount,hookData:'0x'}]);
    assert.equal(await read(hook,'totalFees'),before,'Quote changed live accounting');return result;
  };
  const deadline=async()=> (await client.getBlock()).timestamp+600n;
  const command=(buy,exactInput,amount,limit)=>encodeTrade(key,zeroFor(buy),amount,limit,exactInput);
  const execute=async(buy,exactInput,amount,limit)=>{const c=command(buy,exactInput,amount,limit);return call(router,'execute',[c.commands,c.inputs,await deadline()]);};
  const state=async()=>Promise.all([read(imd,'balanceOf',[actor]),read(token,'balanceOf',[actor]),read(hook,'totalFees'),read(hook,'pendingFees')]);
  const reject=async(buy,exactInput,amount,limit,expired=false)=>{
    const before=await state(), c=command(buy,exactInput,amount,limit);
    const request={address:router.address,abi:router.abi,functionName:'execute',args:[c.commands,c.inputs,expired?1n:await deadline()],account:actor,value:0n};
    await assert.rejects(client.simulateContract(request));
    await sendRevert(request);assert.deepEqual(await state(),before,'Rejected trade retained tokens or fees');
  };
  const snapshot=()=>client.request({method:'evm_snapshot',params:[]});
  const restore=async id=>assert.equal(await client.request({method:'evm_revert',params:[id]}),true);
  const results=[];
  const residualBefore=await Promise.all([read(imd,'balanceOf',[router.address]),read(token,'balanceOf',[router.address])]);
  for(const [buy,exactInput,amount] of [[true,true,100n*10n**18n],[false,true,100000n*10n**18n],[true,false,100000n*10n**18n],[false,false,10n**17n]]) {
    const q=await quote(buy,exactInput,amount);assert.ok(q>0n);
    const limit=exactInput?q-q*100n/10000n:q+q*100n/10000n+1n;
    const before=await state();
    await execute(buy,exactInput,amount,limit);
    const after=await state();
    const actualInput=before[buy?0:1]-after[buy?0:1],actualOutput=after[buy?1:0]-before[buy?1:0],tax=after[2]-before[2];
    assert.equal(exactInput?actualOutput:actualInput,q,'Quote/execution mismatch');
    assert.equal(exactInput?actualInput:actualOutput,amount);
    if(buy&&exactInput) assert.equal(tax,amount/25n);
    if(!buy&&exactInput) assert.equal(tax,(actualOutput+tax)/25n);
    if(buy&&!exactInput)assert.equal(tax,(actualInput-tax)/24n+((actualInput-tax)%24n?1n:0n));
    if(!buy&&!exactInput)assert.equal(tax,amount/24n+(amount%24n?1n:0n));
    results.push({side:buy?'buy':'sell',mode:exactInput?'exact_input':'exact_output',quote:formatEther(q),input:formatEther(actualInput),output:formatEther(actualOutput),customTaxImd:formatEther(tax),quoteMatchesExecution:true});
  }
  assert.deepEqual(await Promise.all([read(imd,'balanceOf',[router.address]),read(token,'balanceOf',[router.address])]),residualBefore,'Router retained trade proceeds');
  const q=await quote(true,true,10n**18n);
  await reject(true,true,10n**18n,q+1n); // too little output
  const qi=await quote(false,false,10n**17n);
  await reject(false,false,10n**17n,qi-1n); // too much input
  await reject(true,true,10n**18n,q-q/100n,true);
  await call(permit,'approve',[imd.address,router.address,0n,expiry]);
  await reject(true,true,10n**18n,q-q/100n);
  await call(permit,'approve',[imd.address,router.address,max160,expiry]);
  await call(imd,'approve',[trading.permit2,0n]);
  await reject(true,true,10n**18n,q-q/100n);
  await call(imd,'approve',[trading.permit2,(1n<<256n)-1n]);
  const snap=await snapshot();
  const stale=await quote(true,true,10n*10n**18n);
  await execute(true,true,100n*10n**18n,0n); // local intervening trade
  const fresh=await quote(true,true,10n*10n**18n);assert.ok(fresh<stale-stale/100n);
  await reject(true,true,10n*10n**18n,stale-stale/100n);
  await execute(true,true,10n*10n**18n,fresh-fresh/100n);
  await restore(snap);
  const partialSnap=await snapshot();
  const wholeBalance=await read(token,'balanceOf',[actor]);
  const liquidityError=toFunctionSelector('NotEnoughLiquidity(bytes32)');
  await assert.rejects(quote(false,true,wholeBalance),error=>error.cause?.data?.args?.[0]?.startsWith(liquidityError)===true);
  assert.ok(await quote(false,true,wholeBalance/4n)>0n,'A smaller fillable sell must quote');
  // The UI correctly stops at the failed quote. Separately exercise the router's partial-fill
  // settlement directly, with a fixture minimum, to check unspent inputs and fee accounting.
  const beforeExit=await state();await execute(false,true,wholeBalance,1n);const afterExit=await state();
  const tokenUsed=beforeExit[1]-afterExit[1];assert.ok(tokenUsed>0n&&tokenUsed<wholeBalance,'Expected pool-bound partial sell');
  const exitOutput=afterExit[0]-beforeExit[0];assert.ok(exitOutput>0n);
  assert.equal(afterExit[2]-beforeExit[2],(exitOutput+afterExit[2]-beforeExit[2])/25n);
  await restore(partialSnap);
  await assert.rejects(quote(false,false,10000n*10n**18n));
  await reject(false,false,10000n*10n**18n,10n**27n);
  return {quotes:results,quoteCallsLeaveNoFees:true,slippageRejectsAtomically:true,maximumInputEnforced:true,expiredDeadlineRejected:true,permit2ApprovalRequired:true,erc20ApprovalRequired:true,staleQuoteRejectedAfterPriceMove:true,freshQuoteSucceedsAfterPriceMove:true,noRouterResidual:true,partialSell:{quoterRejectsPartialFill:true,quoterError:'NotEnoughLiquidity(bytes32)',smallerFillableAmountQuotes:true,rawRouterRequestedTokens:formatEther(wholeBalance),rawRouterTokensUsed:formatEther(tokenUsed),unusedTokensRemainWithTrader:true,rawRouterNetImdReceived:formatEther(exitOutput),taxOnFilledAmountOnly:true,uiDoesNotSubmitUnquotedTrade:true},impossibleExactOutputRejectedByQuoterAndRouter:true,scope:'Exact-input path mirrors Explorer UI. Exact-output adds coverage of the deployed router, although the current UI exposes only exact input. Partial-fill raw-router test deliberately bypasses the UI only on the local fork.'};
}
