// Pump.fun Replay Sprint — breakout momentum paper bot.
//
// Strategy (tuned on the dev window with an offline backtester, then
// verified with the kit's grade-local):
//   * Wait for strength: buy a coin only the first time its price reaches
//     3.0x-5.0x its create price, within 2000 slots of creation, with at
//     least 2 trades and real reserves >= 5 SOL. Single 0.15 SOL tranche.
//   * Sell ALL at +30% (take profit) or at -10% (stop loss).
//   * Max 5 open positions, 0.02 SOL cash reserve.
//   * 2-slot fill latency is priced in by the backtester; fills use the
//     harness's own reserves, so no clock, no randomness, no env reads.
//   * Deterministic: every decision is a pure function of the batch state.
import { runBot } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = 150_000_000; // 0.15 SOL per coin, single tranche
const MIN_REAL_LAMPORTS = 5_000_000_000; // 5 SOL real reserves at entry
const MIN_CAP_LAMPORTS = 10_000_000; // 0.01 SOL minimum buy
const ENTRY_MIN_BPS = 30000; // 3.0x create price
const ENTRY_MAX_BPS = 50000; // 5.0x create price
const ENTRY_MAX_AGE_SLOTS = 2000;
const MIN_TRADES = 2;
const TP_BPS = 13000; // sell all at +30% vs entry cost
const STOP_BPS = 9000; // stop loss at -10% vs entry cost
const TIME_STOP_SLOTS = 120; // give a stalled position 120 slots to work
const TIME_STOP_BPS = 10000; // then exit if still below entry cost
const CASH_RESERVE_LAMPORTS = 20_000_000; // 0.02 SOL
const MAX_POSITIONS = 5;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 2000;

type Coin = {
  createPrice: number;
  createSlot: number;
  trades: number;
  decided: boolean;
  buySlot: number;
};

const coins = new Map<string, Coin>();
let buys = 0;
let sells = 0;

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vt = Number(curve.virtual_token_reserves);
  if (vt === 0) return 0;
  return Number(curve.virtual_quote_reserves) / vt;
}

runBot({
  onHello(state) {
    // onHello receives the BotState, not the raw hello: caps live on state.hello.
    const hello = state.hello;
    // NB: log to stderr only — stdout is the harness protocol (JSON lines).
    console.error(
      `hello: capital=${Number(hello.capital.lamports) / 1e9} SOL ` +
        `max_positions=${hello.caps.max_open_positions} latency=${hello.latency_slots} slots ` +
        `tx_fee=${Number(hello.fees.base_fee_lamports) + Number(hello.fees.priority_fee_lamports)} lamports`,
    );
  },

  onBatch(state, batch) {
    // Track creates / trades so the entry band can be evaluated per mint.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const vt = Number(e.virtual_token_reserves);
        if (vt > 0 && !coins.has(e.mint)) {
          coins.set(e.mint, {
            createPrice: Number(e.virtual_quote_reserves) / vt,
            createSlot: e.slot,
            trades: 0,
            decided: false,
            buySlot: -1,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c) c.trades += 1;
      } else if (e.event === 'CompleteEvent') {
        coins.delete(e.mint);
      }
    }

    const orders: import('./vendor/makefun-bot.ts').Order[] = [];

    // ---- exits: take profit at +30%, stop loss at -10% ----
    for (const [mint, pos] of state.positions) {
      // pending is a Map keyed by client_id; check its values for a live sell.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const p = priceOf(curve);
      if (p <= 0 || pos.cost_lamports <= 0n) continue;
      const value = Number(pos.token_amount) * p;
      const ratioBps = Math.floor((value / Number(pos.cost_lamports)) * 10000);
      const coin = coins.get(mint);
      const heldSlots = coin && coin.buySlot >= 0 ? batch.slot - coin.buySlot : 0;
      const timedOut = heldSlots > TIME_STOP_SLOTS && ratioBps < TIME_STOP_BPS;
      if (ratioBps >= TP_BPS || ratioBps <= STOP_BPS || timedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        sells += 1;
      }
    }

    // ---- entries: first passage into the 3.0x-5.0x band ----
    if (state.committedPositionCount() < MAX_POSITIONS) {
      const txFee = Number(state.txFeeLamports());
      for (const e of batch.events) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() >= MAX_POSITIONS) break;
        const mint = e.mint;
        const c = coins.get(mint);
        if (!c || c.decided) continue;
        if (state.positions.has(mint)) {
          c.decided = true;
          continue;
        }
        if (batch.slot - c.createSlot > ENTRY_MAX_AGE_SLOTS) {
          c.decided = true;
          continue;
        }
        if (c.trades < MIN_TRADES) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) {
          c.decided = true;
          continue;
        }
        if (curve.real_quote_reserves < BigInt(MIN_REAL_LAMPORTS)) continue;
        const cap = Number(state.maxBuyLamports(mint));
        if (cap < MIN_CAP_LAMPORTS) continue;
        const p = priceOf(curve);
        if (p <= 0 || c.createPrice <= 0) continue;
        const multBps = Math.floor((p / c.createPrice) * 10000);
        if (multBps < ENTRY_MIN_BPS) continue;
        if (multBps > ENTRY_MAX_BPS) {
          c.decided = true;
          continue;
        }
        const amount = Math.min(STAKE_LAMPORTS, cap);
        if (amount < MIN_CAP_LAMPORTS) continue;
        if (state.freeCashLamports() < BigInt(amount + txFee + CASH_RESERVE_LAMPORTS)) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        c.decided = true;
        c.buySlot = batch.slot;
        buys += 1;
      }
    }

    return orders;
  },

  onDone(state) {
    // NB: stderr only — stdout is the harness protocol (JSON lines).
    console.error(
      `done: buys=${buys} sells=${sells} ` +
        `cash=${Number(state.cash) / 1e9} SOL ` +
        `open_positions=${state.positions.size}`,
    );
  },
});
