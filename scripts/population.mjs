// Seeded synthetic population for a "Hepatitis C: untreated infection" finder workflow across 4 sites.
// Each patient: site, true eligibility (untreated chronic HCV), and the workflow's chart-review score in [0,1].
import { mulberry32, beta } from '../core/audit.mjs';

export const SEED = 20261110;
export const SITES = [
  { name: 'University Hospital', short: 'UH', n: 21400, prev: 0.064, elig: [5.2, 1.9], non: [1.1, 9.0] },
  { name: 'Northside Medical Center', short: 'NMC', n: 12600, prev: 0.058, elig: [4.6, 2.0], non: [1.2, 8.5] },
  { name: 'Bayside Community Hospital', short: 'BCH', n: 9800, prev: 0.071, elig: [4.0, 2.2], non: [1.2, 8.0] },
  // evidence often lives in scanned outside records: eligible patients score lower here
  { name: 'Rural Clinics Network', short: 'RCN', n: 8700, prev: 0.092, elig: [2.3, 2.6], non: [1.3, 7.5] },
];
export const THRESHOLD = 0.6;
export const BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].slice(0, -1).map((lo, i, a) => ({ lo, hi: +(lo + 0.1).toFixed(1) }));

export function makePopulation(seed = SEED) {
  const rng = mulberry32(seed);
  const pts = [];
  let id = 0;
  SITES.forEach((s, si) => {
    for (let i = 0; i < s.n; i++) {
      const e = rng() < s.prev ? 1 : 0;
      const [a, b] = e ? s.elig : s.non;
      const score = Math.min(0.999, beta(rng, a, b));
      pts.push({ id: id++, site: si, eligible: e, score });
    }
  });
  return pts;
}

export function bandOf(score) { return Math.min(BANDS.length - 1, Math.floor(score * 10)); }

// Aggregate what the platform knows (routed + clinician review outcomes) and build strata of unrouted patients.
export function aggregate(pts) {
  const sites = SITES.map((s) => ({ name: s.name, short: s.short, patients: 0, routed: 0, confirmed: 0 }));
  const strata = [];
  const sIndex = {};
  SITES.forEach((_, si) => BANDS.forEach((_, bi) => { sIndex[si + ':' + bi] = strata.length; strata.push({ site: si, band: bi, N: 0, ids: [] }); }));
  for (const p of pts) {
    const S = sites[p.site];
    S.patients++;
    if (p.score >= THRESHOLD) { S.routed++; S.confirmed += p.eligible; }
    else { const h = sIndex[p.site + ':' + bandOf(p.score)]; strata[h].N++; strata[h].ids.push(p.id); }
  }
  // what the platform already knows, binned: unrouted score histogram (0.01 bins below the threshold) and
  // clinician review outcomes of routed patients (0.02 bins above it)
  const unroutedHist = SITES.map(() => new Array(Math.round(THRESHOLD * 100)).fill(0));
  const routedBins = SITES.map(() => Array.from({ length: Math.round((1 - THRESHOLD) * 50) }, (_, k) => ({ score: +(THRESHOLD + (k + 0.5) * 0.02).toFixed(3), n: 0, x: 0 })));
  for (const p of pts) {
    if (p.score < THRESHOLD) unroutedHist[p.site][Math.min(unroutedHist[p.site].length - 1, Math.floor(p.score * 100))]++;
    else { const b = routedBins[p.site][Math.min(routedBins[p.site].length - 1, Math.floor((p.score - THRESHOLD) / 0.02))]; b.n++; b.x += p.eligible; }
  }
  return { sites, strata, sIndex, unroutedHist, routedBins };
}

// Two-phase audit draw: pilot n0 per stratum; then the rest by Neyman allocation using the working model's
// stratum-level eligible rate (fit on routed review outcomes + the pilot). Returns sampled ids per stratum.
export function drawAudit(pts, agg, rng, n0, total, lib) {
  const { strata } = agg;
  const pick = (ids, k, taken) => {
    const pool = ids.filter((i) => !taken.has(i));
    const out = [];
    for (let j = 0; j < k && pool.length; j++) {
      const r = Math.floor(rng() * pool.length);
      out.push(pool[r]); taken.add(pool[r]); pool[r] = pool[pool.length - 1]; pool.pop();
    }
    return out;
  };
  const taken = new Set();
  const sampled = strata.map((s) => pick(s.ids, Math.min(n0, s.N), taken));
  const rowsOf = (smp) => smp.flatMap((ids, h) => ids.map((i) => ({ h, site: pts[i].site, score: pts[i].score, eligible: pts[i].eligible })));
  const data = { sites: agg.sites, strata: strata.map(({ site, band, N }) => ({ site, band, N })), bands: BANDS, unroutedHist: agg.unroutedHist, routedBins: agg.routedBins };
  const model = lib.fitWorkingModel(lib.modelRows(data, rowsOf(sampled)), SITES.length);
  const est = lib.stratumEstimates(data, rowsOf(sampled), model);
  const pGuess = est.map((e) => (e.est + e.x) / e.N);
  const pilot = sampled.map((ids) => ({ n: ids.length, x: ids.reduce((a, i) => a + pts[i].eligible, 0) }));
  const add = lib.neymanAllocate(strata, pilot, total, pGuess);
  add.forEach((k, h) => { sampled[h] = sampled[h].concat(pick(strata[h].ids, k, taken)); });
  return { sampled, pilot, add, rowsOf };
}
