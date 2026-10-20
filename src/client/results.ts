import type { AnalysisResult, Finding, Mention, Sentiment } from "../engine/types.ts";
import { api, ApiError } from "./api.ts";
import { clear, fmtDate, h, pct, plural, s, safeHref, term, toast, type Child } from "./dom.ts";

export const OUTCOME_LABEL: Record<string, string> = {
  blind_spot_detected: "Blind spot detected",
  potential_pattern: "Potential pattern",
  no_blind_spot: "No blind spot established",
  insufficient_data: "Insufficient data",
};
const OUTCOME_HEADLINE: Record<string, string> = {
  blind_spot_detected: "Evidence-supported blind spot detected",
  potential_pattern: "Potential pattern requiring further investigation",
  no_blind_spot: "No significant blind spot established from the current data",
  insufficient_data: "Insufficient data for reliable analysis",
};
const TABS: [string, string][] = [["overview", "Overview"], ["aspects", "Aspects"], ["findings", "Findings"], ["evidence", "Evidence"], ["actions", "Actions"], ["ask", "Ask"]];
const KIND_LABEL: Record<string, string> = { blind_spot: "Blind spot", hypothesis: "Hypothesis", recurring_issue: "Visible issue" };
const FEEDBACK: [string, string][] = [["useful", "Useful"], ["not_useful", "Not useful"], ["incorrect", "Incorrect"], ["missing_context", "Missing context"]];

interface Ctx { id: string; r: AnalysisResult; feedback: Record<string, string> }

function quoteWithMark(text: string, quote: string): Child[] {
  const i = text.toLowerCase().indexOf(quote.toLowerCase());
  if (i < 0 || quote.length < 3) return [text];
  return [text.slice(0, i), h("mark", null, text.slice(i, i + quote.length)), text.slice(i + quote.length)];
}

function aspectName(r: AnalysisResult, id: string) {
  return r.aspects.find((a) => a.aspect === id)?.label ?? id;
}

