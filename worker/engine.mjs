import { OracleTermsChanged } from './oracle-client.mjs';
import { dayCapHeadroom, nextUtcDayStart, utcDay } from './day-cap.mjs';
import { keccak256, toHex } from '../vendor/viem.mjs';

// The adapter is injected. No wallet, credentials, endpoint or broadcaster is created here.
export class FundingEngine {
  constructor({store,adapter,mode='disabled',minGasWei=0n,maintenanceMin=1n}) {
    if(!['disabled','simulate','live'].includes(mode)) throw Error('Invalid mode');
    this.store=store; this.adapter=adapter; this.mode=mode; this.minGasWei=BigInt(minGasWei); this.maintenanceMin=BigInt(maintenanceMin);
    if(mode==='live' && adapter.liveAuthorized!==true) throw Error('Live execution is not authorized/configured');
    if(mode==='simulate' && adapter.localOnly!==true) throw Error('Simulation requires a local-only adapter');
  }
  async runOnce() {
    if(this.mode==='disabled') return {state:'disabled'};
    if(!this.store.acquire()) return {state:'busy'};
    try {
      if(this.store.blocked()) return {state:'blocked'};
      await this.adapter.assertReady();
      this.store.assertLease();
      const checkpoint=this.store.checkpoint();
      if(checkpoint && !(await this.adapter.verifyCheckpoint(checkpoint))) {
        this.store.assertLease(); this.store.halt('Confirmed funding history reorganized; reconciliation required'); return {state:'blocked'};
      }
      this.store.assertLease();
      let row=this.store.next();
      if(row?.state==='preparing' && !row.raw) { this.store.patch(row.id,{state:'queued',error:null}); row=this.store.get(row.id); }
      if(row?.raw) {
        // Always reconcile before rebroadcasting the SAME signed bytes. Never create a replacement payment.
        const observed=await this.adapter.reconcile(row);
        this.store.assertLease();
        if(observed.state==='confirmed') {
          if(row.kind==='request' && observed.bodyHash!==keccak256(toHex(JSON.parse(row.payload).body))) {
            this.store.patch(row.id,{state:'blocked',error:'Confirmed payment body mismatch'}); return {state:'blocked'};
          }
          this.store.complete(row.id,observed.requestId,observed.checkpoint); return {state:'confirmed',id:row.id};
        }
        if(observed.state==='reverted') { this.store.patch(row.id,{state:'failed',error:'Confirmed transaction reverted; no automatic paid retry'}); return {state:'failed',id:row.id}; }
        if(observed.state==='reorg' || observed.state==='mismatch') { this.store.patch(row.id,{state:'blocked',error:'Chain reconciliation needs operator review'}); return {state:'blocked',id:row.id}; }
        if(observed.state==='pending') return {state:'pending',id:row.id};
        if(observed.state!=='absent') return {state:'uncertain',id:row.id};
      }
      const balances=await this.adapter.balances();
      this.store.assertLease();
      if(BigInt(balances.gas)<this.minGasWei) return {state:'low_gas'};
      // A request the contract's UTC-day cap would reject is deferred without signing or simulating
      // anything; maintenance is never capped and still runs behind it.
      const capped=Boolean(row && !row.raw && row.kind==='request' && dayCapHeadroom(balances)<BigInt(row.amount));
      if(!row?.raw && (!row || row.kind==='request' && (capped || this.store.maintenanceDue() || BigInt(balances.requestBalance)<BigInt(row.amount)))) {
        // Bounded maintenance does not starve requests during continuous trading. Finish a treasury
        // payout before the next harvest, even when swaps continue to accrue new fee claims.
        if(BigInt(balances.treasuryBalance)>=this.maintenanceMin) row=this.store.enqueueMaintenance('treasury',balances.treasuryBalance);
        else if(BigInt(balances.pendingFees)>=this.maintenanceMin) row=this.store.enqueueMaintenance('harvest',balances.pendingFees);
      }
      if(!row) return {state:'idle'};
      if(!row.raw) {
        if(row.kind==='harvest' || row.kind==='treasury') {
          // These functions are permissionless: another caller may have settled the saved amount.
          // Only unsigned maintenance can change. Signed bytes and request input stay immutable.
          const available=BigInt(row.kind==='harvest'?balances.pendingFees:balances.treasuryBalance);
          if(available===0n) {
            this.store.patch(row.id,{state:'failed',error:'Maintenance already settled by another caller; no transaction sent'});
            return {state:'superseded',id:row.id};
          }
          if(available<BigInt(row.amount)) {this.store.resizeUnsignedMaintenance(row.id,available);row=this.store.get(row.id);}
        }
        if(row.kind==='request') {
          const terms=await this.adapter.terms();
          this.store.assertLease();
          if(BigInt(terms.amount)!==BigInt(row.amount)) {this.store.halt('Oracle price changed; operational review required');return {state:'price_changed',id:row.id};}
          if(BigInt(balances.requestBalance)<BigInt(row.amount)) return {state:'low_imd',id:row.id};
          if(capped) {
            const resumesAt=nextUtcDayStart();
            this.store.noteDayCap(utcDay(),{id:row.id,resumesAt,dailyLimit:String(balances.dailyLimit),spentToday:String(balances.spentToday)});
            return {state:'day_cap',id:row.id,resumesAt};
          }
          const checked=await this.adapter.preflight(JSON.parse(row.payload).body);
          this.store.assertLease();
          if(checked?.approved!==true) {this.store.patch(row.id,{state:'blocked',error:'Oracle wording check refused; no payment signed'});return {state:'blocked',id:row.id};}
        }
        this.store.patch(row.id,{state:'preparing'});
        const prepared=await this.adapter.prepare(row);
        this.store.assertLease();
        if(!/^0x[0-9a-f]+$/i.test(prepared.raw) || keccak256(prepared.raw)!==prepared.hash) throw Error('Invalid prepared transaction');
        // Commit before the first possible network broadcast, including hash and nonce in signed bytes.
        this.store.patch(row.id,{state:'prepared',raw:prepared.raw,hash:prepared.hash,error:null});
        row=this.store.get(row.id);
      }
      this.store.assertLease();
      this.store.patch(row.id,{state:'submitted'});
      try { const hash=await this.adapter.broadcast(row.raw); if(hash!==row.hash) throw Error('Unexpected broadcast hash'); }
      catch(error) { this.store.patch(row.id,{error:'Broadcast outcome uncertain; reconcile saved transaction'}); return {state:'uncertain',id:row.id}; }
      return {state:'submitted',id:row.id,hash:row.hash};
    } catch(error) {
      if(error instanceof OracleTermsChanged) {this.store.halt('Oracle terms changed; operational review required');return {state:'terms_changed'};}
      // Record a generic operational status, never wallet/transport exceptions that may contain credentials.
      this.store.event('worker_error',{message:'Worker operation failed; inspect local diagnostics and reconcile before retry'});
      return {state:'unavailable'};
    } finally { this.store.release(); }
  }
}
