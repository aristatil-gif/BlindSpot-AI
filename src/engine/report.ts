// Standalone, printable HTML report. Everything is escaped; "Observed" and "Interpretation" are labelled separately.

import { aspectLabel } from "./taxonomy.ts";
import type { AnalysisResult, Finding } from "./types.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const OUTCOME_LABEL: Record<AnalysisResult["outcome"], string> = {
  blind_spot_detected: "Evidence-supported blind spot detected",
  potential_pattern: "Potential pattern requiring further investigation",
  no_blind_spot: "No significant blind spot established",
  insufficient_data: "Insufficient data for reliable analysis",
};

function findingHtml(r: AnalysisResult, f: Finding): string {
  const quotes = f.supportingReviewIds.slice(0, 4).map((id) => {
    const ev = r.evidence[id];
    const m = r.evidenceMentions.find((x) => x.reviewId === id && x.aspect === f.aspect && x.sentiment === "negative");
    return `<blockquote>“${esc(m?.quote ?? ev?.text ?? "")}”<cite>${esc(id)}${ev?.date ? ` · ${esc(ev.date)}` : ""}${ev?.rating ? ` · ${ev.rating}★` : ""}</cite></blockquote>`;
  }).join("");
  const comps = f.scorecard.components.map((c) => `<tr><td>${esc(c.label)}</td><td>${Math.round(c.value * c.weight)} / ${c.weight}</td><td>${esc(c.detail)}</td></tr>`).join("");
  return `<section class="finding ${esc(f.kind)}">
  <h3>${esc(f.title)} <span class="tag">${f.kind === "blind_spot" ? "Blind spot" : f.kind === "hypothesis" ? "Hypothesis" : "Visible issue"}</span></h3>
  <p>${esc(f.explanation)}</p>
  <h4>Observed in the data</h4><ul>${f.observed.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
  <h4>Interpretation (system-generated)</h4><ul>${f.inferred.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
  <p><strong>Confidence: ${esc(f.confidence)}.</strong> ${esc(f.confidenceReason)}</p>
  <p><strong>Still uncertain:</strong> ${f.uncertainties.map(esc).join(" ")}</p>
  <table><thead><tr><th>Scorecard</th><th>Points</th><th>Basis</th></tr></thead><tbody>${comps}<tr><td><strong>Total</strong></td><td><strong>${f.scorecard.score} / 100</strong></td><td>Prioritisation aid, not a probability.</td></tr></tbody></table>
  <h4>Evidence excerpts</h4>${quotes}
</section>`;
}

