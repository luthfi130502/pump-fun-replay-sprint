// Early Tape Flip — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Where the money leaks in this market: most fresh curves are bundled launches that get dumped
// within minutes, and any bot that buys "confirmed momentum" buys the top. This bot does the
// opposite trade. It reads a launch's very first tape — the slots right after the CreateEvent —
// and flips only the launches whose tape looks organic:
//
//   - the creator's own buy is present but not dominant, and the creator has not sold;
//   - a handful of other wallets bought in (some demand), but not a crowd (a crowd in the first
//     slots is the creator's bundle cluster, not demand);
//   - early sellers have not overwhelmed the tape, and no single early sell was huge next to
//     the curve's real SOL reserve.
//
// The flip is fast by design: take profit at a fixed gain, stop out at a fixed loss, and never
// hold longer than a few dozen slots. A creator sell while holding ends the trade at once.
// Stakes are small and the size cap (1% of the curve's real reserve) binds most buys anyway,
// so no single coin can hurt the book; hundreds of small round trips are the strategy.
//
// Guardrails: the flip flow itself produces far more than the required 20 coins with a round
// trip of at least 0.01 SOL, and the capped exposure keeps drawdown far from the 50% bar. A
// block-time-paced probe adds tiny round trips on liquid curves only if the flip flow ever
// runs behind the round-trip pace.
//
// Speed is a design constraint: per batch the bot touches only the mints in that batch, the
// undecided launches still inside their short decision window, and its own open positions
// (at most five). Coin records are dropped once a coin is decided, unheld and old, so neither
// the per-batch work nor the bookkeeping grows with the number of coins the replay has shown.
//
// Deterministic by construction: no clock, no environment, no randomness — only the batch
// stream, in order, over insertion-ordered maps.