// ---------- shared pieces ----------
function reviewCard(ctx: Ctx, id: string, mentions: Mention[], why: (m: Mention) => string): HTMLElement {
  const ev = ctx.r.evidence[id];
  if (!ev) return h("div", { class: "rev muted" }, "Review no longer available.");
  const href = safeHref(ev.url);
  const shown = mentions.length ? mentions : ctx.r.evidenceMentions.filter((m) => m.reviewId === id).slice(0, 2);
  const firstQuote = shown[0]?.quote ?? "";
  return h("article", { class: "rev", id: `rev-${id}` },
    h("div", { class: "meta" },
      h("span", { class: "mono" }, id),
      ev.date ? h("span", null, ev.date) : null,
      ev.rating ? h("span", { "aria-label": `${ev.rating} out of 5 stars` }, `${ev.rating}★`) : null,
      ev.source ? h("span", null, ev.source) : null,
      href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow" }, "Original review ↗") : null),
    h("p", { style: "margin:0" }, quoteWithMark(ev.text, firstQuote)),
    shown.map((m) => h("div", { class: "why" },
      h("span", { class: `pill ${m.sentiment === "negative" ? "neg" : m.sentiment === "positive" ? "pos" : ""}` }, m.uncertain ? "ambiguous" : m.sentiment), " ",
      h("strong", null, aspectName(ctx.r, m.aspect)), ": ", why(m))));
}


function pipelineStrip(r: AnalysisResult): HTMLElement {
  const patterns = r.findings.length + r.contradictions.length;
  const blind = r.findings.filter((f) => f.kind === "blind_spot").length;
  const steps: [string, string][] = [
    ["Sentiment", r.overall.positiveShare === null ? "n/a" : `${pct(r.overall.positiveShare)} positive overall`],
    ["Aspects", `${plural(r.aspects.length, "aspect")} found`],
    ["Patterns", `${plural(patterns, "pattern")} checked`],
    ["Blind spots", `${blind} confirmed`],
    ["Insights", `${plural(r.recommendations.length, "action")} suggested`],
  ];
  return h("ol", { class: "pipeline", "aria-label": "Analysis steps" }, steps.map(([name, value], i) => h("li", null, h("span", { class: "pl-n" }, String(i + 1)), h("strong", null, name), h("span", { class: "small muted" }, value))));
}

function dataQuality(r: AnalysisResult): HTMLElement {
  const q = r.quality;
  const items = [...q.limitations, ...r.engineNotes];
  return h("section", { class: "notice", "aria-label": "Data quality" },
    h("strong", null, "Data quality, read before the conclusions"),
    h("p", { class: "small", style: "margin:4px 0 0" }, `${plural(q.usableReviews, "usable review")} from ${plural(q.totalRows, "row")}`, q.dateRange ? `, dated ${q.dateRange.from} to ${q.dateRange.to}` : "", ". ", `${q.withRating} with a rating, ${q.withDate} with a date.`),
    items.length ? h("ul", null, items.map((l) => h("li", null, l))) : h("p", { class: "small", style: "margin:6px 0 0" }, "No significant data-quality limitations found."),
    q.issues.length ? h("details", { style: "margin-top:8px" }, h("summary", { class: "small" }, "All checks that triggered"), h("ul", { class: "small" }, q.issues.map((i) => h("li", null, `${i.message} (${i.rows.length}${i.rows.length >= 50 ? "+" : ""} rows)`)))) : null);
}

// ---------- Overview with the blind-spot dot view ----------
function dotView(ctx: Ctx, selected: string | null): HTMLElement {
  const { r } = ctx;
  const f = r.findings.find((x) => x.id === selected) ?? null;
  const hit = new Set(f?.supportingReviewIds ?? []);
  const dots = [...r.reviewDots].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const cell = 16, cols = Math.min(40, Math.max(8, Math.ceil(Math.sqrt(dots.length * 2.5))));
  const rows = Math.ceil(dots.length / cols);
  const color: Record<Sentiment, string> = { positive: "var(--teal)", neutral: "var(--grey)", negative: "var(--brick)" };
  const counts = { positive: 0, neutral: 0, negative: 0 } as Record<Sentiment, number>;
  dots.forEach((d) => counts[d.overall]++);
  const svg = s("svg", { class: "dots", viewBox: `0 0 ${cols * cell} ${rows * cell}`, role: "img",
    "aria-label": f ? `${dots.length} reviews drawn as dots. ${hit.size} reviews complain about ${aspectName(r, f.aspect).toLowerCase()}; ${[...hit].filter((id) => dots.find((d) => d.id === id)?.overall === "positive").length} of those look positive overall.` : `${dots.length} reviews drawn as dots, coloured by overall sentiment.` },
    dots.map((d, i) => {
      const cx = (i % cols) * cell + cell / 2, cy = Math.floor(i / cols) * cell + cell / 2;
      const isHit = hit.has(d.id);
      return s("g", null,
        s("title", null, `${d.id}: ${d.overall} overall${d.rating ? `, ${d.rating}★` : ""}${d.date ? `, ${d.date}` : ""}${isHit ? ` · complains about ${aspectName(r, f!.aspect).toLowerCase()}` : ""}`),
        isHit ? s("circle", { cx, cy, r: 7.2, fill: "none", stroke: "var(--amber)", "stroke-width": 2.4 }) : null,
        s("circle", { cx, cy, r: isHit ? 4.2 : 4.6, fill: color[d.overall], opacity: f && !isHit ? 0.55 : 1 }));
    }));
  const sel = h("select", { id: "dot-finding", "aria-label": "Finding to highlight", onchange: () => card.replaceWith((card = dotView(ctx, (sel as HTMLSelectElement).value || null))) },
    h("option", { value: "" }, "No highlight"), r.findings.map((x) => h("option", { value: x.id, selected: x.id === selected }, x.title)));
  let card = h("section", { class: "card" },
    h("div", { class: "row between" }, h("h2", { style: "margin:0" }, "Every review, at a glance"), r.findings.length ? sel : null),
    h("p", { class: "small muted" }, f
      ? `Each dot is one review. Amber rings mark the ${hit.size} reviews that complain about ${aspectName(r, f.aspect).toLowerCase()}. Notice how many of them sit among positive dots.`
      : "Each dot is one review, coloured by its overall sentiment. When a finding exists, pick it to see where its complaints hide."),
    svg,
    h("div", { class: "legend", style: "margin-top:8px" },
      h("span", { style: "--c:var(--teal)" }, `Positive overall (${counts.positive})`), h("span", { style: "--c:var(--grey)" }, `Neutral (${counts.neutral})`), h("span", { style: "--c:var(--brick)" }, `Negative (${counts.negative})`),
      f ? h("span", { style: "--c:var(--amber)" }, "Amber ring = complains about this aspect") : null));
  return card;
}

function overviewTab(ctx: Ctx): HTMLElement {
  const { r } = ctx;
  const stat = (label: string, value: string) => h("div", null, h("div", { class: "small muted" }, label), h("div", { style: "font:700 1.5rem var(--serif)" }, value));
  const top = r.findings.slice(0, 3);
  return h("div", null,
    h("div", { class: "card" }, h("div", { class: "cols", style: "grid-template-columns:repeat(auto-fit,minmax(130px,1fr))" },
      stat("Usable reviews", String(r.overall.reviews)),
      stat("Average rating", r.overall.averageRating !== null ? `${r.overall.averageRating.toFixed(1)} / 5` : "no ratings"),
      stat("Positive overall", pct(r.overall.positiveShare)),
      stat("Aspects found", String(r.aspects.length))),
      h("p", { class: "small muted", style: "margin:10px 0 0" }, r.overall.healthBasis)),
    dotView(ctx, r.findings.find((f) => f.kind === "blind_spot")?.id ?? r.findings[0]?.id ?? null),
    top.length ? h("section", null, h("h2", null, "Top findings"), top.map((f) => h("div", { class: "card" },
      h("div", { class: "row between" }, h("h3", { style: "margin:0" }, f.title), h("span", { class: `pill ${f.kind === "blind_spot" ? "blind" : ""}` }, KIND_LABEL[f.kind])),
      h("p", { style: "margin:8px 0" }, f.explanation),
      h("a", { href: `#/a/${ctx.id}/findings` }, "See the evidence and scorecard →")))) : h("div", { class: "card" }, h("h2", null, "No finding to show"), h("p", { style: "margin:0" }, r.outcome === "insufficient_data"
      ? "There isn't enough data to say anything reliable yet. Add more reviews, ideally 20 or more with dates, and run it again."
      : "That is a result: no recurring complaint met the evidence thresholds, so nothing is flagged. The Aspects tab still shows what customers say about each topic.")),
    r.contradictions.length ? h("section", null, h("h2", null, "Contradictions and expectation gaps"), r.contradictions.map((c) => contradictionCard(ctx, c))) : null);
}

function contradictionCard(ctx: Ctx, c: AnalysisResult["contradictions"][number]): HTMLElement {
  const quote = (id: string, sentiment: "positive" | "negative") => {
    const m = ctx.r.evidenceMentions.find((x) => x.reviewId === id && x.aspect === c.aspect && x.sentiment === sentiment) ?? ctx.r.evidenceMentions.find((x) => x.reviewId === id && x.aspect === c.aspect);
    return m ? h("div", { class: "quote" }, `“${m.quote}”`, h("div", { class: "small muted" }, id)) : null;
  };
  return h("div", { class: "card" }, h("h3", null, c.title), h("p", null, c.explanation),
    h("div", { class: "cols" },
      c.positiveReviewIds.length ? h("div", null, h("h4", null, "Praise"), c.positiveReviewIds.slice(0, 2).map((id) => quote(id, "positive"))) : null,
      h("div", null, h("h4", null, c.kind === "expectation_gap" ? "Expected vs experienced" : "Criticism"), c.negativeReviewIds.slice(0, 2).map((id) => quote(id, "negative")))),
    h("p", { class: "small muted tag-inf", style: "margin:8px 0 0" }, "Possible reasons (hypotheses, not established): ", c.possibleReasons.join(" ")));
}

// ---------- Aspects ----------
function aspectsTab(ctx: Ctx): HTMLElement {
  const { r } = ctx;
  let q = "", sort = "mentions", onlyNeg = false;
  const list = h("div", { class: "card" });
  const draw = () => {
    let rows = r.aspects.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()) && (!onlyNeg || a.negative > 0));
    rows = [...rows].sort((a, b) => sort === "negative" ? b.negative - a.negative : sort === "name" ? a.label.localeCompare(b.label) : b.reviews - a.reviews);
    if (!rows.length) { list.replaceChildren(h("div", { class: "empty" }, r.aspects.length ? "No aspects match these filters." : "No aspects were found in these reviews. They may not describe product or service qualities.")); return; }
    list.replaceChildren(...rows.map((a) => {
      const total = Math.max(1, a.positive + a.neutral + a.negative);
      return h("div", { class: "aspect" },
        h("div", null, h("div", { class: "name" }, a.label), h("span", { class: "pill" }, `${a.confidence} confidence`)),
        h("div", null,
          h("div", { class: "bar-stack", role: "img", "aria-label": `${a.label}: ${a.positive} positive, ${a.neutral} neutral, ${a.negative} negative reviews` },
            h("i", { class: "seg-pos", style: `width:${(a.positive / total) * 100}%` }), h("i", { class: "seg-neu", style: `width:${(a.neutral / total) * 100}%` }), h("i", { class: "seg-neg", style: `width:${(a.negative / total) * 100}%` })),
          h("div", { class: "small", style: "margin-top:4px" }, `${plural(a.reviews, "review")}: `, `${a.positive} positive, ${a.neutral} neutral, ${a.negative} negative`, a.positiveShare !== null ? ` (${pct(a.positiveShare)} / ${pct(a.neutralShare)} / ${pct(a.negativeShare)})` : ""),
          h("div", { class: "small muted" }, a.trend.status === "insufficient" ? `Change over time: ${a.trend.reason}` : `Over time: ${a.trend.status}. ${a.trend.reason}`),
          a.limitation ? h("div", { class: "small muted tag-inf" }, a.limitation) : null),
        h("div", null, a.negative ? h("a", { class: "btn small", href: `#/a/${ctx.id}/evidence?aspect=${a.aspect}&sentiment=negative` }, "See complaints") : null, " ",
          a.positive ? h("a", { class: "btn small", href: `#/a/${ctx.id}/evidence?aspect=${a.aspect}&sentiment=positive` }, "See praise") : null));
    }));
  };
  draw();
  return h("div", null,
    h("p", { class: "muted" }, "How customers talk about each aspect. An aspect is only counted negative where reviewers actually express a negative view of it. Percentages appear once an aspect has 5 or more mentions."),
    h("div", { class: "filters", style: "grid-template-columns:2fr 1fr auto" },
      h("div", null, h("label", { for: "asp-q" }, "Search aspects"), h("input", { type: "search", id: "asp-q", oninput: (e: Event) => { q = (e.target as HTMLInputElement).value; draw(); } })),
      h("div", null, h("label", { for: "asp-sort" }, "Sort by"), h("select", { id: "asp-sort", onchange: (e: Event) => { sort = (e.target as HTMLSelectElement).value; draw(); } }, h("option", { value: "mentions" }, "Most mentioned"), h("option", { value: "negative" }, "Most complaints"), h("option", { value: "name" }, "Name"))),
      h("label", { style: "font-weight:400;padding-bottom:10px" }, h("input", { type: "checkbox", onchange: (e: Event) => { onlyNeg = (e.target as HTMLInputElement).checked; draw(); } }), " Only with complaints")),
    h("div", { class: "legend", style: "margin-bottom:8px" }, h("span", { style: "--c:var(--teal)" }, "Positive"), h("span", { style: "--c:var(--grey)" }, "Neutral"), h("span", { style: "--c:var(--brick)" }, "Negative")),
    list);
}

