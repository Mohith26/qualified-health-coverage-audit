// Coverage audit core: estimate how many eligible patients a population-finder workflow misses below its
// routing threshold, from a two-phase stratified (Neyman) audit of unrouted charts, and pick a lower threshold
// with a fixed-sequence test on each added score band. Pure ES module, no dependencies.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function normal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Marsaglia-Tsang gamma, then beta
export function gamma(rng, k) {
  if (k < 1) return gamma(rng, k + 1) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function beta(rng, a, b) { const x = gamma(rng, a), y = gamma(rng, b); return x / (x + y); }

export const quantile = (sorted, q) => {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// Strata: unrouted patients split by site x score band. s = {site, band, N (unrouted patients), ids?}
// audit rows: {stratum, eligible: 0/1}

// Two-phase Neyman allocation. pilot n0 per stratum, then the rest proportional to N_h * sqrt(p(1-p)),
// where p comes from the pilot (Jeffreys-smoothed). Returns n_h per stratum (phase-2 additions).
export function neymanAllocate(strata, pilot, total, pGuess) {
  const n0 = strata.map((s, h) => pilot[h].n);
  let left = total - n0.reduce((a, b) => a + b, 0);
  const w = strata.map((s, h) => {
    const p = pGuess ? Math.min(0.5, Math.max(1e-4, pGuess[h])) : (pilot[h].x + 0.5) / (pilot[h].n + 1);
    return s.N * Math.sqrt(p * (1 - p));
  });
  const add = new Array(strata.length).fill(0);
  // largest-remainder rounding with caps N_h - n0
  const cap = strata.map((s, h) => s.N - n0[h]);
  let active = strata.map((_, h) => cap[h] > 0);
  for (let iter = 0; iter < 10 && left > 0; iter++) {
    const W = w.reduce((a, x, h) => a + (active[h] ? x : 0), 0);
    if (W <= 0) break;
    const target = w.map((x, h) => (active[h] ? (left * x) / W : 0));
    let used = 0;
    const frac = [];
    for (let h = 0; h < strata.length; h++) {
      if (!active[h]) continue;
      const f = Math.min(cap[h] - add[h], Math.floor(target[h]));
      add[h] += f; used += f;
      frac.push([target[h] - Math.floor(target[h]), h]);
      if (add[h] >= cap[h]) active[h] = false;
    }
    left -= used;
    frac.sort((a, b) => b[0] - a[0]);
    for (const [, h] of frac) { if (left <= 0) break; if (add[h] < cap[h]) { add[h]++; left--; } }
    if (used === 0) break;
  }
  return add;
}

// ---------- working model: P(eligible | score, site) ----------
// Beta calibration (Kull et al. 2017): logit p = a + b*log(s) - c*log(1-s), per site, shrunk toward a shared
// fit (ridge). Fit by Newton on binomial rows {site, score, n, x} from routed review outcomes and the audit.
export const sig = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const feat = (score) => { const s = Math.min(0.995, Math.max(0.005, score)); return [1, Math.log(s), -Math.log(1 - s)]; };
export function fitWorkingModel(rows, nSites, lambda = 0.5) {
  const K = 3, P = K * (nSites + 1), base = K * nSites;
  const th = new Float64Array(P);
  for (let it = 0; it < 80; it++) {
    const g = new Float64Array(P);
    const H = Array.from({ length: P }, () => new Float64Array(P));
    for (const r of rows) {
      const f = feat(r.score);
      const cols = [];
      for (let k = 0; k < K; k++) { cols.push([base + k, f[k]]); cols.push([K * r.site + k, f[k]]); }
      let eta = 0; for (const [c, v] of cols) eta += th[c] * v;
      const p = sig(eta), w = r.n * p * (1 - p), res = r.x - r.n * p;
      for (const [c, v] of cols) { g[c] += res * v; for (const [c2, v2] of cols) H[c][c2] += w * v * v2; }
    }
    for (let j = 0; j < base; j++) { g[j] -= th[j] / lambda; H[j][j] += 1 / lambda; }
    for (let j = base; j < P; j++) { g[j] -= th[j] / 100; H[j][j] += 1 / 100; }
    const A = H.map((row, i) => [...row, g[i]]);
    for (let i = 0; i < P; i++) {
      let m = i; for (let k = i + 1; k < P; k++) if (Math.abs(A[k][i]) > Math.abs(A[m][i])) m = k;
      [A[i], A[m]] = [A[m], A[i]];
      for (let k = i + 1; k < P; k++) { const fct = A[k][i] / A[i][i]; for (let j = i; j <= P; j++) A[k][j] -= fct * A[i][j]; }
    }
    const d = new Float64Array(P);
    for (let i = P - 1; i >= 0; i--) { let v = A[i][P]; for (let j = i + 1; j < P; j++) v -= A[i][j] * d[j]; d[i] = v / A[i][i]; }
    let mx = 0; for (let j = 0; j < P; j++) { const step = Math.max(-2, Math.min(2, d[j])); th[j] += step; mx = Math.max(mx, Math.abs(step)); }
    if (mx < 1e-9) break;
  }
  const predict = (site, score) => { const f = feat(score); let z = 0; for (let k = 0; k < K; k++) z += (th[base + k] + th[K * site + k]) * f[k]; return sig(z); };
  return { theta: th, predict };
}

// Rows for the working model from what the platform knows: routed review outcomes (binned) + audited charts.
export function modelRows(data, auditRows) {
  const rows = [];
  data.routedBins.forEach((bins, site) => bins.forEach((b) => { if (b.n > 0) rows.push({ site, score: b.score, n: b.n, x: b.x }); }));
  for (const r of auditRows) rows.push({ site: r.site, score: r.score, n: 1, x: r.eligible });
  return rows;
}

// Model-assisted (difference) estimator of eligible patients among UNAUDITED unrouted charts, per stratum.
// M_h = sum_{unaudited in h} p(s) + (N_h - n_h) * mean_{audited in h}(y - p(s)); design-consistent even if the model
// is wrong; the model only reduces variance. Variance: (N_h-n_h)^2 (1-f_h) S_h^2 / n_h with S_h^2 floored at the
// model's own Bernoulli variance in the stratum (conservative when a stratum's sample has no positives).
export function stratumEstimates(data, auditRows, model) {
  const H = data.strata.length;
  const out = data.strata.map((s) => ({ N: s.N, n: 0, x: 0, sumPUnaud: 0, res: [], pbar: 0 }));
  // sum of p over all unrouted charts in the stratum, from the 0.01-wide score histogram
  data.unroutedHist.forEach((bins, site) => bins.forEach((cnt, k) => {
    if (!cnt) return;
    const score = (k + 0.5) / 100;
    const h = data.strata.findIndex((st) => st.site === site && st.band === Math.min(data.bands.length - 1, Math.floor(score * 10)));
    const p = model.predict(site, score);
    out[h].sumPUnaud += cnt * p; out[h].pbar += cnt * p * (1 - p);
  }));
  for (const r of auditRows) {
    const o = out[r.h];
    const p = model.predict(r.site, r.score);
    o.n++; o.x += r.eligible; o.sumPUnaud -= p; o.res.push(r.eligible - p);
  }
  return out.map((o) => {
    const rest = o.N - o.n;
    const mean = o.res.length ? o.res.reduce((a, b) => a + b, 0) / o.res.length : 0;
    const s2 = o.res.length > 1 ? o.res.reduce((a, b) => a + (b - mean) ** 2, 0) / (o.res.length - 1) : 0.25;
    const floor = o.pbar / Math.max(1, o.N);
    const S2 = Math.max(s2, floor);
    const est = Math.max(0, o.sumPUnaud + rest * mean);
    const v = o.n ? (rest * rest * (1 - o.n / o.N) * S2) / o.n : rest * rest * 0.25;
    return { N: o.N, n: o.n, x: o.x, est, sd: Math.sqrt(v), modelOnly: Math.max(0, o.sumPUnaud) };
  });
}

export function posteriorMissed(est, nDraws, seed) {
  const rng = mulberry32(seed);
  const draws = [];
  for (let d = 0; d < nDraws; d++) {
    const m = new Float64Array(est.length);
    for (let h = 0; h < est.length; h++) m[h] = Math.max(0, Math.min(est[h].N - est[h].n, est[h].est + est[h].sd * normal(rng)));
    draws.push(m);
  }
  return draws;
}

export function summarize(values) {
  const s = Float64Array.from(values).sort();
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, lo: quantile(s, 0.05), hi: quantile(s, 0.95), median: quantile(s, 0.5) };
}

// Full estimate: recall of the routing rule = confirmed routed / (confirmed routed + eligible found by audit + missed).
export function estimateCoverage(data, auditRows, nDraws = 4000, seed = 5) {
  const model = fitWorkingModel(modelRows(data, auditRows), data.sites.length);
  const est = stratumEstimates(data, auditRows, model);
  const draws = posteriorMissed(est, nDraws, seed);
  const counts = est.map((e) => ({ n: e.n, x: e.x }));
  const auditFound = counts.reduce((a, c) => a + c.x, 0);
  const foundRouted = data.sites.reduce((a, s) => a + s.confirmed, 0);
  const missedD = draws.map((m) => m.reduce((a, b) => a + b, 0));
  const recallD = missedD.map((m) => foundRouted / (foundRouted + auditFound + m));
  const bySite = data.sites.map((site, si) => {
    const idx = data.strata.map((s, h) => (s.site === si ? h : -1)).filter((h) => h >= 0);
    const af = idx.reduce((a, h) => a + counts[h].x, 0);
    const md = draws.map((m) => idx.reduce((a, h) => a + m[h], 0));
    return { site: si, missed: summarize(md), recall: summarize(md.map((m) => site.confirmed / (site.confirmed + af + m))), auditFound: af };
  });
  return { model, est, counts, draws, foundRouted, auditFound, found: foundRouted + auditFound, missed: summarize(missedD), recall: summarize(recallD), bySite };
}

// Fixed-sequence threshold test. Bands are tested from just below the current threshold downward.
// A band passes if the posterior 5th percentile of its eligible rate (pooled over sites, weighted by N) is >= tau
// and cumulative added reviews stay within capacity. Stops at the first failure (fixed-sequence).
export function recommendThreshold(data, counts, draws, tau, capacity) {
  // counts[h] = {n, x}; draws from posteriorMissed
  const bands = data.bands; // [{lo, hi}] ascending; current threshold = data.threshold
  const order = bands.map((b, i) => i).filter((i) => bands[i].hi <= data.threshold + 1e-9).sort((a, b) => bands[b].lo - bands[a].lo);
  let cumAdd = 0, chosen = null;
  const tests = [];
  const cumGainDraws = new Float64Array(draws.length);
  for (const bi of order) {
    const idx = data.strata.map((s, h) => (s.band === bi ? h : -1)).filter((h) => h >= 0);
    const Nb = idx.reduce((a, h) => a + data.strata[h].N - counts[h].n, 0); // unaudited charts to add
    const rateD = draws.map((m) => idx.reduce((a, h) => a + m[h], 0) / Math.max(1, Nb));
    const r = summarize(rateD);
    const passRate = r.lo >= tau;
    const passCap = cumAdd + Nb <= capacity;
    tests.push({ band: bi, lo: bands[bi].lo, hi: bands[bi].hi, add: Nb, rate: r, passRate, passCap, pass: passRate && passCap });
    if (!(passRate && passCap)) break;
    cumAdd += Nb;
    for (let d = 0; d < draws.length; d++) cumGainDraws[d] += idx.reduce((a, h) => a + draws[d][h], 0);
    chosen = { threshold: bands[bi].lo, addReviews: cumAdd, gain: summarize(cumGainDraws) };
  }
  return { tests, chosen, tau, capacity };
}

// Which charts to audit next: greedy reduction of the variance of the missed-count estimate.
// Var_h ~ (N_h - n_h)^2 S_h^2 / n_h with S_h^2 ~ p(1-p), p from the stratum estimate; one more chart in h
// reduces it by about (N_h-n_h)^2 S_h^2 (1/n - 1/(n+1)).
export function nextAudits(est, k) {
  const out = new Array(est.length).fill(0);
  for (let i = 0; i < k; i++) {
    let best = -1, bg = -1;
    for (let h = 0; h < est.length; h++) {
      const nn = est[h].n + out[h], rest = est[h].N - nn;
      if (rest <= 0) continue;
      const p = Math.min(0.5, Math.max(1e-4, (est[h].est + 0.5) / (est[h].N - est[h].n + 1)));
      const g = rest * rest * p * (1 - p) * (1 / Math.max(nn, 1) - 1 / (nn + 1));
      if (g > bg) { bg = g; best = h; }
    }
    if (best < 0) break;
    out[best]++;
  }
  return out;
}

// Standard error of the missed total under stratified sampling (for design comparisons)
export function stratifiedSE(strata, counts) {
  let v = 0;
  strata.forEach((s, h) => {
    const { n, x } = counts[h];
    if (n === 0) return;
    const p = x / n, rest = s.N - n;
    v += (rest * rest * p * (1 - p)) / n * (1 - n / s.N);
  });
  return Math.sqrt(v);
}
