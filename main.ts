// Forecast GTA VI's launch-day Twitch viewers, hour by hour.
//
// Method (fit fresh from each case's own data, no hard-coded curve):
// every comparable launch in the case carries its full release-day hourly
// curve. For each forecast hour h = 2..24 we model the log ratio
// log(viewers_h / viewers_1) across comparable launches, then anchor the
// forecast on this case's own hour-1 print. Two facts from the comparables
// drive the fit:
//   1. Launches whose hour 1 is still pre-unlock (tiny hour-1 print, huge
//      later ratios) are a different family: they are dropped from the fit
//      whenever this case's hour 1 is a real launch hour (>= 10,000).
//   2. Bigger launches have flatter curves: the log ratio falls with
//      log(hour-1 print), so per hour we run an OLS regression of the log
//      ratio on log(hour-1 print), with the slope shrunk 30% toward zero
//      (the slope is estimated from ~28 launches and would otherwise
//      overfit), and the case's log hour-1 capped at log(400,000) so a
//      record-breaking launch does not extrapolate the slope past the data.
// The spread is the residual standard deviation of that regression
// (floored at 0.30, capped at 1.20 in log space), turned into the five
// quantiles with standard-normal z-scores. When hour 1 is tiny (< 10,000)
// the unlock may not have happened yet, so we fall back to plain empirical
// quantiles over all usable comparables. Everything is deterministic:
// no randomness, no network, no clock, stdlib only.
//
// GTA VI unlocks at local midnight, rolling (NZ 11:00Z 18 Nov, CET 23:00Z,
// UK 00:00Z, US East 05:00Z, US West 08:00Z), so hour 1 already holds the
// UK / European / Asia-Pacific audience and the US surge lands in hours
// 5-9; the comparable curves are all rolling-midnight console launches,
// so that shape is learned from the data, not assumed here.

import * as fs from "node:fs";
import * as path from "node:path";

// Standard-normal quantiles at the five scored levels.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

// A launch counts as "already unlocked in hour 1" when its hour-1 print
// reaches this many viewers; below it the ratios are dominated by
// pre-unlock noise and the launch is a different family.
const BIG_HOUR1 = 10000;
// Minimum launches in the filtered fit before we trust it; fewer and we
// fall back to every usable comparable.
const MIN_TRAIN = 8;
// Shrinkage applied to the per-hour regression slope (1 = full OLS).
const SLOPE_SHRINK = 0.7;
// Do not extrapolate the slope past a launch of this size.
const LOG_H1_CAP = Math.log(400000);
// Log-space spread bounds for the residual standard deviation.
const SD_FLOOR = 0.3;
const SD_CAP = 1.2;

// ---- Types: only the fields this program reads. ----

type HourlyRow = {
  from: string;
  viewers: number;
  channels?: number | null;
};

type Comparable = {
  name: string;
  day_start: string;
  hourly: HourlyRow[];
};

type CaseFile = {
  id: string;
  known?: Array<{ hour: number; viewers: number }>;
  comparables?: Comparable[];
};

// A usable launch: its 24 release-day hourly viewer counts, hours 1..24.
type LaunchCurve = number[];

// ---- Small deterministic helpers. ----

function pstdev(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return Math.sqrt(Math.max(variance, 0));
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

// Linear-interpolation quantile of an already sorted array.
function quantileSorted(sorted: number[], tau: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = tau * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

// ---- Reading the comparables. ----

// Pull a comparable's 24 release-day hourly viewer counts (hours 1..24),
// or null when any of them is missing or not positive. The GTA VI
// category's own pre-release history has no release-day hours, so it is
// skipped here by the same rule, as is any sparse launch.
function releaseDayCurve(comp: Comparable): LaunchCurve | null {
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const hours: Array<number | null> = new Array(24).fill(null);
  for (const row of comp.hourly ?? []) {
    const t = Date.parse(row.from);
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((t - start) / 3600000);
    if (idx < 0 || idx >= 24) continue;
    if (typeof row.viewers === "number" && Number.isFinite(row.viewers) && row.viewers > 0) {
      hours[idx] = row.viewers;
    }
  }
  for (const v of hours) {
    if (v === null) return null;
  }
  return hours as number[];
}

function usableCurves(caseFile: CaseFile): LaunchCurve[] {
  const out: LaunchCurve[] = [];
  for (const comp of caseFile.comparables ?? []) {
    const curve = releaseDayCurve(comp);
    if (curve !== null) out.push(curve);
  }
  return out;
}

// ---- The fit: per-hour log-ratio regression. ----

// For one forecast hour, regress log(viewers_h / viewers_1) on
// log(viewers_1) across the training launches, shrink the slope, and
// return the five log-quantiles of the ratio at this case's hour-1 print.
// The centre is the fitted value at the (capped) case log hour-1; the
// spread is the residual standard deviation, bounded to stay honest
// when the training set is small or unusually tight.
function fitHourLogQuantiles(
  train: LaunchCurve[],
  hourIndex: number, // 1-based hour within the 24-hour curve, e.g. 2..24
  logH1: number,
): number[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const curve of train) {
    xs.push(Math.log(curve[0]));
    ys.push(Math.log(curve[hourIndex - 1] / curve[0]));
  }
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - meanX) * (xs[i] - meanX);
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  const slope = (sxx > 0 ? sxy / sxx : 0) * SLOPE_SHRINK;
  const centre = meanY + slope * (logH1 - meanX);
  const residuals = ys.map((y, i) => y - (meanY + slope * (xs[i] - meanX)));
  const sd = clamp(pstdev(residuals), SD_FLOOR, SD_CAP);
  return Z.map((z) => centre + z * sd);
}