// ---------- Findings ----------
function findingCard(ctx: Ctx, f: Finding): HTMLElement {
  const rec = ctx.r.recommendations.find((x) => x.id === f.recommendationId);
  const fbBox = h("div", { class: "row fb", role: "group", "aria-label": "Rate this finding" });
  const paintFb = () => fbBox.replaceChildren(h("span", { class: "small muted" }, "Was this finding helpful?"), ...FEEDBACK.map(([k, label]) =>
    h("button", { class: `btn small ${ctx.feedback[f.id] === k ? "on" : ""}`, type: "button", "aria-pressed": String(ctx.feedback[f.id] === k), onclick: async () => {
      try { await api.feedback(ctx.id, f.id, k); ctx.feedback[f.id] = k; paintFb(); toast("Thanks. Feedback is stored for evaluation only and doesn't change how the tool behaves."); } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save feedback."); }
    } }, label)));
  paintFb();
  const sc = f.scorecard;
  return h("article", { class: "card finding", id: f.id },
    h("h3", null, f.title, h("span", { class: `pill ${f.kind === "blind_spot" ? "blind" : ""}` }, KIND_LABEL[f.kind])),
    h("p", null, f.explanation),
    h("div", { class: "cols" },
      h("div", null, h("h4", null, "Observed in the data"), h("ul", null, f.observed.map((o) => h("li", null, o)))),
      h("div", null, h("h4", null, "Interpretation (system-generated)"), h("ul", { class: "tag-inf" }, f.inferred.map((o) => h("li", null, o))))),
    h("h4", null, "Potential impact"), h("p", { style: "margin:0" }, f.impact),
    h("h4", null, term("Confidence", "How much weight the evidence deserves: how many independent reviews, how clear the wording is, and how reliable the method is. It is not a probability.")),
    h("p", { style: "margin:0" }, h("strong", null, f.confidence), ". ", f.confidenceReason),
    h("h4", null, "What remains uncertain"), h("ul", null, f.uncertainties.map((u) => h("li", null, u))),
    h("h4", null, term("Evidence scorecard", "A transparent 0 to 100 prioritisation aid built from four parts. The weights are developer-chosen heuristics, not calibrated against labelled data, and the total is not a probability.")),
    h("table", { class: "score-table" },
      h("thead", null, h("tr", null, h("th", null, "Part"), h("th", null, "Points"), h("th", null, "Basis"))),
      h("tbody", null,
        sc.components.map((c) => h("tr", null, h("td", null, c.label), h("td", null, h("span", { class: "meter", "aria-hidden": "true" }, h("i", { style: `width:${c.value * 100}%` })), ` ${Math.round(c.value * c.weight)}/${c.weight}`), h("td", { class: "small" }, c.detail))),
        h("tr", null, h("td", null, h("strong", null, "Total")), h("td", null, h("strong", null, `${sc.score}/100`)), h("td", { class: "small muted" }, sc.formula)),
        h("tr", null, h("td", null, "Contradicting evidence"), h("td", null, String(sc.contradictoryEvidence.positiveMentions)), h("td", { class: "small" }, `${plural(sc.contradictoryEvidence.positiveMentions, "review")} praise this aspect.`)),
        h("tr", null, h("td", null, "Recency"), h("td", null, sc.recency.status), h("td", { class: "small" }, sc.recency.reason)))),
    rec ? h("div", { class: "quote", style: "margin-top:14px" }, h("strong", null, rec.evidenceBacked ? "Suggested action: " : "Confirm first: "), rec.action) : null,
    h("div", { class: "row", style: "margin-top:14px" }, h("a", { class: "btn primary", href: `#/a/${ctx.id}/evidence?finding=${f.id}` }, `Inspect the ${f.supportingCount} reviews behind this`), fbBox));
}

