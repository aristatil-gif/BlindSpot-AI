// "Ask BlindSpot AI": answers are assembled only from an existing AnalysisResult, never from free generation,
// so every number and quote comes from the analysed data. Unsupported questions get an honest refusal.

import { ASPECTS, aspectLabel } from "./taxonomy.ts";
import type { AnalysisResult, AspectId } from "./types.ts";

export interface Answer {
  answer: string;
  citations: string[]; // review ids that back the answer
  basis: string; // how the answer was derived
}

export const SUGGESTED_QUESTIONS = [
  "What issue appears most frequently?",
  "Which aspect deserves attention first?",
  "Why is the overall sentiment positive despite these complaints?",
  "What are customers praising most?",
  "Which conclusions have low confidence?",
  "What additional data would help confirm this pattern?",
];

function mentionedAspect(q: string): AspectId | null {
  const s = q.toLowerCase();
  for (const a of ASPECTS) {
    if (s.includes(a.label.toLowerCase()) || s.includes(a.id)) return a.id;
    if (a.keywords.some((k) => !k.endsWith("*") && k.length > 4 && new RegExp(`\\b${k}\\b`).test(s))) return a.id;
  }
  return null;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

export function ask(result: AnalysisResult, question: string): Answer {
  const q = question.toLowerCase().trim();
  const basis = "Computed from this analysis only.";
  if (!q) return { answer: "Type a question about this analysis.", citations: [], basis };

  if (result.outcome === "insufficient_data") {
    return {
      answer: `There are only ${result.overall.reviews} usable reviews, which is not enough to answer pattern questions reliably. Adding more reviews (ideally 20 or more, with dates) would make this possible.`,
      citations: [], basis,
    };
  }

  const aspectAsked = mentionedAspect(q);
  const byNeg = [...result.aspects].filter((a) => a.negative > 0).sort((a, b) => b.negative - a.negative);
  const byPos = [...result.aspects].filter((a) => a.positive > 0).sort((a, b) => b.positive - a.positive);

  if (/evidence|proof|show.*(review|quote)|which reviews|quotes?/.test(q)) {
    const f = result.findings.find((x) => x.aspect === aspectAsked) ?? (aspectAsked ? undefined : result.findings[0]);
    const stat = aspectAsked ? result.aspects.find((a) => a.aspect === aspectAsked) : undefined;
    const ids = f ? f.supportingReviewIds.slice(0, 4) : stat ? stat.representative.negative.slice(0, 4) : [];
    if (!ids.length) return { answer: "There is no finding or complaint evidence to show for that. Try naming an aspect that appears in the Aspects tab.", citations: [], basis };
    const quotes = ids.map((id) => {
      const m = result.evidenceMentions.find((x) => x.reviewId === id && (!f || x.aspect === f.aspect) && x.sentiment === "negative");
      return m ? `“${m.quote}”` : null;
    }).filter(Boolean);
    return { answer: `Here are ${ids.length} of the ${f?.supportingCount ?? "relevant"} reviews behind ${f ? `“${f.title}”` : "this aspect"}: ${quotes.join(" ")}`, citations: ids, basis: "Verbatim quotes from the Evidence Explorer data." };
  }

  if (/low confidence|uncertain|least (sure|certain)|not sure|doubt/.test(q)) {
    const low = result.findings.filter((f) => f.confidence === "low");
    const lowAspects = result.aspects.filter((a) => a.confidence === "low");
    if (!low.length && !lowAspects.length) return { answer: "None of the findings or aspects is rated low confidence. Offline keyword analysis is still capped at medium confidence.", citations: [], basis };
    const parts = [
      ...low.map((f) => `“${f.title}” (${f.supportingCount} reviews): ${f.confidenceReason}`),
      ...(lowAspects.length ? [`Aspects with few mentions: ${lowAspects.map((a) => `${a.label} (${a.reviews})`).join(", ")}.`] : []),
    ];
    return { answer: parts.join(" "), citations: [], basis };
  }

  if (/more data|additional|confirm|what (else|should)|improve (the )?(analysis|confidence)/.test(q)) {
    const tips: string[] = [];
    if (result.quality.withDate < result.quality.usableReviews * 0.6) tips.push("review dates, so changes over time can be assessed");
    if (result.quality.withRating < result.quality.usableReviews * 0.6) tips.push("star ratings, so hidden complaints can be compared with ratings");
    if (result.overall.reviews < 30) tips.push(`more reviews (you have ${result.overall.reviews}; 30 or more gives steadier patterns)`);
    tips.push("source or product-version information, to separate real differences from noise");
    const f = result.findings[0];
    return { answer: `To firm up ${f ? `“${f.title}”` : "the analysis"}, it would help to add: ${tips.join("; ")}.`, citations: [], basis };
  }

  if (/prais|like most|love|strength|best|positive aspects?/.test(q) && !/why/.test(q)) {
    if (!byPos.length) return { answer: "No aspect has clearly positive mentions in this data.", citations: [], basis };
    const top = byPos.slice(0, 3);
    return {
      answer: `Most-praised aspects: ${top.map((a) => `${a.label} (${a.positive} reviews positive${a.positiveShare !== null ? `, ${pct(a.positiveShare)} of mentions` : ""})`).join("; ")}.`,
      citations: top.flatMap((a) => a.representative.positive.slice(0, 1)), basis,
    };
  }

  if (/why.*(positive|rating|healthy|good|high|overall)|despite|masked|hidden/.test(q)) {
    const f = result.findings.find((x) => x.kind === "blind_spot") ?? result.findings[0];
    if (!f) return { answer: `${result.overall.healthBasis} No recurring complaint is large enough to be hidden by it, so there is nothing to explain.`, citations: [], basis };
    return {
      answer: `${result.overall.healthBasis} Yet ${f.supportingCount} of ${result.overall.reviews} reviews criticise ${aspectLabel(f.aspect).toLowerCase()}. ${f.scorecard.components.find((c) => c.key === "hiddenness")?.detail ?? ""} Averages blend many aspects together, so a problem affecting a minority can disappear in them. This is an interpretation, not a proven cause.`,
      citations: f.supportingReviewIds.slice(0, 3), basis,
    };
  }

  if (/first|priorit|attention|deserve|focus|fix|start/.test(q)) {
    const r = result.recommendations[0];
    if (!r) return { answer: "No recommendation is warranted yet: the data does not establish a pattern that deserves action.", citations: [], basis };
    const f = result.findings.find((x) => x.id === r.findingId);
    return { answer: `${aspectLabel(r.aspect)} comes first (${r.priority} priority): ${r.priorityRationale} Suggested action: ${r.action} Measure afterwards: ${r.measure}`, citations: f?.supportingReviewIds.slice(0, 3) ?? [], basis };
  }

  if (/trend|increas|worse|getting|over time|recent|change/.test(q)) {
    const dated = result.aspects.filter((a) => a.trend.status !== "insufficient");
    if (!dated.length) return { answer: `Changes over time cannot be assessed. ${result.aspects[0]?.trend.reason ?? "Not enough dated reviews."}`, citations: [], basis };
    return { answer: dated.map((a) => `${a.label}: ${a.trend.status}. ${a.trend.reason}`).join(" "), citations: [], basis };
  }

  if (/frequent|common|most|main|biggest|top|issue|problem|complain/.test(q) || aspectAsked) {
    const pool = aspectAsked ? byNeg.filter((a) => a.aspect === aspectAsked) : byNeg;
    if (!pool.length) return { answer: aspectAsked ? `No clear complaints about ${aspectLabel(aspectAsked).toLowerCase()} were found.` : "No aspect has clear negative mentions in this data.", citations: [], basis };
    const top = pool.slice(0, 3);
    return {
      answer: `${aspectAsked ? "" : "Most-mentioned complaints: "}${top.map((a) => `${a.label}: ${a.negative} reviews negative of ${a.reviews} that mention it`).join("; ")}.${result.findings.length ? "" : " None of these reaches the threshold of a pattern."}`,
      citations: top.flatMap((a) => a.representative.negative.slice(0, 1)), basis,
    };
  }

  return {
    answer: `${result.outcomeSummary} I can only answer from this analysis. Try asking about the most frequent issue, what customers praise, what to fix first, or which conclusions have low confidence.`,
    citations: [], basis,
  };
}
