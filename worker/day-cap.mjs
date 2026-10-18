// CabalFundingHook.payRequest enforces `spentToday + amount <= dailyLimit`, where the day is
// block.timestamp / 1 days and spentToday resets on the first payment of a new UTC day.
// Admission and the engine use the same arithmetic so no reservation promises a payment the
// contract cannot honor today, and a capped request waits instead of being re-prepared every tick.
export const DAY_MS = 86400000;
/** The worker keeps counting the chain's recorded day as current for this long after UTC midnight. */
export const CLOCK_SKEW_MS = 300000;
export const utcDay = (nowMs = Date.now()) => Math.floor(nowMs / DAY_MS);
export const nextUtcDayStart = (nowMs = Date.now()) => new Date((utcDay(nowMs) + 1) * DAY_MS).toISOString();
/** IMD the contract can still spend on requests during the current UTC day. */
export function dayCapHeadroom(balances, nowMs = Date.now()) {
  for (const key of ['dailyLimit', 'spentDay', 'spentToday']) if (balances?.[key] == null) throw Error('Daily cap state unavailable');
  const limit = BigInt(balances.dailyLimit), spentDay = BigInt(balances.spentDay), spent = BigInt(balances.spentToday);
  // Never count less than the chain reports: a worker clock slightly ahead of the chain must not
  // admit a duel the contract still caps until its own clock crosses midnight.
  const effective = spentDay >= BigInt(utcDay(nowMs - CLOCK_SKEW_MS)) ? spent : 0n;
  return effective >= limit ? 0n : limit - effective;
}