function findingsTab(ctx: Ctx): HTMLElement {
  const { r } = ctx;
  return h("div", null,
    h("p", { class: "muted" }, "A ", term("blind spot", "A recurring complaint supported by several independent reviews that overall ratings or sentiment may hide. One negative review is not a blind spot."), " is flagged only when enough independent reviews support it. Weaker patterns are labelled as hypotheses."),
    r.findings.length ? r.findings.map((f) => findingCard(ctx, f)) : h("div", { class: "card empty" }, h("h2", null, OUTCOME_HEADLINE[r.outcome]), h("p", null, r.outcomeSummary)));
}

// ---------- Evidence explorer ----------
function evidenceTab(ctx: Ctx, query: URLSearchParams): HTMLElement {
  const { r } = ctx;
  let findingId = query.get("finding") ?? "";
  let aspect = query.get("aspect") ?? "";
  let sentiment = query.get("sentiment") ?? "";
  let text = "";
  const list = h("div");
  const head = h("p", { class: "muted", "aria-live": "polite" });
  const draw = () => {
    const f = r.findings.find((x) => x.id === findingId);
    const ids = f ? f.supportingReviewIds : Object.keys(r.evidence);
    const items = ids.map((id) => {
      const ev = r.evidence[id];
      let ms = r.evidenceMentions.filter((m) => m.reviewId === id);
      if (f) ms = ms.filter((m) => m.aspect === f.aspect && m.sentiment === "negative");
      if (aspect) ms = ms.filter((m) => m.aspect === aspect);
      if (sentiment) ms = ms.filter((m) => (m.uncertain ? "uncertain" : m.sentiment) === sentiment);
      return { id, ev, ms };
    }).filter((x) => x.ev && (x.ms.length || (!aspect && !sentiment && !f)) && (!text || x.ev.text.toLowerCase().includes(text.toLowerCase())));
    head.textContent = f ? `Showing ${plural(items.length, "review")} behind “${f.title}”.` : `Showing ${items.length} of ${Object.keys(r.evidence).length} cited reviews. Only reviews used as evidence are stored.`;
    if (!items.length) { list.replaceChildren(h("div", { class: "card empty" }, "No reviews match these filters.")); return; }
    list.replaceChildren(...items.map((x) => reviewCard(ctx, x.id, x.ms, (m) => f
      ? `a clear negative mention in the reviewer's own words: “${m.quote}”.`
      : m.uncertain ? `ambiguous wording (e.g. possible sarcasm), so it is not counted. Detected by the system.` : `detected by the system from “${m.quote}”${m.expectationGap ? "; the reviewer says it did not match what was promised or expected" : ""}.`)));
  };
  const sel = (id: string, label: string, opts: [string, string][], val: string, on: (v: string) => void) =>
    h("div", null, h("label", { for: id }, label), h("select", { id, onchange: (e: Event) => { on((e.target as HTMLSelectElement).value); draw(); } }, opts.map(([v, l]) => h("option", { value: v, selected: v === val }, l))));
  draw();
  return h("div", null,
    h("p", { class: "muted" }, "Every finding traces back to the reviews below. Highlighted words are the wording the judgement is based on."),
    h("div", { class: "filters" },
      h("div", null, h("label", { for: "ev-q" }, "Search review text"), h("input", { type: "search", id: "ev-q", oninput: (e: Event) => { text = (e.target as HTMLInputElement).value; draw(); } })),
      sel("ev-f", "Finding", [["", "All cited reviews"], ...r.findings.map((f) => [f.id, f.title] as [string, string])], findingId, (v) => (findingId = v)),
      sel("ev-a", "Aspect", [["", "Any aspect"], ...r.aspects.map((a) => [a.aspect, a.label] as [string, string])], aspect, (v) => (aspect = v)),
      sel("ev-s", "Sentiment", [["", "Any"], ["negative", "Negative"], ["positive", "Positive"], ["neutral", "Neutral"], ["uncertain", "Ambiguous"]], sentiment, (v) => (sentiment = v))),
    head, list);
}

