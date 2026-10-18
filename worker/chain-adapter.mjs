import { createOracleClient, ORACLE_ACTION, OracleTermsChanged } from './oracle-client.mjs';
export const REQUEST_DEADLINE_SECONDS = 1800;
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeEventLog, keccak256, toHex, isAddress, recoverTransactionAddress, parseTransaction } from '../vendor/viem.mjs';

export const ABI = parseAbi([
  'function imd() view returns(address)', 'function intake() view returns(address)', 'function treasury() view returns(address)',
  'function worker() view returns(address)', 'function paymentsEnabled() view returns(bool)',
  'function maxRequestAmount() view returns(uint256)', 'function dailyLimit() view returns(uint256)',
  'function requestBalance() view returns(uint256)', 'function treasuryBalance() view returns(uint256)', 'function pendingFees() view returns(uint256)',
  'function harvest(uint256 amount)', 'function payTreasury(uint256 amount)',
  'function payRequest(bytes32 key,bytes body,uint256 amount,uint256 deadline) returns(bytes32)',
  'event RequestPaid(bytes32 indexed key,bytes32 indexed requestId,bytes32 bodyHash,uint256 amount)',
  'event FeesAllocated(uint256 amount,uint256 requests,uint256 treasuryAmount)',
  'event TreasuryPaid(address indexed recipient,uint256 amount)',
]);
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
export function validateLiveConfig(config) {
  if(config.mode!=='live' || config.liveExecutionApproved!==true) throw Error('Execution disabled');
  if(config.chainId!==4663 || config.apiUrl!=='https://api.imd.fun') throw Error('Unapproved request network');
  for(const key of ['contract','imd','intake','treasury','worker']) if(!isAddress(config[key]) || /^0x0{40}$/i.test(config[key])) throw Error('Missing address: '+key);
  if(!same(config.imd,'0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127') || !same(config.intake,'0xa43e6f75ee006411f79ac1c84120606c2330de82')) throw Error('Unreviewed payment contracts');
  if(!/^0x[0-9a-f]{64}$/i.test(config.runtimeCodeHash)) throw Error('Reviewed runtime code hash required');
  if(new URL(config.rpcUrl).protocol!=='https:') throw Error('HTTPS RPC required');
  for(const key of ['maxGasPerTransactionWei','minimumGasBalanceWei','requestPriceAtomic','dailyLimitAtomic']) if(!config[key] || BigInt(config[key])<=0n) throw Error('Missing spending limit: '+key);
  if(!Number.isInteger(config.confirmations) || config.confirmations<2) throw Error('Insufficient confirmation policy');
}

