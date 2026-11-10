# Coverage audit: how many eligible patients is a population-finder workflow missing?

**Live demo:** https://mohith26.github.io/qualified-health-coverage-audit/

Unofficial concept demo by Mohith Gajjela. Not affiliated with Qualified Health. All data is synthetic; no real patients.

## What it is

Population-level patient-finding workflows (screen every chart, route the ones that look eligible for an intervention to the care team) report what they found: routed charts and clinician-confirmed patients. What they cannot see is the patients scored *below* the routing threshold. Precision is visible; recall is not.

This is a "Coverage audit" tab for such a workflow (here: a hepatitis C untreated-infection finder across 4 sites, 52,500 patients). It:

1. **Designs a small audit** of unrouted charts: 24 strata (site × score band), an 8-chart pilot per stratum, then Neyman allocation of the rest of a 600-chart budget using a calibration model's predicted eligible rate per stratum.
2. **Estimates the missed patients** with a model-assisted difference estimator, giving the workflow's recall with an interval, overall and per site.
3. **Recommends a threshold** with a guarantee: score bands below the threshold are tested highest-first; a band is added only if the lower 95% bound of its eligible rate clears a yield target (default 25%, about 4 reviews per patient found) and the added reviews fit review capacity; testing stops at the first failure (fixed-sequence).
4. **Queues the next charts to audit** where one more chart shrinks the uncertainty the most.

On the synthetic population (seeded, committed):

- Estimated **1,185 eligible patients below threshold** (90% interval 963-1,460); the simulator's truth is **1,169**. Estimated recall 63% (58-67%), truth 63%.
- Per-site recall 81% / 74% / 59% / **27%**: at the rural clinics network, eligible patients score low (evidence in scanned outside records), and an estimated 281 of them sit below 0.40 where no threshold change reaches them.
- Recommendation: lower the threshold from 0.60 to 0.50: 575 more reviews, an estimated 446 more patients (408-483); truth 414. The 0.40-0.50 band fails (bound 23% < 25%).

## How it works

- **Calibration model.** Beta calibration (Kull et al., 2017): `logit p = a + b·log s − c·log(1−s)` per site, ridge-shrunk toward a shared fit, trained by Newton's method on clinician review outcomes of routed charts (binned) plus the audited charts.
- **Estimator.** Per stratum, `M_h = Σ_unaudited p(s) + (N_h − n_h) · mean_audited(y − p(s))`. The model term reduces variance; the residual term keeps the estimate design-consistent when the model is wrong (a test checks unbiasedness under a deliberately wrong model). Variance `(N_h−n_h)² (1−f_h) S_h² / n_h`, with `S_h²` floored at the model's Bernoulli variance in the stratum.
- **Intervals.** Normal draws per stratum, summed: totals, per-site recall and per-band yield come from the same 4,000 draws.
- **Everything is recomputed in the browser** from the committed audit rows and score histograms (~20 ms).

## Validation (scripts/run.mjs)

300 replayed audits on the same population:

- 90% interval coverage of the missed count: **87%** (slightly under nominal; see limitations).
- RMSE of the missed count with 600 charts: **190** (this design) vs 266 (proportional stratified) vs 318 (simple random sample).
- Threshold test added a band whose true yield was under 25% in **0 of 300** runs.

## Files

- `core/audit.mjs`: Neyman allocation, beta-calibration model, difference estimator, interval draws, fixed-sequence threshold test, next-audit queue.
- `scripts/population.mjs`: seeded population (4 sites, beta-distributed scores by eligibility and site) and the two-phase audit draw.
- `scripts/run.mjs`: builds `data/workflow.json` (what the platform would know: routed review outcomes, score histograms, audit results), `data/truth.json` (checks only) and `data/bundle.js`, and runs the validation study.
- `index.html`, `app.js`, `styles.css`: the page, in the Qualified Health app shell.

## Tests

```
node scripts/run.mjs
node --test tests/core.test.mjs
```

8 tests: beta sampler; Neyman allocation budget/caps/ordering; beta calibration recovers a beta-mixture posterior; difference estimator unbiased under a wrong model; committed audit's interval covers the truth and site recalls are close; threshold test properties (pass bounds, stops at first failure, capacity, true yield above target); audit queue; committed data reproduce from the seeded generator.

## Honest limitations

- Synthetic population. Scores are generated from beta distributions, which is exactly the family beta calibration fits, so the model is better specified here than it would be on real scores. The difference estimator protects the point estimate from misspecification, not the interval width.
- The 90% interval covered the truth in 87% of replays: strata with a low but non-zero eligible rate and no positives in a small sample are under-represented in the variance. A larger pilot, a more conservative variance floor, or a design-based bootstrap would trade width for coverage.
- "Eligible" is treated as a clean label from chart audit; real audits have reviewer disagreement, which should be modeled (e.g., double review of a subsample).
- The yield bound is a Gaussian approximation per band, validated by simulation (0/300 errors), not an exact finite-sample test.
- Patients found by the audit are counted as found but not as routed by the rule; recall here is the routing rule's recall.

## Novelty note

Qualified Health's public materials describe post-deployment monitoring (drift, hallucinations, usage), audit trails, human-in-the-loop review and outcome tracking; none describe estimating the patients a population workflow misses below its threshold. The statistics are classical: stratified two-phase sampling and model-assisted estimation (survey sampling), recall estimation by sampling the discard pile ("elusion testing" in legal e-discovery), beta calibration, and fixed-sequence testing (as in Learn-then-Test). The combination applied to LLM chart-review workflows, with per-site recall and a threshold guarantee, is the contribution.