// ---------- Actions ----------
function actionsTab(ctx: Ctx): HTMLElement {
  const { r } = ctx;
  const card = (x: AnalysisResult["recommendations"][number]) => h("article", { class: "card" },
    h("div", { class: "row between" }, h("h3", { style: "margin:0" }, `${aspectName(r, x.aspect)}: ${x.issue}`), h("span", { class: `pill ${x.priority === "high" ? "blind" : ""}` }, `${x.priority} priority`)),
    h("h4", null, "Suggested action"), h("p", { style: "margin:0" }, x.action),
    h("h4", null, "Why this follows from the evidence"), h("p", { style: "margin:0" }, x.why),
    h("h4", null, "Expected benefit (cautious)"), h("p", { style: "margin:0" }, x.expectedBenefit),
    h("h4", null, "Priority rationale"), h("p", { style: "margin:0" }, x.priorityRationale),
    h("h4", null, "Measure afterwards"), h("p", { style: "margin:0" }, x.measure));
  const backed = r.recommendations.filter((x) => x.evidenceBacked);
  const unconfirmed = r.recommendations.filter((x) => !x.evidenceBacked);
  if (!r.recommendations.length) return h("div", { class: "card empty" }, h("p", null, "No action is recommended. The data doesn't establish a pattern that deserves one."));
  return h("div", null,
    backed.length ? h("section", null, h("h2", null, "Evidence-backed"), backed.map(card)) : null,
    unconfirmed.length ? h("section", null, h("h2", null, "Needs confirmation first"), h("p", { class: "muted" }, "These come from patterns that are still hypotheses. Gather more feedback before acting."), unconfirmed.map(card)) : null,
    h("p", { class: "small muted" }, "BlindSpot AI doesn't generate speculative strategy ideas. Every action above is tied to a finding."));
}

