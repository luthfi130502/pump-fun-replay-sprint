# Early Tape Flip — Pump.fun Replay Sprint Paper Bot

[![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/luthfi130502/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/luthfi130502/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Entry for the make.fun bounty [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122): a paper-trading bot for the `agent-fun/replay/v2` pump.fun bonding-curve replay, starting from 10 SOL of paper money.

## Strategy

Most fresh pump.fun curves are bundled launches that get dumped within minutes, so the bot never chases momentum. Instead it reads a launch's very first tape — the slots right after its CreateEvent — and flips only the launches whose tape looks organic:

- the creator committed a meaningful amount of their own SOL in the create slot, but not a dominant amount, and has not sold;
- a small handful of other wallets bought in (some demand, but not a crowd — a crowd in the first slots is usually the creator's bundle cluster);
- early sellers are scarce next to the buyers, and no single early sell was large next to the curve's real SOL reserve.

The flip is fast: take profit at +25%, stop out at −10%, never hold more than 20 slots, and exit at once if the creator sells. Stakes are small and the harness's 1%-of-reserve size cap binds most buys anyway, so the book is hundreds of small round trips with tightly capped exposure — the run clears the guardrails (round trips of at least 0.01 SOL on at least 20 coins, max drawdown 50%) by a wide margin.

Per-batch work is bounded by design: the bot only ever looks at the mints in the current batch, the launches still inside their short decision window, and its own open positions, so it stays fast over a 24-hour replay no matter how many coins appear in total. It is fully deterministic — no clock, no environment, no randomness.

## Running it

The grader runs the bot as:

```sh
node main.ts
```

speaking the `agent-fun/replay/v2` protocol on stdin/stdout via the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`). Node 22 or later, no dependencies, no build step.

To grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```
