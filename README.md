# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/rizkyptrp/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/rizkyptrp/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts GTA VI's launch-day Twitch concurrent viewers hour by hour (hours 2–24 of 2026-11-19 UTC) as five quantiles per hour, fit fresh from each case's own comparable launches.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=67v2e6cq&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>

## Method

The forecast is fit fresh from each case's own comparables — 42 past big
launches' hourly curves (38 in a practice case). For each hour h, the
program models `log(viewers_h / viewers_1)` across comparable launches:

- Launches whose hour 1 is still pre-unlock (tiny hour-1 print, huge later
  ratios) are a different family and are dropped from the fit whenever
  this case's hour 1 is a real launch hour (≥ 10,000 viewers).
- Bigger launches have flatter curves, so per hour an OLS regression of
  the log ratio on `log(hour-1 print)` is fit, with the slope shrunk 30%
  toward zero and the case's log hour-1 capped at `log(400,000)` so a
  record-breaking launch never extrapolates the slope past the data.
- The spread is the regression's residual standard deviation (floored at
  0.30, capped at 1.20 in log space), turned into quantiles with
  standard-normal z-scores.
- If hour 1 is tiny (< 10,000), the unlock may not have happened yet, so
  the program falls back to plain empirical quantiles over all usable
  comparables; with no usable comparables at all it falls back to a flat
  persistence forecast, so a case never comes out invalid.

The rolling-midnight unlock (NZ 11:00Z 18 Nov, CET 23:00Z, UK 00:00Z, US
East 05:00Z, US West 08:00Z) is learned from the comparable curves, not
assumed: the fitted median ratio dips in hours 3–4, then rises through
the US unlocks to a peak in the late UTC evening.

## Local validation

- Practice cases p00–p03: all outputs valid (23 rows, hours 2–24, five
  finite non-decreasing quantiles in (0, 1e9]), byte-identical across two
  runs, ~0.3 s for all four cases (limit 8 s per case).
- Leave-one-out proxy over the 37 usable comparable launches
  (held-out hour-1 ≥ 20,000, same scoring as the contest): mean pinball
  loss **0.2525** vs **0.3214** for the persistence baseline on the same
  launches (house baseline ≈ 0.387 on the practice cases).