export function renderReport(r: AnalysisResult): string {
  const aspectRows = r.aspects.map((a) => `<tr><td>${esc(a.label)}</td><td>${a.reviews}</td><td>${pct(a.positiveShare)}</td><td>${pct(a.neutralShare)}</td><td>${pct(a.negativeShare)}</td><td>${esc(a.confidence)}</td><td>${esc(a.trend.status)}</td></tr>`).join("");
  const recs = r.recommendations.map((x) => `<li><strong>${esc(aspectLabel(x.aspect))} — ${esc(x.priority)} priority${x.evidenceBacked ? "" : " (needs confirmation first)"}.</strong> ${esc(x.action)}<br><em>Why:</em> ${esc(x.why)} <em>Expected benefit:</em> ${esc(x.expectedBenefit)} <em>Measure:</em> ${esc(x.measure)}</li>`).join("");
  const q = r.quality;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlindSpot AI report — ${esc(r.datasetName)}</title>
<style>
:root{--ink:#17202e;--muted:#5b6575;--paper:#fff;--line:#d9d4ca;--amber:#b4600c}
body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);max-width:860px;margin:0 auto;padding:32px 20px}
h1,h2,h3{font-family:Iowan Old Style,Georgia,serif;line-height:1.2}
h1{font-size:30px;margin:0 0 4px}h2{margin-top:36px;border-bottom:2px solid var(--ink);padding-bottom:4px}
h4{margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;font-size:14px}
blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--amber);background:#faf6ee}cite{display:block;font-size:12px;color:var(--muted);font-style:normal}
.tag{font:600 11px system-ui;background:var(--ink);color:#fff;padding:2px 7px;border-radius:99px;vertical-align:middle}
.finding{border:1px solid var(--line);border-radius:8px;padding:4px 18px 14px;margin:16px 0;break-inside:avoid}
.outcome{background:#faf6ee;border-left:4px solid var(--amber);padding:10px 16px;margin:16px 0}
.muted{color:var(--muted)}
@media print{body{padding:0}h2{break-after:avoid}}
</style></head><body>
<p class="muted">BlindSpot AI report · ${esc(new Date(r.createdAt).toUTCString())}</p>
<h1>${esc(r.datasetName)}</h1>
<div class="outcome"><strong>${esc(OUTCOME_LABEL[r.outcome])}.</strong> ${esc(r.outcomeSummary)}</div>

<h2>1. Dataset summary</h2>
<p>${q.usableReviews} usable reviews from ${q.totalRows} rows${q.dateRange ? `, dated ${esc(q.dateRange.from)} to ${esc(q.dateRange.to)}` : ""}. ${esc(r.overall.healthBasis)}</p>
<h2>2. Data-quality observations</h2>
${q.limitations.length ? `<ul>${q.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "<p>No significant data-quality limitations found.</p>"}
${q.issues.length ? `<ul class="muted">${q.issues.map((i) => `<li>${esc(i.message)} (${i.rows.length}${i.rows.length >= 50 ? "+" : ""} rows)</li>`).join("")}</ul>` : ""}
<h2>3. Aspect-level sentiment</h2>
<table><thead><tr><th>Aspect</th><th>Reviews</th><th>Positive</th><th>Neutral</th><th>Negative</th><th>Confidence</th><th>Trend</th></tr></thead><tbody>${aspectRows || `<tr><td colspan="7">No aspects detected.</td></tr>`}</tbody></table>
<p class="muted">Percentages appear only when an aspect has at least 5 mentions. Ambiguous mentions (e.g. possible sarcasm) are excluded.</p>
<h2>4. Key findings</h2>
${r.findings.length ? r.findings.map((f) => findingHtml(r, f)).join("") : "<p>No finding met the evidence thresholds. That is a result in itself: the current data does not establish a blind spot.</p>"}
${r.contradictions.length ? `<h2>5. Contradictions and expectation gaps</h2><ul>${r.contradictions.map((c) => `<li><strong>${esc(c.title)}.</strong> ${esc(c.explanation)} <em>Possible reasons (hypotheses):</em> ${c.possibleReasons.map(esc).join(" ")}</li>`).join("")}</ul>` : ""}
<h2>6. Recommended actions</h2>${recs ? `<ol>${recs}</ol>` : "<p>No evidence-backed action is recommended from the current data.</p>"}
<h2>7. Methodology and limitations</h2>
<ul>
<li>Engine: ${esc(r.engine === "llm" ? "AI-assisted extraction with deterministic scoring" : "offline keyword extraction with deterministic scoring")}. Algorithm: ${esc(r.algorithm)} v${esc(r.version)}.</li>
<li>Scoring: ${esc(r.findings[0]?.scorecard.formula ?? "score = 30·volume + 25·recurrence + 20·severity + 25·hiddenness. A prioritisation aid, not a probability.")}</li>
<li>The scoring weights and thresholds are heuristics chosen by the developers and have not been calibrated against labelled data.</li>
<li>Review text alone cannot establish the cause of a problem. Items under “Interpretation” are the system's reading, not facts.</li>
<li>Dataset fingerprint (SHA-256): <code>${esc(r.datasetHash.slice(0, 16))}…</code></li>
${r.engineNotes.map((n) => `<li>${esc(n)}</li>`).join("")}
</ul></body></html>`;
}
