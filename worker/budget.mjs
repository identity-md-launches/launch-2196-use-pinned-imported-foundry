import { decisionKey } from './store.mjs';
import { decisionBody, OracleTermsChanged } from './oracle-client.mjs';

/** Server-only API. Call at duel admission and when authoritative round evidence is frozen.
 * Do not expose these methods or raw question construction as unauthenticated browser endpoints.
 */
export class DuelFundingBudget {
  constructor({store,adapter,config}) {this.store=store;this.adapter=adapter;this.config=config;}
  async admit(matchId) {
    if(this.config.mode==='disabled') throw Error('Live swarm funding is disabled');
    // Serialize the balance snapshot/reservation with payment reconciliation. Otherwise a
    // payment could consume funds after this read while its released reservation admits a duel.
    if(!this.store.acquire()) throw Error('Funding coordinator busy; retry admission');
    try {
    await this.adapter.assertReady();
    const [balances,terms]=await Promise.all([this.adapter.balances(),this.adapter.terms()]);
    const price=BigInt(this.config.requestPriceAtomic);
    if(BigInt(terms.amount)!==price || this.store.blocked()) throw Error('Funding unavailable');
    if(this.config.minimumGasBalanceWei==null || this.config.minimumImdReserveAtomic==null) throw Error('Funding reserves must be configured');
    if(BigInt(balances.gas)<BigInt(this.config.minimumGasBalanceWei)) throw Error('Gas reserve too low');
    // BO5 has at most four intermissions, two player decisions per intermission.
    this.store.assertLease();
    this.store.reserveMatch(matchId,price*8n,balances.requestBalance,BigInt(this.config.minimumImdReserveAtomic));
    } catch(error) {
      if(error instanceof OracleTermsChanged) this.store.halt('Oracle terms changed; operational review required');
      throw error;
    } finally {this.store.release();}
  }
  async queueDecision({matchId,round,seat,input}) {
    if(this.config.mode==='disabled' || this.store.blocked()) throw Error('Swarm funding disabled');
    const id=decisionKey(this.config.chainId,this.config.contract,matchId,round,seat);
    const body=decisionBody(input,this.config.chainId); // freeze before any asynchronous work
    try {
      const terms=await this.adapter.terms();
      if(BigInt(terms.amount)!==BigInt(this.config.requestPriceAtomic)) throw new OracleTermsChanged();
      if((await this.adapter.preflight(body))?.approved!==true) throw Error('Oracle wording check refused');
      if(this.config.mode==='disabled' || this.store.blocked()) throw Error('Swarm funding disabled');
      return this.store.enqueue({id,match:matchId,amount:this.config.requestPriceAtomic,body});
    } catch(error) {
      if(error instanceof OracleTermsChanged) this.store.halt('Oracle terms changed; operational review required');
      throw error;
    }
  }
  finish(matchId) {this.store.closeMatch(matchId);}
}