// ---------- Ask ----------
const SUGGESTED = ["What issue appears most frequently?", "Which aspect deserves attention first?", "Why is the overall sentiment positive despite these complaints?", "What are customers praising most?", "Which conclusions have low confidence?", "What additional data would help confirm this pattern?"];
function askTab(ctx: Ctx): HTMLElement {
  const log = h("div", { class: "chat", "aria-live": "polite" });
  const input = h("input", { type: "text", id: "ask-q", maxlength: 300, placeholder: "Ask about this analysis…" });
  const ask = async (question: string) => {
    if (!question.trim()) return;
    log.append(h("div", { class: "msg q" }, question));
    const pending = h("div", { class: "msg a" }, h("span", { class: "spinner" }), "Checking the analysis…");
    log.append(pending);
    try {
      const a = await api.ask(ctx.id, question);
      pending.replaceChildren(h("p", { style: "margin:0 0 6px" }, a.answer),
        a.citations.length ? h("div", { class: "small muted" }, "Evidence: ", a.citations.map((id) => h("a", { href: `#/a/${ctx.id}/evidence?q=${id}`, class: "mono", style: "margin-right:8px", onclick: (e: Event) => { e.preventDefault(); const ev = ctx.r.evidence[id]; if (ev) pending.append(h("div", { class: "quote" }, ev.text, h("div", { class: "small muted" }, id))); } }, id))) : "",
        h("div", { class: "small muted" }, a.basis));
    } catch (e) { pending.replaceChildren(errorBox(e)); }
    (input as HTMLInputElement).value = "";
  };
  return h("div", null,
    h("p", { class: "muted" }, "Answers are assembled from this analysis only. If the data can't support an answer, it says so. Nothing is invented."),
    h("div", { class: "chips" }, SUGGESTED.map((q) => h("button", { class: "chip", type: "button", onclick: () => ask(q) }, q))),
    log,
    h("form", { class: "row", style: "flex-wrap:nowrap", onsubmit: (e: Event) => { e.preventDefault(); ask((input as HTMLInputElement).value); } },
      h("label", { for: "ask-q", class: "small", style: "position:absolute;left:-999px" }, "Your question"), input, h("button", { class: "btn primary", type: "submit" }, "Ask")));
}