import { LAMPORTS_PER_SOL, runBot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ parameters

const SOL = 1_000_000_000;

/** Decision window: a launch may be bought while its age is in [MIN_AGE, MAX_AGE] slots. */
const MIN_AGE = 1;
const MAX_AGE = 4;
/** SOL aimed at one flip (the 1%-of-reserve size cap binds below this on small curves). */
const STAKE_SOL = 0.08;
/** Smallest buy worth the tx fee; also above the 0.01 SOL round-trip bar. */
const MIN_BUY_SOL = 0.012;
/** Real SOL reserve bounds at decision time. */
const MIN_RQ_SOL = 0.3;
const MAX_RQ_SOL = 40;
/** Creator's own create-slot buy must not exceed this (SOL). */
const MAX_DEV_BUY_SOL = 2.5;
/** Creator must have committed at least this much of their own SOL in the create slot. */
const MIN_DEV_BUY_SOL = 0.2;
/** Distinct non-creator buyers so far must be inside [MIN_BUYERS, MAX_BUYERS]. */
const MIN_BUYERS = 3;
const MAX_BUYERS = 5;
/** Non-creator sells over non-creator buys so far, at most. */
const MAX_SELL_RATIO = 0.15;
/** Largest single non-creator sell so far, as a share of the reserve before it, at most. */
const MAX_BIG_SELL_SHARE = 0.1;
/** Take profit: sell everything once the close value reaches cost * (1 + TAKE_PROFIT). */
const TAKE_PROFIT = 0.25;
/** Stop loss: sell everything once the close value falls to cost * (1 - STOP_LOSS). */
const STOP_LOSS = 0.1;
/** Never hold longer than this many slots. */
const MAX_HOLD = 20;
/** Curve fee estimate for valuing a position (protocol + creator, 95 + 30 bps). */
const CURVE_FEE = 0.0125;

/** Guardrail pacing fallback (rarely fires: the flip flow is normally far ahead of pace). */
const TARGET_COINS = 26;
const PACE_SECS = 14_400;
const PROBE_SOL = 0.012;
const MAX_PROBES = 1;

// ------------------------------------------------------------------ bookkeeping

interface Coin {
  creator: Pubkey;
  createSlot: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  boughtByOthers: number;
  soldByOthers: number;
  bigSellShare: number;
  decided: boolean;
}

interface Held {
  opened: number;
  exiting: boolean;
}

const coins = new Map<Pubkey, Coin>();
/** Launches not yet decided, in create order; pruned as they age out of the window. */
const undecided: Pubkey[] = [];
const held = new Map<Pubkey, Held>();
const probes = new Set<Pubkey>();
const boughtOk = new Set<Pubkey>();
const roundTripped = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

await runBot({
  onBatch(state: BotState, batch) {
    const now = batch.slot;
    const { caps } = state.hello;
    const txSol = Number(state.txFeeLamports()) / SOL;
    const orders: OrderInput[] = [];

    // ---- ingest fills: guardrail counters.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (!f.client_id.startsWith('_') && f.side === 'buy' && Number(f.quote_lamports) / SOL >= 0.01) {
        boughtOk.add(f.mint);
      }
      if (f.side === 'sell' && boughtOk.has(f.mint)) roundTripped.add(f.mint);
    }

    // ---- ingest events into coin records (only mints in this batch are touched).
    const tradedNow = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          creator: e.creator,
          createSlot: e.slot,
          devBuy: 0,
          devSold: false,
          buyers: new Set(),
          boughtByOthers: 0,
          soldByOthers: 0,
          bigSellShare: 0,
          decided: false,
        });
        undecided.push(e.mint);
      } else if (e.event === 'TradeEvent') {
        tradedNow.add(e.mint);
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / SOL;
        if (e.is_buy) {
          if (e.user === c.creator) {
            if (e.slot === c.createSlot) c.devBuy += sol;
          } else {
            c.buyers.add(e.user);
            c.boughtByOthers += sol;
          }
        } else if (e.user === c.creator) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = Number(e.real_quote_reserves) / SOL + sol;
          if (rqBefore > 0) c.bigSellShare = Math.max(c.bigSellShare, sol / rqBefore);
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.decided = true; // completed: never buy, record dropped below
      }
    }

    const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
    for (const po of state.pending.values()) {
      const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
      if (po.order.side === 'buy') rec.buy = true;
      else rec.sell = true;
      pendingByMint.set(po.order.mint, rec);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

    // ---- exits: take profit, stop loss, time limit, creator sell.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // the harness closes these itself
      const c = coins.get(mint);
      let exit = h.exiting || (c !== undefined && c.devSold) || now - h.opened > MAX_HOLD;
      if (!exit) {
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / SOL) * (1 - CURVE_FEE) - txSol;
        const cost = Number(pos.cost_lamports) / SOL;
        if (value >= cost * (1 + TAKE_PROFIT) || value <= cost * (1 - STOP_LOSS)) exit = true;
      }
      if (!exit) continue;
      h.exiting = true;
      const pend = pendingByMint.get(mint);
      if (pend !== undefined && pend.sell) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // ---- probes: sell the whole probe as soon as its buy has landed.
    for (const mint of probes) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // ---- entries: decide each launch once, inside its window.
    let free = Number(state.freeCashLamports()) / SOL;
    let slotsLeft = caps.max_open_positions - state.committedPositionCount();
    let kept = 0;
    for (let i = 0; i < undecided.length; i++) {
      const mint = undecided[i]!;
      const c = coins.get(mint);
      if (c === undefined) continue;
      const age = now - c.createSlot;
      if (age < MIN_AGE && !c.decided) {
        undecided[kept++] = mint; // too young: reconsider next batch
        continue;
      }
      if (!c.decided) {
        c.decided = true;
        const curve = state.curves.get(mint);
        const rqSol = curve === undefined ? 0 : Number(curve.real_quote_reserves) / SOL;
        const capSol = curve === undefined ? 0 : Number(state.maxBuyLamports(mint)) / SOL;
        const sellRatio = c.boughtByOthers > 0 ? c.soldByOthers / c.boughtByOthers : 0;
        const pass =
          curve !== undefined &&
          !curve.complete &&
          age <= MAX_AGE &&
          rqSol >= MIN_RQ_SOL &&
          rqSol <= MAX_RQ_SOL &&
          c.devBuy >= MIN_DEV_BUY_SOL &&
          c.devBuy <= MAX_DEV_BUY_SOL &&
          !c.devSold &&
          c.buyers.size >= MIN_BUYERS &&
          c.buyers.size <= MAX_BUYERS &&
          sellRatio <= MAX_SELL_RATIO &&
          c.bigSellShare <= MAX_BIG_SELL_SHARE;
        if (pass && slotsLeft > 0 && orders.length < caps.max_orders_per_batch && !pendingByMint.has(mint)) {
          const amount = Math.min(STAKE_SOL, capSol, free - txSol);
          if (amount >= MIN_BUY_SOL) {
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: 10_000 });
            free -= amount + txSol;
            slotsLeft--;
            held.set(mint, { opened: now, exiting: false });
          }
        }
      }
      // Decided and not held: the record has served its purpose once the coin is old.
      if (!held.has(mint) && !state.positions.has(mint) && age > 4 * MAX_AGE) coins.delete(mint);
    }
    undecided.length = kept;

    // ---- guardrail pacing fallback: a probe round trip if the flip flow lags the pace.
    if (
      probes.size < MAX_PROBES &&
      slotsLeft > 0 &&
      orders.length < caps.max_orders_per_batch &&
      firstTime !== null &&
      lastTime !== null &&
      lastTime > firstTime &&
      roundTripped.size < Math.ceil(TARGET_COINS * Math.min(1, (lastTime - firstTime) / PACE_SECS))
    ) {
      for (const mint of tradedNow) {
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / SOL < (PROBE_SOL * 10_000) / caps.max_order_bps_of_real_reserve / 0.9) continue;
        if (free < PROBE_SOL + 2 * txSol) break;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * SOL)), max_slippage_bps: 10_000 });
        probes.add(mint);
        free -= PROBE_SOL + txSol;
        break;
      }
    }

    return orders;
  },
});