// A wallet client must be explicitly supplied by the server secret-management integration.
// This module never discovers wallets, reads key files, loads browser accounts or creates a key.
export function createChainAdapter(config, walletClient) {
  validateLiveConfig(config);
  return buildAdapter(config,walletClient,false);
}
export function createLocalChainAdapter(config,walletClient) {
  const url=new URL(config.rpcUrl);
  if(config.mode!=='simulate' || config.chainId!==31337 || url.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Local EVM simulation only');
  return buildAdapter(config,walletClient,true);
}
function buildAdapter(config,walletClient,local) {
  if(!same(walletClient?.account?.address,config.worker)) throw Error('Wrong worker signer');
  const client=createPublicClient({transport:http(config.rpcUrl,{timeout:8000,retryCount:0})});
  const oracle=local?null:createOracleClient(config);
  const read=(functionName)=>client.readContract({address:config.contract,abi:ABI,functionName});
  const adapter={liveAuthorized:!local,localOnly:local,
    async assertReady() {
      const [chainId,code,imd,intake,treasury,worker,enabled,perRequest,perDay]=await Promise.all([
        client.getChainId(),client.getCode({address:config.contract}),...['imd','intake','treasury','worker','paymentsEnabled','maxRequestAmount','dailyLimit'].map(read),
      ]);
      if(chainId!==config.chainId || !code || keccak256(code)!==config.runtimeCodeHash) throw Error('Contract/chain mismatch');
      if(!same(imd,config.imd)||!same(intake,config.intake)||!same(treasury,config.treasury)||!same(worker,config.worker)||!enabled) throw Error('Funding settings mismatch');
      if(perRequest!==BigInt(config.requestPriceAtomic)||perDay!==BigInt(config.dailyLimitAtomic)) throw Error('On-chain spending policy mismatch');
    },
    async balances() {
      const [requestBalance,treasuryBalance,pendingFees,gas]=await Promise.all([read('requestBalance'),read('treasuryBalance'),read('pendingFees'),client.getBalance({address:config.worker})]);
      return {requestBalance,treasuryBalance,pendingFees,gas};
    },
    async terms() {
      const action=local?{amount:config.requestPriceAtomic}:await oracle.terms();
      const price=await client.readContract({address:config.intake,abi:parseAbi(['function priceOf(bytes32,address) view returns(uint256)']),functionName:'priceOf',args:[ORACLE_ACTION,config.imd]});
      if(price!==BigInt(config.requestPriceAtomic)) throw new OracleTermsChanged();
      return action;
    },
    async preflight(body) {
      // Simulation is restricted to loopback chain 31337 and a mock Intake; no HTTP admission claimed.
      return local?{approved:true,simulationOnly:true}:oracle.preflight(body);
    },
    async prepare(row) {
      let functionName,args;
      if(row.kind==='request') {functionName='payRequest'; args=[row.id,toHex(JSON.parse(row.payload).body),BigInt(row.amount),BigInt(Math.floor(Date.now()/1000)+REQUEST_DEADLINE_SECONDS)];}
      else if(row.kind==='harvest') {functionName='harvest'; args=[BigInt(row.amount)];}
      else if(row.kind==='treasury') {functionName='payTreasury'; args=[BigInt(row.amount)];}
      else throw Error('Unrecognized operation');
      const data=encodeFunctionData({abi:ABI,functionName,args});
      const estimated=await client.estimateGas({account:config.worker,to:config.contract,data,value:0n});
      const gas=estimated*120n/100n+1n;
      const tx=await walletClient.prepareTransactionRequest({account:walletClient.account,to:config.contract,data,value:0n,chain:walletClient.chain,gas});
      if(tx.chainId!==config.chainId) throw Error('Signer network mismatch');
      const fee=tx.maxFeePerGas??tx.gasPrice;
      if(!fee || gas*fee>BigInt(config.maxGasPerTransactionWei)) throw Error('Gas cap exceeded');
      const raw=await walletClient.signTransaction({...tx,account:walletClient.account});
      const decoded=parseTransaction(raw);
      if(!same(await recoverTransactionAddress({serializedTransaction:raw}),config.worker)||decoded.chainId!==config.chainId||!same(decoded.to,config.contract)||decoded.data!==data||BigInt(decoded.value??0)!==0n||decoded.gas!==gas||(decoded.maxFeePerGas??decoded.gasPrice)!==fee||decoded.nonce!==tx.nonce) throw Error('Signed transaction mismatch');
      return {raw,hash:keccak256(raw)};
    },
    async broadcast(raw) { return client.sendRawTransaction({serializedTransaction:raw}); },
    async verifyCheckpoint(checkpoint) {const block=await client.getBlock({blockNumber:BigInt(checkpoint.number)});return block.hash===checkpoint.hash;},
    async reconcile(row) {
      let receipt;
      try {receipt=await client.getTransactionReceipt({hash:row.hash});}
      catch(error) {
        if(error.name!=='TransactionReceiptNotFoundError') throw error;
        try {await client.getTransaction({hash:row.hash}); return {state:'pending'};}
        catch(inner) {if(inner.name!=='TransactionNotFoundError') throw inner; return {state:'absent'};}
      }
      const [height,block]=await Promise.all([client.getBlockNumber({cacheTime:0}),client.getBlock({blockNumber:receipt.blockNumber})]);
      if(block.hash!==receipt.blockHash) return {state:'reorg'};
      if(height-receipt.blockNumber+1n<BigInt(config.confirmations)) return {state:'pending'};
      if(receipt.status==='reverted') return {state:'reverted'};
      if(!same(receipt.to,config.contract)||!same(receipt.from,config.worker)||receipt.transactionHash!==row.hash) return {state:'mismatch'};
      const eventName={request:'RequestPaid',harvest:'FeesAllocated',treasury:'TreasuryPaid'}[row.kind];
      const logs=receipt.logs.filter(l=>same(l.address,config.contract)).flatMap(l=>{try{return [decodeEventLog({abi:ABI,data:l.data,topics:l.topics})];}catch{return [];}}).filter(e=>e.eventName===eventName);
      if(logs.length!==1 || logs[0].args.amount!==BigInt(row.amount)) return {state:'mismatch'};
      const event=logs[0].args;
      if(row.kind==='request' && event.key!==row.id) return {state:'mismatch'};
      if(row.kind==='treasury' && !same(event.recipient,config.treasury)) return {state:'mismatch'};
      return {state:'confirmed',requestId:event.requestId??null,bodyHash:event.bodyHash??null,checkpoint:{number:receipt.blockNumber.toString(),hash:receipt.blockHash}};
    },
  };
  return adapter;
}