function errorBox(e: unknown) {
  return h("div", { class: "error", role: "alert" }, e instanceof ApiError ? e.message : "Something unexpected happened.");
}

// ---------- Page ----------
export async function renderResult(root: HTMLElement, id: string, tab: string, query: URLSearchParams): Promise<void> {
  root.replaceChildren(h("p", null, h("span", { class: "spinner" }), "Loading analysis…"));
  let loaded;
  try { loaded = await api.load(id); } catch (e) {
    root.replaceChildren(errorBox(e), h("p", null, h("a", { class: "btn", href: "#/history" }, "Back to history")));
    return;
  }
  const ctx: Ctx = { id, r: loaded.result, feedback: loaded.feedback };
  const { r } = ctx;
  document.title = `${r.datasetName} · BlindSpot AI`;
  const current = TABS.some(([k]) => k === tab) ? tab : "overview";
  const body = ({ overview: () => overviewTab(ctx), aspects: () => aspectsTab(ctx), findings: () => findingsTab(ctx), evidence: () => evidenceTab(ctx, query), actions: () => actionsTab(ctx), ask: () => askTab(ctx) } as Record<string, () => HTMLElement>)[current]();
  clear(root);
  root.append(
    h("div", { class: "row between" },
      h("div", null, h("h1", { style: "margin:0" }, r.datasetName),
        h("div", { class: "small muted" }, fmtDate(r.createdAt), " · ", r.engine === "llm" ? "AI-assisted extraction" : "offline keyword engine", " · algorithm v", r.version, " · data fingerprint ", h("span", { class: "mono" }, r.datasetHash.slice(0, 8)))),
      h("div", { class: "row" }, h("a", { class: "btn", href: `/api/analyses/${id}/report`, target: "_blank", rel: "noopener" }, "Open report (print to PDF)"), h("a", { class: "btn", href: "#/history" }, "History"))),
    h("section", { class: `card banner ${r.outcome}`, style: "margin-top:16px", "aria-label": "Result" }, h("h2", null, OUTCOME_HEADLINE[r.outcome]), h("p", { style: "margin:0" }, r.outcomeSummary), h("p", { class: "small muted", style: "margin:6px 0 0" }, "Evidence first: these are leads backed by the reviews below. A person makes the final decision.")),
    pipelineStrip(r),
    dataQuality(r),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Analysis sections" }, TABS.map(([k, label]) => h("a", { href: `#/a/${id}/${k}`, role: "tab", "aria-selected": String(k === current), "aria-current": k === current ? "page" : null }, label))),
    body,
  );
}
