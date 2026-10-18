import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { keccak256, toHex } from '../vendor/viem.mjs';

const units = value => { const n = BigInt(value); if (n < 0n) throw Error('Negative amount'); return n; };
export const decisionKey = (chainId, contract, match, round, seat) => {
  if (!Number.isInteger(round) || round < 1 || round > 4 || ![0,1].includes(seat) || !/^[a-zA-Z0-9_-]{1,96}$/.test(match)) throw Error('Invalid decision identity');
  return keccak256(toHex(JSON.stringify(['cabal-funding-v1',chainId,contract.toLowerCase(),match,round,seat])));
};
export class FundingStore {
  constructor(path) {
    this.db = new DatabaseSync(path); this.holder = randomUUID();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, remaining TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, match_id TEXT, amount TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', raw TEXT, hash TEXT, request_id TEXT, error TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(id INTEGER PRIMARY KEY, holder TEXT NOT NULL, until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS control(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value=fn(); this.db.exec('COMMIT'); return value; } catch(error) { this.db.exec('ROLLBACK'); throw error; } }
  event(kind,detail) { this.db.prepare('INSERT INTO events(at,kind,detail) VALUES(?,?,?)').run(Date.now(),kind,JSON.stringify(detail)); }
  reserved() { return this.db.prepare('SELECT remaining FROM matches WHERE closed=0').all().reduce((sum,row)=>sum+BigInt(row.remaining),0n); }
  reserveMatch(id, budget, observedBalance, minimumReserve=0n, dayCapHeadroom=null) {
    const value=units(budget); if(value===0n || !/^[a-zA-Z0-9_-]{1,96}$/.test(id)) throw Error('Invalid match reservation');
    return this.tx(()=>{
      if(this.db.prepare('SELECT 1 FROM matches WHERE id=?').get(id)) throw Error('Match already reserved');
      if(this.reserved()+value+units(minimumReserve)>units(observedBalance)) throw Error('Insufficient unreserved funding');
      // Every open reservation may still be paid today, so all of them count against the contract's
      // remaining UTC-day headroom: a reservation the day cap cannot honor is refused, not promised.
      if(dayCapHeadroom!=null && this.reserved()+value>units(dayCapHeadroom)) throw Error('Daily spending cap reached; admission deferred to the next UTC day');
      this.db.prepare('INSERT INTO matches(id,remaining) VALUES(?,?)').run(id,value.toString());
      this.event('match_reserved',{id,amount:value.toString()});
    });
  }
  enqueue({id,match,amount,body}) {
    if(!/^0x[0-9a-f]{64}$/.test(id) || typeof body!=='string' || Buffer.byteLength(body)>16384 || !body.length) throw Error('Invalid request');
    const price=units(amount); if(price===0n) throw Error('Zero request price');
    return this.tx(()=>{
      const old=this.get(id);
      if(old) {
        if(old.match_id!==match || old.amount!==price.toString() || old.payload!==JSON.stringify({body})) throw Error('Decision key reused with different input');
        // A reverted payment wrote nothing on chain, but the design has no automatic paid retry:
        // the caller must learn the decision is unfunded instead of receiving the dead row as queued.
        if(old.state==='failed') throw Error('Decision payment failed; operator review required before any re-queue');
        return old;
      }
      const reservation=this.db.prepare('SELECT * FROM matches WHERE id=? AND closed=0').get(match);
      if(!reservation) throw Error('Match has no reservation');
      const allocated=this.db.prepare("SELECT amount FROM jobs WHERE match_id=? AND state NOT IN ('paid','failed')").all(match).reduce((sum,row)=>sum+BigInt(row.amount),0n);
      if(allocated+price>BigInt(reservation.remaining)) throw Error('Match budget exhausted');
      this.db.prepare('INSERT INTO jobs(id,kind,match_id,amount,payload,created) VALUES(?,?,?,?,?,?)').run(id,'request',match,price.toString(),JSON.stringify({body}),Date.now());
      this.event('request_queued',{id,match,amount:price.toString()}); return this.get(id);
    });
  }
  enqueueMaintenance(kind,amount) {
    if(!['harvest','treasury'].includes(kind)) throw Error('Invalid maintenance operation');
    const id=keccak256(toHex(randomUUID())); const value=units(amount); if(!value) throw Error('Empty operation');
    this.db.prepare('INSERT INTO jobs(id,kind,amount,payload,created) VALUES(?,?,?,?,?)').run(id,kind,value.toString(),'{}',Date.now());
    return this.get(id);
  }
  resizeUnsignedMaintenance(id,amount) {
    const value=units(amount);if(value===0n) throw Error('Empty operation');
    const result=this.db.prepare("UPDATE jobs SET amount=? WHERE id=? AND kind IN ('harvest','treasury') AND raw IS NULL AND state='queued'").run(value.toString(),id);
    if(result.changes!==1) throw Error('Only unsigned queued maintenance may be resized');
  }
  get(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  next() { return this.db.prepare("SELECT * FROM jobs WHERE state NOT IN ('paid','failed','blocked') ORDER BY CASE state WHEN 'submitted' THEN 0 WHEN 'prepared' THEN 1 WHEN 'preparing' THEN 2 ELSE 3 END, created, rowid LIMIT 1").get(); }
  blocked() { return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE state='blocked' LIMIT 1").get() || this.db.prepare("SELECT 1 FROM control WHERE key='halt'").get()); }
  halt(reason) { this.db.prepare("INSERT OR REPLACE INTO control VALUES('halt',?)").run(reason); this.event('halt',{reason}); }
  /** Records the UTC day on which the contract's daily cap deferred requests; true the first time that day. */
  noteDayCap(day,detail) {
    return this.tx(()=>{
      const row=this.db.prepare("SELECT value FROM control WHERE key='day_cap'").get(); if(row && Number(row.value)===day) return false;
      this.db.prepare("INSERT OR REPLACE INTO control VALUES('day_cap',?)").run(String(day)); this.event('day_cap',{day,...detail}); return true;
    });
  }
  checkpoint() { const row=this.db.prepare("SELECT value FROM control WHERE key='checkpoint'").get(); return row?JSON.parse(row.value):null; }
  maintenanceDue(now=Date.now()) { const row=this.db.prepare("SELECT max(created) AS last FROM jobs WHERE kind!='request'").get(); return !row.last || now-row.last>=60000; }
  patch(id,values) {
    const allowed=['state','raw','hash','request_id','error'];
    if(!Object.keys(values).every(key=>allowed.includes(key))) throw Error('Invalid update');
    this.db.prepare(`UPDATE jobs SET ${Object.keys(values).map(key=>key+'=?').join(',')} WHERE id=?`).run(...Object.values(values),id);
  }
  complete(id,requestId=null,checkpoint=null) {
    this.tx(()=>{const row=this.get(id); if(!row || row.state==='paid') return;
      if(row.kind==='request') {
        const match=this.db.prepare('SELECT * FROM matches WHERE id=? AND closed=0').get(row.match_id);
        if(!match || BigInt(match.remaining)<BigInt(row.amount)) throw Error('Reservation reconciliation failed');
        this.db.prepare('UPDATE matches SET remaining=? WHERE id=?').run((BigInt(match.remaining)-BigInt(row.amount)).toString(),row.match_id);
      }
      this.patch(id,{state:'paid',request_id:requestId,error:null}); this.event('operation_confirmed',{id,requestId});
      if(checkpoint) this.db.prepare("INSERT OR REPLACE INTO control VALUES('checkpoint',?)").run(JSON.stringify(checkpoint));
    });
  }
  closeMatch(id) {
    this.tx(()=>{
      if(this.db.prepare("SELECT 1 FROM jobs WHERE match_id=? AND state NOT IN ('paid','failed') LIMIT 1").get(id)) throw Error('Pending or ambiguous payments must be reconciled');
      this.db.prepare('UPDATE matches SET closed=1,remaining=? WHERE id=?').run('0',id); this.event('match_closed',{id});
    });
  }
  acquire(now=Date.now()) {
    return this.tx(()=>{const lease=this.db.prepare('SELECT * FROM leases WHERE id=1').get();
      if(lease && lease.until_ms>now) return false;
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES(1,?,?)').run(this.holder,now+120000); return true;
    });
  }
  release() { this.db.prepare('DELETE FROM leases WHERE id=1 AND holder=?').run(this.holder); }
  assertLease() { const row=this.db.prepare('SELECT * FROM leases WHERE id=1').get(); if(!row || row.holder!==this.holder || row.until_ms<=Date.now()) throw Error('Worker lease lost'); }
  summary() { return {reserved:this.reserved().toString(),jobs:this.db.prepare('SELECT kind,state,count(*) AS count FROM jobs GROUP BY kind,state').all()}; }
  close() { this.db.close(); }
}
