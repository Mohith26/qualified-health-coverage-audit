import { estimateCoverage, recommendThreshold, nextAudits, summarize } from './core/audit.mjs';

const D = window.QH, V = window.QHV;
const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x, d = 0) => fmt(100 * x, d) + '%';
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const tip = $('tip');
const showTip = (e, html) => { tip.innerHTML = html; tip.style.opacity = 1; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; };
const hideTip = () => { tip.style.opacity = 0; };
const bandLabel = (b) => `${D.bands[b].lo.toFixed(2)}–${D.bands[b].hi.toFixed(2)}`;
const mrn = (id) => 'MRN ' + String((id * 7919 + 104729) % 9000000 + 1000000).replace(/(\d{3})(\d{4})/, '$1-$2');

// ---------- estimate (recomputed in the browser from the committed audit rows) ----------
const t0 = performance.now();
const E = estimateCoverage(D, D.auditRows, 4000, 5);
const ms = performance.now() - t0;
const nUnrouted = D.strata.reduce((a, s) => a + s.N, 0);
const nRouted = D.sites.reduce((a, s) => a + s.routed, 0);
const nPatients = D.sites.reduce((a, s) => a + s.patients, 0);
const perStratum = D.strata.map((s, h) => summarize(E.draws.map((m) => m[h])));
let policy = { ...D.policy };

function header() {
  $('m-sites').textContent = `${D.sites.length} sites`;
  $('m-pop').textContent = `${fmt(nPatients)} patients screened`;
  $('m-thr').textContent = D.threshold.toFixed(2);
  $('h-missed').textContent = fmt(E.missed.median);
  $('h-ci').textContent = `90% interval ${fmt(E.missed.lo)}–${fmt(E.missed.hi)}`;
  const missedTop = E.draws.map((m) => D.strata.reduce((a, s, h) => a + (D.bands[s.band].lo >= 0.4 ? m[h] : 0), 0) / m.reduce((a, b) => a + b, 0));
  const worst = E.bySite.slice().sort((a, b) => a.recall.median - b.recall.median)[0];
  const siteShare = E.draws.map((m, d) => D.strata.reduce((a, s, h) => a + (s.site === worst.site ? m[h] : 0), 0) / m.reduce((a, b) => a + b, 0));
  $('h-lead').innerHTML = `From a ${fmt(D.auditRows.length)}-chart audit of the ${fmt(nUnrouted)} patients scored under ${D.threshold.toFixed(2)}, the workflow routes an estimated <b>${pct(E.recall.median)} of eligible patients</b> (${pct(E.recall.lo)}–${pct(E.recall.hi)}). ` +
    `${pct(summarize(missedTop).median)} of the rest score 0.40–0.60, and ${pct(summarize(siteShare).median)} are at ${D.sites[worst.site].name}.`;
  // donut
  const svg = $('donut'); svg.innerHTML = '';
  const parts = [
    { v: E.foundRouted, c: '#058be8', l: 'Routed and confirmed' },
    { v: E.auditFound, c: '#38bdf8', l: 'Found by audit' },
    { v: E.missed.median, c: '#0a3d63', l: 'Estimated missed' },
  ];
  const tot = parts.reduce((a, p) => a + p.v, 0);
  let a0 = -Math.PI / 2;
  const R = 92, r = 62, cx = 110, cy = 110;
  parts.forEach((p) => {
    const a1 = a0 + (2 * Math.PI * p.v) / tot;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const P = (ang, rad) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
    const path = el('path', { d: `M${P(a0, R)} A${R},${R} 0 ${large} 1 ${P(a1, R)} L${P(a1, r)} A${r},${r} 0 ${large} 0 ${P(a0, r)} Z`, fill: p.c }, svg);
    path.addEventListener('mousemove', (e) => showTip(e, `${p.l}: ${fmt(p.v)}`)); path.addEventListener('mouseleave', hideTip);
    a0 = a1;
  });
  el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 700, fill: '#0a3d63' }, svg).textContent = pct(E.recall.median);
  el('text', { x: cx, y: cy + 20, 'text-anchor': 'middle', 'font-size': 12, fill: '#64748b' }, svg).textContent = 'recall';
  $('donut-legend').innerHTML = parts.map((p) => `<span><i style="background:${p.c}"></i>${p.l}</span>`).join('');
  // stats
  const conf = E.foundRouted;
  $('stats').innerHTML = [
    { k: '<i data-lucide="route"></i>Routed and confirmed', v: `${fmt(conf)} <small>/ ${fmt(nRouted)}</small>`, d: `${pct(conf / nRouted)} of routed charts confirmed by clinicians` },
    { k: '<i data-lucide="file-search"></i>Found by the audit', v: `${fmt(E.auditFound)} <small>/ ${fmt(D.auditRows.length)}</small>`, d: 'eligible patients in audited charts, now routed' },
    { k: '<i data-lucide="gauge"></i>Estimated recall', v: pct(E.recall.median), d: `90% interval ${pct(E.recall.lo)}–${pct(E.recall.hi)}` },
    { k: '<i data-lucide="map-pin"></i>Lowest site recall', v: pct(worst.recall.median), d: `${D.sites[worst.site].name} (${pct(worst.recall.lo)}–${pct(worst.recall.hi)})`, warn: true },
  ].map((s) => `<div class="stat${s.warn ? ' warn' : ''}"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="d">${s.d}</div></div>`).join('');
}