// Plain empirical quantiles of the log ratio at one hour, used when hour 1
// is tiny: the unlock may not have happened yet, so the wide family of
// every usable launch (including pre-unlock hour-1 prints) is the honest
// reference, and no size regression is attempted on it.
function empiricalHourLogQuantiles(train: LaunchCurve[], hourIndex: number): number[] {
  const ratios = train
    .map((curve) => Math.log(curve[hourIndex - 1] / curve[0]))
    .sort((a, b) => a - b);
  return LEVELS.map((tau) => quantileSorted(ratios, tau));
}

// Choose the training family from this case's own hour-1 print: a real
// launch hour uses only launches whose hour 1 was also a real launch
// hour, unless that leaves too few to fit.
function trainingFamily(curves: LaunchCurve[], hour1: number): LaunchCurve[] {
  if (hour1 < BIG_HOUR1) return curves;
  const big = curves.filter((curve) => curve[0] >= BIG_HOUR1);
  return big.length >= MIN_TRAIN ? big : curves;
}

// ---- Building the forecast. ----

// Turn per-hour log-quantiles of the ratio into the output rows: anchor on
// the hour-1 print, round to cents, clamp to the allowed range, and keep
// each row non-decreasing (rounding can only tie neighbours, never invert
// them, but the guard makes the contract hold by construction).
function rowsFromLogQuantiles(hour1: number, logQuantiles: Map<number, number[]>): Array<{ hour: number; q: number[] }> {
  const rows: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) {
    const lq = logQuantiles.get(h) ?? [0, 0, 0, 0, 0];
    const q = lq.map((v) => {
      const raw = hour1 * Math.exp(v);
      const rounded = Math.round(raw * 100) / 100;
      return clamp(rounded, 0.01, 1000000000);
    });
    for (let i = 1; i < q.length; i++) {
      if (q[i] < q[i - 1]) q[i] = q[i - 1];
    }
    rows.push({ hour: h, q });
  }
  return rows;
}

// Last-resort forecast when a case carries no usable comparables at all:
// flat at the hour-1 print with a spread that widens over the day. This
// is the persistence shape the contest's own baseline uses, kept here only
// so a malformed case still yields a valid file instead of a crash.
function fallbackRows(hour1: number): Array<{ hour: number; q: number[] }> {
  const logQuantiles = new Map<number, number[]>();
  for (let h = 2; h <= 24; h++) {
    const spread = 0.15 * Math.sqrt(h - 1);
    logQuantiles.set(h, Z.map((z) => z * spread));
  }
  return rowsFromLogQuantiles(hour1, logQuantiles);
}

function forecastCase(caseFile: CaseFile): Array<{ hour: number; q: number[] }> {
  const known = caseFile.known ?? [];
  const first = known.find((row) => row.hour === 1) ?? known[0];
  const hour1 = first && Number.isFinite(first.viewers) && first.viewers > 0 ? first.viewers : 1;
  const curves = usableCurves(caseFile);
  if (curves.length === 0) return fallbackRows(hour1);
  const train = trainingFamily(curves, hour1);
  const logQuantiles = new Map<number, number[]>();
  if (hour1 < BIG_HOUR1) {
    for (let h = 2; h <= 24; h++) {
      logQuantiles.set(h, empiricalHourLogQuantiles(train, h));
    }
  } else {
    const logH1 = Math.min(Math.log(hour1), LOG_H1_CAP);
    for (let h = 2; h <= 24; h++) {
      logQuantiles.set(h, fitHourLogQuantiles(train, h, logH1));
    }
  }
  return rowsFromLogQuantiles(hour1, logQuantiles);
}

// ---- Entry point: one output file per input case. ----

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((name) => name.endsWith(".in"))
    .sort();
  for (const name of files) {
    const caseId = name.slice(0, -".in".length);
    const outPath = path.join(outputDir, `${caseId}.out`);
    // Read the hour-1 print first, so even a later failure still leaves a
    // fallback anchored on the real first hour instead of on 1 viewer.
    let hour1 = 1;
    let parsed: CaseFile | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(inputDir, name), "utf8")) as CaseFile;
      const first = (parsed.known ?? []).find((row) => row.hour === 1) ?? (parsed.known ?? [])[0];
      if (first && Number.isFinite(first.viewers) && first.viewers > 0) hour1 = first.viewers;
    } catch {
      parsed = null;
    }
    try {
      if (parsed === null) throw new Error("unreadable case");
      const hours = forecastCase(parsed);
      fs.writeFileSync(outPath, JSON.stringify({ hours }), "utf8");
    } catch {
      // Never leave a case without an output: a flat forecast at the
      // hour-1 print is valid, where a missing file would score as an
      // invalid case.
      fs.writeFileSync(outPath, JSON.stringify({ hours: fallbackRows(hour1) }), "utf8");
    }
  }
}

main();
