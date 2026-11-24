# Pump Replay Breakout — Wait for Strength, Flip Fast

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hanafixampret/makefun-pump-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hanafixampret/makefun-pump-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Best net PnL wins.

## Strategy

Most pump.fun coins pump briefly, then bleed to zero — and the first minutes are a mirage: a coin can print 2x inside its create slot before any bot can fill. This bot waits for proof instead of chasing the open:

- **Wait for strength**: buy only the first time a coin's price reaches **3.0x–5.0x** its create price, within 2000 slots of creation, with ≥2 trades and real reserves ≥ 5 SOL. One 0.15 SOL tranche, one buy per coin.
- **Sell ALL at +30%** — the median breakout peaks ~1.34x entry and then collapses, so the bot banks the move instead of riding it down.
- **Stop-loss at −10%** — losers fall off a cliff (realised ~0.54x on a −25% stop), so the stop is tight.
- **Time stop**: a position still below entry after 120 slots is closed — drifters bleed to ~0.33x if held to the end.

At most 5 open positions, 0.02 SOL cash reserve, deterministic (no clock, no environment, no randomness), so both grading runs agree byte for byte.

## Run

`main.ts` runs on Node 22 as-is via the vendored SDK shim (`vendor/makefun-bot.ts`):

```sh
node main.ts
```

Grade locally against the dev window with the kit's CLI:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```
