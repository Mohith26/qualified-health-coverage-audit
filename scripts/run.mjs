// Build the workflow snapshot the page reads (data/bundle.js) and run the validation study.
import { writeFileSync } from 'node:fs';
import * as lib from '../core/audit.mjs';
const { mulberry32, estimateCoverage, recommendThreshold, nextAudits, summarize } = lib;
import { SEED, SITES, THRESHOLD, BANDS, makePopulation, aggregate, drawAudit, bandOf } from './population.mjs';

export const AUDIT = { n0: 8, total: 600, seed: 42 };
export const POLICY = { tau: 0.25, capacity: 1500 };

const pts = makePopulation(SEED);
const agg = aggregate(pts);
const { sites, strata } = agg;

// ----- the audit that "happened" -----
const rng = mulberry32(AUDIT.seed);
const { sampled } = drawAudit(pts, agg, rng, AUDIT.n0, AUDIT.total, lib);
const auditRows = [];
sampled.forEach((ids, h) => ids.forEach((i, j) => auditRows.push({ id: i, h, site: pts[i].site, band: strata[h].band, score: +pts[i].score.toFixed(3), eligible: pts[i].eligible, phase: j < Math.min(AUDIT.n0, strata[h].N) ? 1 : 2 })));
const counts = strata.map((_, h) => ({ n: sampled[h].length, x: sampled[h].reduce((a, i) => a + pts[i].eligible, 0) }));

// histogram of scores per site, 50 bins, routed vs not (aggregate the platform already has)
const BINS = 50;
const hist = SITES.map(() => new Array(BINS).fill(0));
for (const p of pts) hist[p.site][Math.min(BINS - 1, Math.floor(p.score * BINS))]++;

