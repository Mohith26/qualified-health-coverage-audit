import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as lib from '../core/audit.mjs';
import { makePopulation, aggregate, drawAudit, SEED } from '../scripts/population.mjs';

const D = JSON.parse(readFileSync(new URL('../data/workflow.json', import.meta.url)));
const T = JSON.parse(readFileSync(new URL('../data/truth.json', import.meta.url)));
const E = lib.estimateCoverage(D, D.auditRows, 2000, 5);

test('beta sampler has the right mean', () => {
  const r = lib.mulberry32(1);
  let s = 0; for (let i = 0; i < 20000; i++) s += lib.beta(r, 2, 6);
  assert.ok(Math.abs(s / 20000 - 0.25) < 0.006);
});

test('Neyman allocation spends exactly the budget, respects caps, favors large uncertain strata', () => {
  const strata = [{ N: 1000 }, { N: 1000 }, { N: 30 }];
  const pilot = [{ n: 5, x: 0 }, { n: 5, x: 0 }, { n: 5, x: 0 }];
  const add = lib.neymanAllocate(strata, pilot, 115, [0.3, 0.01, 0.3]);
  assert.equal(add.reduce((a, b) => a + b, 0) + 15, 115);
  assert.ok(add[2] <= 25);
  assert.ok(add[0] > add[1] * 3);
});

test('beta calibration recovers a beta-mixture posterior curve', () => {
  // eligible ~ Beta(4,2), not ~ Beta(1,6), prevalence 10%: true P(e|s) has the beta-calibration form
  const r = lib.mulberry32(9);
  const rows = [];
  for (let i = 0; i < 20000; i++) { const e = r() < 0.1 ? 1 : 0; rows.push({ site: 0, score: e ? lib.beta(r, 4, 2) : lib.beta(r, 1, 6), n: 1, x: e }); }
  const m = lib.fitWorkingModel(rows, 1);
  const truth = (s) => { const f1 = 20 * s ** 3 * (1 - s), f0 = 6 * (1 - s) ** 5; return 0.1 * f1 / (0.1 * f1 + 0.9 * f0); };
  for (const s of [0.2, 0.4, 0.6, 0.8]) assert.ok(Math.abs(m.predict(0, s) - truth(s)) < 0.05, `s=${s} ${m.predict(0, s)} vs ${truth(s)}`);
});

test('difference estimator is unbiased under a deliberately wrong model', () => {
  const strata = [{ site: 0, band: 0, N: 2000 }];
  const data = { strata, bands: [{ lo: 0, hi: 0.1 }], unroutedHist: [Array(60).fill(0)] };
  data.unroutedHist[0][5] = 2000; // all at score 0.055
  const wrong = { predict: () => 0.5 }; // model says 50%, truth is 5%
  const r = lib.mulberry32(3);
  let tot = 0; const R = 400;
  for (let k = 0; k < R; k++) {
    const rows = []; for (let i = 0; i < 60; i++) rows.push({ h: 0, site: 0, score: 0.055, eligible: r() < 0.05 ? 1 : 0 });
    tot += lib.stratumEstimates(data, rows, wrong)[0].est + rows.reduce((a, x) => a + x.eligible, 0);
  }
  assert.ok(Math.abs(tot / R - 100) < 6, 'mean total eligible ' + tot / R);
});

test('estimate on the committed audit: interval covers the truth; site recalls close', () => {
  assert.ok(T.trueMissed >= E.missed.lo && T.trueMissed <= E.missed.hi);
  E.bySite.forEach((b, i) => assert.ok(Math.abs(b.recall.median - T.trueSiteRecall[i]) < 0.08));
});

test('threshold test: every added band passes its bound, stops at first failure, respects capacity', () => {
  const R = lib.recommendThreshold(D, E.counts, E.draws, 0.25, 1500);
  const firstFail = R.tests.findIndex((t) => !t.pass);
  assert.ok(firstFail === -1 || firstFail === R.tests.length - 1);
  R.tests.filter((t) => t.pass).forEach((t) => assert.ok(t.rate.lo >= 0.25));
  if (R.chosen) assert.ok(R.chosen.addReviews <= 1500);
  // true yield of each added band is above tau
  R.tests.filter((t) => t.pass).forEach((t) => {
    const idx = D.strata.map((s, h) => (s.band === t.band ? h : -1)).filter((h) => h >= 0);
    const N = idx.reduce((a, h) => a + D.strata[h].N - E.counts[h].n, 0);
    assert.ok(idx.reduce((a, h) => a + T.truthStrata[h] - E.counts[h].x, 0) / N >= 0.25);
  });
});

test('next-audit queue spends k charts on strata with remaining charts', () => {
  const q = lib.nextAudits(E.est, 25);
  assert.equal(q.reduce((a, b) => a + b, 0), 25);
  q.forEach((k, h) => assert.ok(E.est[h].n + k <= E.est[h].N));
});

test('committed data reproduce from the seeded generator', () => {
  const pts = makePopulation(SEED);
  const agg = aggregate(pts);
  assert.deepEqual(agg.sites.map((s) => s.confirmed), D.sites.map((s) => s.confirmed));
  const { sampled } = drawAudit(pts, agg, lib.mulberry32(D.audit.seed), D.audit.n0, D.audit.total, lib);
  assert.deepEqual(sampled.flat().sort((a, b) => a - b), D.auditRows.map((r) => r.id).sort((a, b) => a - b));
});
