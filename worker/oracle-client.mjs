// Read-only preflight. This module never pays, waives screening, or accepts oracle results.
export const ORACLE_LIMITS = Object.freeze({minPanelSize:5,maxPanelSize:100});
export const ORACLE_ACTION = '0x6f7261636c652e72657175657374406f7261636c652d31000000000000000000';
export class OracleTermsChanged extends Error {
  constructor() {super('Oracle terms changed; operational review required');this.name='OracleTermsChanged';}
}
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
export function assertPanelLimits(limits) {
  if(limits?.minPanelSize!==ORACLE_LIMITS.minPanelSize || limits?.maxPanelSize!==ORACLE_LIMITS.maxPanelSize) throw new OracleTermsChanged();
}
export function decisionBody(input,chainId) {
  if(input?.v!==1 || input.chainId!==chainId || input.answerType!=='uint256' || input.evidence!=='panel'
    || input.panelSize!==5 || input.quorum!==4 || input.toleranceBps!==0 || input.guards?.min!=='0' || input.guards?.max!=='3'
    || typeof input.question!=='string' || input.question.length<20 || input.question.length>2000 || !input.question.isWellFormed()) throw Error('Invalid frozen decision input');
  // Deliberately explicit: no callbacks, screening waivers, private policy or account metadata.
  return JSON.stringify({v:1,chainId,question:input.question,window:{hours:24},answerType:'uint256',evidence:'panel',panelSize:5,quorum:4,toleranceBps:0,validForSeconds:300,guards:{min:'0',max:'3'}});
}
export function checkedInput(body,chainId) {
  if(typeof body!=='string' || Buffer.byteLength(body)>16384) throw Error('Invalid request body');
  const input=JSON.parse(body), expected=JSON.parse(decisionBody(input,chainId));
  // Compare structure, independent of JSON property order; reject extensions/waivers in a saved job.
  const canonical=value=>value && typeof value==='object'
    ? JSON.stringify(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : JSON.stringify(value);
  if(canonical(input)!==canonical(expected)) throw Error('Unreviewed saved request fields');
  // /requests/check rejects the full paid body. Its documented shorter schema screens
  // these exact fields; the other paid fields above stay fixed and are not replaced by its draft.
  const {question,panelSize,answerType,evidence,toleranceBps}=input;
  return {question,panelSize,answerType,evidence,chainId,toleranceBps};
}
export function createOracleClient(config,request=globalThis.fetch) {
  if(config.apiUrl!=='https://api.imd.fun') throw Error('Unapproved oracle endpoint');
  async function json(path,options={}) {
    const response=await request(config.apiUrl+path,{...options,redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw Error('Oracle preflight unavailable or refused');
    return response.json();
  }
  return {
    async terms() {
      const cap=await json('/requests/capabilities');
      assertPanelLimits(cap.limits?.['oracle.request']);
      const chain=cap.onchain?.chains?.find(c=>c.chainId===config.chainId);
      const action=chain?.actions?.find(a=>a.action==='oracle.request');
      if(!same(chain?.asset,config.imd)||!same(chain?.intake,config.intake)||chain?.decimals!==18
        || action?.version!=='oracle-1'||action?.actionId!==ORACLE_ACTION||action?.amount!==config.requestPriceAtomic) throw new OracleTermsChanged();
      return action;
    },
    async preflight(body) {
      const input=checkedInput(body,config.chainId);
      const result=await json('/requests/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'oracle.request',input})});
      assertPanelLimits(result.limits);
      if(result.action!=='oracle.request' || result.judged!==true || !Array.isArray(result.blockers)) throw Error('Oracle check incomplete');
      if(result.blockers.length) return {approved:false};
      // A draft for a different question/network/type/panel must never approve these bytes.
      for(const key of ['question','panelSize','answerType','evidence','chainId']) if(result.request?.[key]!==input[key]) throw Error('Oracle check input mismatch');
      if(result.request.quorum!==4 || result.request.window?.hours!==24) throw Error('Oracle check policy mismatch');
      return {approved:true};
    },
  };
}