// ---------- distribution chart ----------
let siteFilter = -1;
function renderDist() {
  $('site-seg').innerHTML = ['All', ...D.sites.map((s) => s.short)].map((n, i) => `<button class="${siteFilter === i - 1 ? 'on' : ''}" data-i="${i - 1}">${n}</button>`).join('');
  $('site-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { siteFilter = +b.dataset.i; renderDist(); }));
  const W = 640, H = 470, m = { l: 44, r: 12, t: 34, b: 104 };
  const B = 50, bw = 1 / B;
  const rows = [];
  for (let k = 0; k < B; k++) {
    const lo = k * bw, hi = lo + bw;
    let total = 0, elig = 0, routed = false;
    D.sites.forEach((_, si) => {
      if (siteFilter >= 0 && si !== siteFilter) return;
      if (lo >= D.threshold - 1e-9) {
        const b = D.routedBins[si][Math.round((lo - D.threshold) / 0.02)];
        if (b) { total += b.n; elig += b.x; } routed = true;
      } else {
        for (let j = Math.round(lo * 100); j < Math.round(hi * 100); j++) { const c = D.unroutedHist[si][j] || 0; total += c; elig += c * E.model.predict(si, (j + 0.5) / 100); }
      }
    });
    rows.push({ lo, hi, total, elig, routed });
  }
  const yMax = Math.max(...rows.map((r) => r.total));
  const ly = (v) => (v <= 0 ? 0 : Math.log10(1 + v) / Math.log10(1 + yMax));
  const X = (s) => m.l + s * (W - m.l - m.r), Y = (v) => m.t + (1 - ly(v)) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
  el('rect', { x: X(D.threshold), y: m.t, width: X(1) - X(D.threshold), height: H - m.t - m.b, fill: '#eff6ff' }, svg);
  [1, 10, 100, 1000, 10000].filter((v) => v <= yMax * 1.2).forEach((v) => {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: '#f4f4f5' }, svg);
    el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#71717a' }, svg).textContent = v >= 1000 ? v / 1000 + 'k' : v;
  });
  rows.forEach((r) => {
    const x = X(r.lo) + 1, w = X(r.hi) - X(r.lo) - 2;
    const g = el('g', {}, svg);
    el('rect', { x, y: Y(r.total), width: w, height: Math.max(0, Y(0) - Y(r.total)), rx: 2, fill: r.routed ? '#bfdbfe' : '#e4e4e7' }, g);
    el('rect', { x, y: Y(r.elig), width: w, height: Math.max(0, Y(0) - Y(r.elig)), rx: 2, fill: r.routed ? '#058be8' : '#635bff' }, g);
    g.addEventListener('mousemove', (e) => showTip(e, `Score ${r.lo.toFixed(2)}–${r.hi.toFixed(2)}: ${fmt(r.total)} patients · ${r.routed ? fmt(r.elig) + ' confirmed' : '~' + fmt(r.elig, 1) + ' eligible (model)'}`));
    g.addEventListener('mouseleave', hideTip);
  });
  el('line', { x1: X(D.threshold), x2: X(D.threshold), y1: m.t - 4, y2: H - m.b + 4, stroke: '#0a3d63', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
  el('text', { x: X(D.threshold) + 6, y: m.t + 12, 'font-size': 11, fill: '#0a3d63', 'font-weight': 600 }, svg).textContent = `Routing threshold ${D.threshold.toFixed(2)}`;
  for (let s = 0; s <= 10; s += 2) el('text', { x: X(s / 10), y: H - m.b + 16, 'text-anchor': 'middle', 'font-size': 10, fill: '#71717a' }, svg).textContent = (s / 10).toFixed(1);
  el('text', { x: (m.l + W - m.r) / 2, y: H - m.b + 30, 'text-anchor': 'middle', 'font-size': 10, fill: '#71717a' }, svg).textContent = 'Workflow score';
  // audited charts strip
  const stripTop = H - m.b + 44;
  el('text', { x: m.l - 6, y: stripTop + 14, 'text-anchor': 'end', 'font-size': 10, fill: '#71717a' }, svg).textContent = 'Audit';
  el('line', { x1: m.l, x2: X(D.threshold), y1: stripTop - 6, y2: stripTop - 6, stroke: '#f4f4f5' }, svg);
  const aud = D.auditRows.filter((r) => siteFilter < 0 || r.site === siteFilter);
  aud.slice().sort((a, b) => a.eligible - b.eligible).forEach((r) => {
    const y = stripTop + ((r.id * 2654435761) % 9) * 4.5;
    const c = el('circle', { cx: X(r.score), cy: y, r: r.eligible ? 2.8 : 2.2, fill: r.eligible ? '#635bff' : '#fff', stroke: r.eligible ? '#635bff' : '#c4c4cc', 'stroke-width': 1 }, svg);
    c.addEventListener('mousemove', (e) => showTip(e, `Audited chart · ${D.sites[r.site].short} · score ${r.score.toFixed(3)} · ${r.eligible ? 'eligible' : 'not eligible'}`));
    c.addEventListener('mouseleave', hideTip);
  });
  el('text', { x: X(D.threshold) + 8, y: stripTop + 14, 'font-size': 10, fill: '#71717a' }, svg).textContent = `${fmt(aud.length)} charts · ${fmt(aud.filter((r) => r.eligible).length)} eligible`;
  // legend (top)
  const lg = [['#e4e4e7', 'Unrouted patients'], ['#635bff', 'Estimated eligible, unrouted'], ['#bfdbfe', 'Routed'], ['#058be8', 'Confirmed by clinicians']];
  let lx = m.l;
  lg.forEach(([c, t]) => { el('rect', { x: lx, y: 6, width: 9, height: 9, rx: 2, fill: c }, svg); el('text', { x: lx + 13, y: 14, 'font-size': 11, fill: '#52525b' }, svg).textContent = t; lx += 13 + t.length * 5.6 + 18; });
  $('dist').innerHTML = ''; $('dist').appendChild(svg);
}

// ---------- sites ----------
function renderSites() {
  $('sites').innerHTML = E.bySite.map((b) => {
    const s = D.sites[b.site];
    const W = 100;
    return `<div class="site-row"><div class="nm">${s.name}<small>${fmt(s.routed)} routed · ${fmt(b.auditFound)} found in audit</small></div>` +
      `<svg viewBox="0 0 ${W} 14" width="100%" height="14" preserveAspectRatio="none"><rect x="0" y="4" width="${W}" height="6" rx="3" fill="#f4f4f5"/><rect x="${W * b.recall.lo}" y="4" width="${W * (b.recall.hi - b.recall.lo)}" height="6" rx="3" fill="${b.recall.median < 0.5 ? '#fcd34d' : '#bfdbfe'}"/><rect x="${W * b.recall.median - 0.6}" y="1" width="1.2" height="12" fill="#0a3d63"/></svg>` +
      `<div class="r"><b>${pct(b.recall.median)}</b><br><span class="muted" style="font-size:11px">${pct(b.recall.lo)}–${pct(b.recall.hi)}</span></div></div>`;
  }).join('');
  const worst = E.bySite.slice().sort((a, b) => a.recall.median - b.recall.median)[0];
  const idx = D.strata.map((s, h) => (s.site === worst.site && D.bands[s.band].hi <= 0.4 + 1e-9 ? h : -1)).filter((h) => h >= 0);
  const low = summarize(E.draws.map((m) => idx.reduce((a, h) => a + m[h], 0)));
  $('site-note').innerHTML = `<i data-lucide="triangle-alert"></i><div>At ${D.sites[worst.site].name}, an estimated ${fmt(low.median)} eligible patients (${fmt(low.lo)}–${fmt(low.hi)}) score below 0.40, where no threshold change reaches them. Their charts likely need a different evidence source rather than a lower cutoff.</div>`;
}

// ---------- recommendation ----------
const auditIn = (thr) => D.strata.reduce((a, s, h) => a + (D.bands[s.band].lo >= thr - 1e-9 ? E.counts[h].x : 0), 0);
function renderRec() {
  const R = recommendThreshold(D, E.counts, E.draws, policy.tau, policy.capacity);
  $('v-tau').textContent = pct(policy.tau);
  $('v-cap').textContent = fmt(policy.capacity);
  $('rec-sub').textContent = `Bands below ${D.threshold.toFixed(2)} are tested one at a time, highest first. A band is added only if, with 95% confidence, at least ${pct(policy.tau)} of its charts are eligible and the extra reviews fit the quarter's capacity. Testing stops at the first band that fails, so the guarantee holds for every band added.`;
  if (R.chosen) {
    $('rec-main').innerHTML = `<div class="t"><i data-lucide="sparkles"></i>Recommended</div><div class="h">Lower the threshold to ${R.chosen.threshold.toFixed(2)}</div>` +
      `<p>Adds <b>${fmt(R.chosen.addReviews)}</b> chart reviews this quarter and routes an estimated <b>${fmt(R.chosen.gain.median)}</b> more eligible patients (${fmt(R.chosen.gain.lo)}–${fmt(R.chosen.gain.hi)}), about ${fmt(R.chosen.addReviews / R.chosen.gain.median, 1)} reviews per patient found. Workflow recall rises from ${pct(E.recall.median)} to an estimated ${pct((E.foundRouted + auditIn(R.chosen.threshold) + R.chosen.gain.median) / (E.foundRouted + E.auditFound + E.missed.median))}.</p>` +
      `<div class="row"><button class="ButtonWithBlueGradient"><i data-lucide="check"></i>Apply to workflow</button><button class="btn-outline"><i data-lucide="flask-conical"></i>Run as shadow first</button></div>`;
  } else {
    $('rec-main').innerHTML = `<div class="t"><i data-lucide="shield-check"></i>Recommended</div><div class="h">Keep the threshold at ${D.threshold.toFixed(2)}</div><p>No band below the threshold clears ${pct(policy.tau)} yield with 95% confidence within ${fmt(policy.capacity)} extra reviews. Audit more charts from the queue to tighten the bounds.</p>`;
  }
  const tested = new Set(R.tests.map((t) => t.band));
  const order = D.bands.map((b, i) => i).filter((i) => D.bands[i].hi <= D.threshold + 1e-9).sort((a, b) => D.bands[b].lo - D.bands[a].lo);
  $('rec-tests').innerHTML = order.map((bi) => {
    const t = R.tests.find((x) => x.band === bi);
    if (!t) return `<div class="test"><i data-lucide="circle-dashed" class="na"></i><span>${bandLabel(bi)}</span><span class="na span2">Not tested: the sequence stopped at the band above</span></div>`;
    const icon = t.pass ? '<i data-lucide="circle-check" class="ok"></i>' : '<i data-lucide="circle-x" class="no"></i>';
    const why = t.pass ? `bound ${pct(t.rate.lo)} ≥ ${pct(policy.tau)}` : !t.passRate ? `bound ${pct(t.rate.lo)} < ${pct(policy.tau)}` : `over capacity`;
    return `<div class="test">${icon}<span>${bandLabel(bi)}</span><div class="bar" title="Estimated eligible rate ${pct(t.rate.median)} (90% interval ${pct(t.rate.lo)}–${pct(t.rate.hi)})"><i style="left:${100 * t.rate.lo}%;width:${100 * (t.rate.hi - t.rate.lo)}%"></i><b style="left:${100 * t.rate.median}%"></b><u style="left:${100 * policy.tau}%"></u></div><span class="r">${fmt(t.add)} charts · ${why}</span></div>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

// ---------- strata + queue ----------
function renderStrata() {
  const order = D.strata.map((s, h) => h).sort((a, b) => D.strata[a].site - D.strata[b].site || D.strata[b].band - D.strata[a].band);
  $('strata').innerHTML = `<thead><tr><th>Site</th><th>Score band</th><th class="r">Unrouted</th><th class="r">Audited</th><th class="r">Est. eligible left</th></tr></thead><tbody>` +
    order.map((h) => {
      const s = D.strata[h], c = E.counts[h], p = perStratum[h];
      const rate = p.median / Math.max(1, s.N - c.n);
      const bg = `rgba(99,91,255,${Math.min(0.85, rate * 2.2).toFixed(2)})`;
      return `<tr><td>${D.sites[s.site].short}</td><td class="band">${bandLabel(s.band)}</td><td class="r">${fmt(s.N)}</td><td class="r">${c.x}/${c.n}</td><td class="r"><span class="heat" style="background:${bg};color:${rate > 0.2 ? '#fff' : '#18181b'}" title="90% interval ${fmt(p.lo)}–${fmt(p.hi)}">${fmt(p.median)}</span></td></tr>`;
    }).join('') + '</tbody>';
  const K = 25;
  const alloc = nextAudits(E.est, K);
  const rows = [];
  alloc.forEach((k, h) => { for (let i = 0; i < k && i < D.queuePool[h].length; i++) rows.push({ h, ...D.queuePool[h][i] }); });
  rows.sort((a, b) => b.score - a.score);
  const strataUsed = alloc.filter((k) => k > 0).length;
  $('q-sub').textContent = `The next ${rows.length} charts to audit, chosen from ${strataUsed} strata where one more chart shrinks the uncertainty in the missed-patient count the most.`;
  $('queue').innerHTML = `<thead><tr><th>Patient</th><th>Site</th><th class="r">Score</th><th>Band</th><th>Status</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="mrn">${mrn(r.id)}</td><td>${D.sites[D.strata[r.h].site].short}</td><td class="r">${r.score.toFixed(3)}</td><td class="band">${bandLabel(D.strata[r.h].band)}</td><td><span class="pill blue">To audit</span></td></tr>`).join('') + '</tbody>';
}

// ---------- method + validation ----------
function renderMethod() {
  const v = V.validation, T = V.truth;
  $('steps').innerHTML = [
    `Unrouted patients are split into ${D.strata.length} strata (${D.sites.length} sites × ${D.bands.length} score bands below ${D.threshold.toFixed(2)}).`,
    `Audit design: ${D.audit.n0} charts per stratum as a pilot, then the rest of the ${fmt(D.audit.total)} by Neyman allocation, using the eligible rate a calibration model predicts for each stratum.`,
    `Calibration model: beta calibration per site, <code>logit p = a + b·log s − c·log(1−s)</code>, shrunk toward a shared fit and trained on clinician review outcomes of routed charts plus the audit.`,
    `Estimate: a model-assisted difference estimator per stratum, model prediction for every unaudited chart plus the audit's average correction, so it stays unbiased even if the model is off. Variance is floored at the model's own Bernoulli variance.`,
    `Threshold: fixed-sequence test of each band's lower 95% bound against the yield target, stopping at the first failure, within review capacity.`,
    `Everything on this page is recomputed in your browser from the ${fmt(D.auditRows.length)} audited charts and the score histograms in ${fmt(ms)} ms.`,
  ].map((s) => `<li>${s}</li>`).join('');
  $('val').innerHTML =
    `<div><b>${fmt(E.missed.median)} vs ${fmt(T.trueMissed)}</b><span>missed patients, this audit's estimate vs the simulator's truth</span></div>` +
    `<div><b>${pct(v.coverage90)}</b><span>of ${v.reps} replayed audits had the truth inside the 90% interval (slightly under nominal)</span></div>` +
    `<div><b>${fmt(v.rmse.neyman)} / ${fmt(v.rmse.proportional)} / ${fmt(v.rmse.srs)}</b><span>error (RMSE, patients) for this design / proportional strata / simple random sample, same 600 charts</span></div>` +
    `<div><b>${fmt(Math.round(v.thresholdErrorRate * v.thresholdChosenRuns))} of ${v.thresholdChosenRuns}</b><span>replays added a band whose true yield was under ${pct(D.policy.tau)}</span></div>`;
}

$('in-tau').value = policy.tau; $('in-cap').value = policy.capacity;
$('in-tau').addEventListener('input', (e) => { policy.tau = +e.target.value; renderRec(); });
$('in-cap').addEventListener('input', (e) => { policy.capacity = +e.target.value; renderRec(); });
$('go-rec').addEventListener('click', () => $('rec-card').scrollIntoView({ behavior: 'smooth' }));
$('go-queue').addEventListener('click', () => $('queue-card').scrollIntoView({ behavior: 'smooth' }));
header(); renderDist(); renderSites(); renderRec(); renderStrata(); renderMethod();
if (window.lucide) lucide.createIcons();
