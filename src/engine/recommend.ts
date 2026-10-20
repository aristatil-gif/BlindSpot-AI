import { aspectLabel } from "./taxonomy.ts";
import type { AspectId, Finding, Recommendation } from "./types.ts";

const ACTIONS: Record<AspectId, { action: string; measure: string }> = {
  quality: { action: "Inspect the items or batches named in the reviews and check what customers expected against what was delivered.", measure: "Share of new reviews that criticise quality; return rate for the affected product." },
  value: { action: "Review how the price is presented against what is included, and check whether the complaints concern price itself or unmet expectations.", measure: "Share of new reviews mentioning price negatively." },
  delivery: { action: "Look at fulfilment records for the periods the reviewers mention and compare promised vs actual delivery times.", measure: "On-time delivery rate and share of new reviews complaining about delivery." },
  service: { action: "Review how the cited support interactions were handled and check response times and staffing in the relevant periods.", measure: "First-response time and share of new reviews criticising service." },
  reliability: { action: "Collect the failure details in the cited reviews (when, how often, which version) and test whether they can be reproduced.", measure: "Failure-related support contacts and share of new reviews reporting failures." },
  usability: { action: "Watch a few new users go through setup or first use to see where they struggle, starting with the steps the reviews mention.", measure: "Setup completion rate and share of new reviews mentioning difficulty." },
  cleanliness: { action: "Audit cleaning routines for the areas and times mentioned in the reviews.", measure: "Cleanliness audit scores and share of new reviews criticising cleanliness." },
  packaging: { action: "Check packaging and handling for the damage described, and compare it with damage rates in shipping records.", measure: "Damage-in-transit rate and share of new reviews mentioning packaging." },
  performance: { action: "Reproduce the slowness or performance problems described, starting with the conditions reviewers mention.", measure: "Performance benchmarks under the reported conditions; share of new reviews mentioning speed or lag." },
};

export function buildRecommendations(findings: Finding[]): Recommendation[] {
  const recs: Recommendation[] = findings.map((f) => {
    const a = ACTIONS[f.aspect];
    const priority: Recommendation["priority"] =
      f.kind === "blind_spot" && f.scorecard.score >= 70 ? "high" : f.kind === "blind_spot" ? "medium" : f.kind === "recurring_issue" ? "medium" : "low";
    return {
      id: f.recommendationId,
      findingId: f.id,
      evidenceBacked: f.kind !== "hypothesis",
      aspect: f.aspect,
      issue: f.title,
      action: f.kind === "hypothesis" ? `Before acting, gather more feedback about ${aspectLabel(f.aspect).toLowerCase()}. Then: ${a.action}` : a.action,
      why: `${f.supportingCount} independent reviews are involved (score ${f.scorecard.score}/100). ${f.kind === "hypothesis" ? "Evidence is limited, so confirming it comes first." : ""}`.trim(),
      expectedBenefit: "If the cause is found and fixed, fewer complaints about this aspect are plausible. Review text alone cannot show how much this would change satisfaction, sales or retention.",
      priority,
      priorityRationale:
        priority === "high" ? "Strong evidence, widespread and hidden by the overall picture."
        : priority === "medium" ? "Evidence supports it, but it is smaller, milder or already visible."
        : "Evidence is limited; confirm before committing effort.",
      measure: a.measure,
    };
  });
  const rank = { high: 0, medium: 1, low: 2 };
  return recs.sort((x, y) => rank[x.priority] - rank[y.priority]);
}