// audit queue candidates: unaudited patients in each stratum (first 30 by a seeded shuffle) with scores
const sampledSet = new Set(auditRows.map((r) => r.id));
const qrng = mulberry32(7);
const queuePool = strata.map((s) => {
  const ids = s.ids.filter((i) => !sampledSet.has(i));
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(qrng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return ids.slice(0, 30).map((i) => ({ id: i, score: +pts[i].score.toFixed(3) }));
});

const workflow = {
  meta: { name: 'Hepatitis C: Untreated Infection Finder', seed: SEED, auditSeed: AUDIT.seed, quarter: 'Q4 2026', note: 'Synthetic data' },
  threshold: THRESHOLD, bands: BANDS, policy: POLICY, audit: AUDIT,
  sites, strata: strata.map(({ site, band, N }) => ({ site, band, N })), auditRows, hist, bins: BINS, queuePool, unroutedHist: agg.unroutedHist, routedBins: agg.routedBins,
};

// ----- truth (for validation only) -----
const truthStrata = strata.map((s) => s.ids.reduce((a, i) => a + pts[i].eligible, 0));
const unaudEligible = strata.map((s, h) => truthStrata[h] - counts[h].x);
const trueMissed = unaudEligible.reduce((a, b) => a + b, 0);
const foundRouted = sites.reduce((a, s) => a + s.confirmed, 0);
const auditFound = counts.reduce((a, c) => a + c.x, 0);
const trueRecall = foundRouted / (foundRouted + auditFound + trueMissed);
const trueSiteRecall = sites.map((s, si) => {
  const idx = strata.map((st, h) => (st.site === si ? h : -1)).filter((h) => h >= 0);
  const tot = idx.reduce((a, h) => a + truthStrata[h], 0);
  return s.confirmed / (s.confirmed + tot);
});
const trueBandRate = BANDS.map((b, bi) => {
  const idx = strata.map((st, h) => (st.band === bi ? h : -1)).filter((h) => h >= 0);
  const N = idx.reduce((a, h) => a + strata[h].N - counts[h].n, 0);
  return idx.reduce((a, h) => a + unaudEligible[h], 0) / N;
});

const est = estimateCoverage(workflow, auditRows, 4000, 5);
const rec = recommendThreshold(workflow, counts, est.draws, POLICY.tau, POLICY.capacity);
const trueGain = rec.chosen ? strata.reduce((a, s, h) => a + (BANDS[s.band].lo >= rec.chosen.threshold - 1e-9 ? unaudEligible[h] : 0), 0) : 0;

// ----- validation study: repeat the audit many times on the same population -----
function srsEstimate(r, total) {
  const pool = strata.flatMap((s) => s.ids);
  const taken = new Set();
  let x = 0;
  for (let j = 0; j < total; j++) {
    let i; do { i = pool[Math.floor(r() * pool.length)]; } while (taken.has(i));
    taken.add(i); x += pts[i].eligible;
  }
  return { est: (pool.length - total) * (x / total), x };
}
function propEstimate(r, total) {
  const Ntot = strata.reduce((a, s) => a + s.N, 0);
  let M = 0, xs = 0;
  strata.forEach((s) => {
    const n = Math.max(1, Math.round((total * s.N) / Ntot));
    const ids = s.ids.slice();
    let x = 0;
    for (let j = 0; j < n && ids.length; j++) { const k = Math.floor(r() * ids.length); x += pts[ids[k]].eligible; ids[k] = ids[ids.length - 1]; ids.pop(); }
    xs += x;
    M += (s.N - n) * (x / n);
  });
  return { est: M, x: xs };
}
const REPS = 300;
let covered = 0, ltFail = 0, ltChosen = 0;
const errN = [], errS = [], errP = [], widths = [];
for (let rep = 0; rep < REPS; rep++) {
  const r = mulberry32(1000 + rep);
  const { sampled: sm, rowsOf } = drawAudit(pts, agg, r, AUDIT.n0, AUDIT.total, lib);
  const c = strata.map((_, h) => ({ n: sm[h].length, x: sm[h].reduce((a, i) => a + pts[i].eligible, 0) }));
  const e = estimateCoverage(workflow, rowsOf(sm), 800, 100 + rep);
  const tm = strata.reduce((a, s, h) => a + truthStrata[h] - c[h].x, 0);
  if (tm >= e.missed.lo && tm <= e.missed.hi) covered++;
  widths.push(e.missed.hi - e.missed.lo);
  // point estimate errors on the same target (unaudited eligible), Neyman vs proportional vs SRS
  errN.push(e.est.reduce((a, x) => a + x.est, 0) - tm);
  const sr = srsEstimate(mulberry32(5000 + rep), AUDIT.total);
  errS.push(sr.est - (strata.reduce((a, s, h) => a + truthStrata[h], 0) - sr.x));
  const pr = propEstimate(mulberry32(9000 + rep), AUDIT.total);
  errP.push(pr.est - (strata.reduce((a, s, h) => a + truthStrata[h], 0) - pr.x));
  // threshold test error: chose a band whose true unaudited eligible rate is below tau
  const rr = recommendThreshold(workflow, c, e.draws, POLICY.tau, POLICY.capacity);
  if (rr.chosen) {
    ltChosen++;
    const bad = rr.tests.filter((t) => t.pass).some((t) => {
      const idx = strata.map((st, h) => (st.band === t.band ? h : -1)).filter((h) => h >= 0);
      const N = idx.reduce((a, h) => a + strata[h].N - c[h].n, 0);
      return idx.reduce((a, h) => a + truthStrata[h] - c[h].x, 0) / N < POLICY.tau;
    });
    if (bad) ltFail++;
  }
}
const rmse = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const validation = {
  reps: REPS, coverage90: covered / REPS, meanWidth: widths.reduce((a, b) => a + b, 0) / REPS,
  rmse: { neyman: rmse(errN), proportional: rmse(errP), srs: rmse(errS) },
  thresholdErrorRate: ltChosen ? ltFail / ltChosen : 0, thresholdChosenRuns: ltChosen,
};
const truth = { trueMissed, trueRecall, trueSiteRecall, trueBandRate, trueGain, truthStrata };

writeFileSync(new URL('../data/workflow.json', import.meta.url), JSON.stringify(workflow));
writeFileSync(new URL('../data/truth.json', import.meta.url), JSON.stringify(truth));
writeFileSync(new URL('../data/bundle.js', import.meta.url), '// generated by scripts/run.mjs\nwindow.QH = ' + JSON.stringify(workflow) + ';\nwindow.QHV = ' + JSON.stringify({ validation, truth: { trueMissed, trueRecall, trueSiteRecall, trueGain } }) + ';\n');

console.log('patients', pts.length, 'routed', sites.reduce((a, s) => a + s.routed, 0), 'confirmed', foundRouted, 'unrouted', strata.reduce((a, s) => a + s.N, 0));
console.log('audit n', auditRows.length, 'audit eligible', auditFound);
console.log('missed est', est.missed, 'true', trueMissed);
console.log('recall est', est.recall, 'true', trueRecall.toFixed(3));
console.log('site recall', est.bySite.map((b) => b.recall.median.toFixed(2)).join(' '), 'true', trueSiteRecall.map((x) => x.toFixed(2)).join(' '));
console.log('tests', rec.tests.map((t) => `${t.lo}-${t.hi} add ${t.add} rate ${t.rate.median.toFixed(3)} lo ${t.rate.lo.toFixed(3)} ${t.pass ? 'PASS' : 'FAIL'}`).join(' | '));
console.log('chosen', rec.chosen, 'true gain', trueGain, 'true band rates', trueBandRate.map((x) => x.toFixed(3)).join(' '));
console.log('validation', JSON.stringify(validation));
