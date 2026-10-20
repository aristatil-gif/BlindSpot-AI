import type { AspectId } from "./types.ts";

export interface AspectDef {
  id: AspectId;
  label: string;
  /** Lower-case keywords/stems. A stem ending in * matches any suffix. */
  keywords: string[];
}

export const ASPECTS: AspectDef[] = [
  {
    id: "quality",
    label: "Product quality",
    keywords: ["quality", "build", "material*", "constructed", "construction", "sturdy", "flimsy", "cheaply made", "stitching", "durab*", "finish", "design", "looks", "feels", "camera", "display", "screen"],
  },
  {
    id: "value",
    label: "Price & value",
    keywords: ["price*", "pricey", "expensive", "cheap", "cost*", "value", "worth", "overpriced", "afford*", "money", "bargain", "fee*", "charge*"],
  },
  {
    id: "delivery",
    label: "Delivery",
    keywords: ["deliver*", "shipping", "shipped", "arrived", "arrive", "courier", "late", "dispatch*", "tracking", "transit", "wait time", "waited"],
  },
  {
    id: "service",
    label: "Customer service",
    keywords: ["service", "support", "staff", "customer care", "representative", "agent", "refund*", "helpdesk", "waiter", "waitress", "server", "manager", "reception", "rude", "helpful", "replied", "response", "slow service"],
  },
  {
    id: "reliability",
    label: "Reliability",
    keywords: ["reliab*", "broke", "broken", "stopped working", "failed", "failure", "crash*", "defect*", "faulty", "malfunction*", "died", "dead", "inconsistent", "intermittent", "stopped", "glitch*", "bug*", "overheat*", "heating", "heats", "gets hot", "get hot", "too hot", "very hot", "runs hot", "warm up"],
  },
  {
    id: "usability",
    label: "Usability",
    keywords: ["easy to use", "hard to use", "intuitive", "confusing", "onboarding", "setup", "set up", "interface", "instructions", "learning curve", "user friendly", "user-friendly", "navigate", "complicated", "straightforward", "usab*"],
  },
  {
    id: "cleanliness",
    label: "Cleanliness",
    keywords: ["clean*", "dirty", "filthy", "dust*", "stain*", "smell*", "hygien*", "spotless", "mold", "mould", "sticky"],
  },
  {
    id: "packaging",
    label: "Packaging",
    keywords: ["packag*", "box", "wrapped", "wrapping", "sealed", "bubble wrap", "crushed", "dented"],
  },
  {
    id: "performance",
    label: "Performance",
    keywords: ["perform*", "fast", "slow", "speed", "lag*", "responsive", "powerful", "sluggish", "loud", "noisy", "runs", "smooth", "battery", "charging", "laggy"],
  },
];

export const ASPECT_IDS: AspectId[] = ASPECTS.map((a) => a.id);

export function aspectLabel(id: AspectId): string {
  return ASPECTS.find((a) => a.id === id)?.label ?? id;
}

export function isAspectId(x: unknown): x is AspectId {
  return typeof x === "string" && (ASPECT_IDS as string[]).includes(x);
}

/** Does the (lower-cased) token/phrase list match the keyword? */
export function keywordMatches(text: string, keyword: string): boolean {
  const lower = text.toLowerCase();
  if (keyword.endsWith("*")) {
    const stem = keyword.slice(0, -1);
    return new RegExp(`\\b${escapeRe(stem)}\\w*`, "i").test(lower);
  }
  return new RegExp(`\\b${escapeRe(keyword)}\\b`, "i").test(lower);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
