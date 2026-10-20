// Offline, deterministic aspect-level sentiment analyser.
// Used (a) as the fallback when the LLM is unavailable and (b) as a transparent baseline.
// It is a heuristic: it is NOT validated against a labelled corpus and will miss irony,
// domain slang and subtle context. Results from this engine are capped at medium confidence.

import { ASPECTS, keywordMatches } from "./taxonomy.ts";
import type { AspectId, ExtractionResult, Mention, Review, Sentiment } from "./types.ts";

const POS: Record<string, number> = {
  great: 2, excellent: 3, amazing: 3, awesome: 3, fantastic: 3, love: 2, loved: 2, loves: 2, perfect: 3,
  good: 1.5, nice: 1, best: 2, happy: 2, pleased: 2, impressed: 2, impressive: 2, recommend: 2, recommended: 2,
  helpful: 2, friendly: 2, polite: 1.5, professional: 1.5, easy: 2, intuitive: 2, smooth: 1.5, fast: 1.5,
  quick: 1.5, quickly: 1.5, prompt: 2, promptly: 2, sturdy: 2, solid: 1.5, durable: 2, clean: 1.5, spotless: 3,
  comfortable: 1.5, reliable: 2, worth: 1.5, bargain: 2, affordable: 1.5, responsive: 1.5, beautiful: 1.5,
  stylish: 1, satisfied: 2, superb: 3, wonderful: 3, lovely: 2, delicious: 2, tasty: 2, flawless: 3,
  gorgeous: 2, brilliant: 2, powerful: 1.5, accurate: 1.5, generous: 1.5, attentive: 2, courteous: 2,
  welcoming: 1.5, neat: 1.5, protected: 1, thorough: 1.5, stable: 1.5, seamless: 2, effortless: 2, straightforward: 1.5, fine: 0.5,
  decent: 1, pleasant: 1.5, enjoyed: 2, enjoy: 1.5, thanks: 1, helped: 1.5, secure: 1, safe: 1,
};

const NEG: Record<string, number> = {
  bad: -1.5, poor: -2, terrible: -3, awful: -3, horrible: -3, worst: -3, worse: -2, disappointing: -2,
  disappointed: -2, disappointment: -2, hate: -2.5, hated: -2.5, useless: -3, unusable: -3, broke: -2.5,
  broken: -2.5, breaks: -2, dies: -2, died: -2.5, dead: -2, fails: -2, failed: -2.5, failure: -2, crash: -2,
  crashes: -2, crashed: -2.5, freezes: -2, froze: -2, glitchy: -2, buggy: -2, defective: -3, faulty: -2.5,
  dirty: -2.5, filthy: -3, smelly: -2, stained: -2, rude: -2.5, unhelpful: -2.5, ignored: -2, ignores: -2,
  slow: -1.5, slowly: -1, late: -2, delayed: -2, delay: -1.5, lost: -2, damaged: -2.5, dented: -2, crushed: -2,
  leaking: -2, flimsy: -2.5, overpriced: -2.5, expensive: -1, pricey: -1, confusing: -2, complicated: -1.5,
  difficult: -1.5, clunky: -2, laggy: -2, lag: -1.5, sluggish: -2, noisy: -1.5, loud: -1, unreliable: -2.5,
  inconsistent: -2, unpredictable: -1.5, mediocre: -1.5, meh: -1, annoying: -2, frustrating: -2.5,
  frustrated: -2.5, waste: -2.5, scam: -3, fake: -2.5, misleading: -2, missing: -1.5, wrong: -2, problem: -1.5,
  problems: -1.5, issue: -1.5, issues: -1.5, complaint: -1.5, unacceptable: -3, disgusting: -3, poorly: -2,
  lacking: -1.5, unprofessional: -2.5, careless: -2, stale: -2, burnt: -2, undercooked: -2, sticky: -1.5,
  stuck: -1.5, drains: -2, drain: -1.5, uncomfortable: -2, unstable: -2, tedious: -1.5, ripoff: -3,
  smell: -1, smells: -1.5, hassle: -1.5, nightmare: -3, struggled: -1.5, struggle: -1.5, struggling: -1.5,
};

const STRONG_NEG = new Set([
  "terrible", "awful", "horrible", "worst", "useless", "unusable", "disgusting", "scam", "ripoff", "nightmare",
  "unacceptable", "filthy", "defective", "dangerous", "unsafe",
]);

const NEGATORS = new Set([
  "not", "no", "never", "dont", "doesnt", "didnt", "isnt", "wasnt", "arent", "werent", "cant", "cannot",
  "couldnt", "wont", "wouldnt", "shouldnt", "hardly", "barely", "without", "neither", "nor", "nothing",
]);
const INTENSIFIERS = new Set(["very", "really", "extremely", "so", "super", "absolutely", "incredibly", "totally", "utterly", "completely"]);
const DIMINISHERS = new Set(["slightly", "somewhat", "kinda", "fairly", "bit", "little", "occasionally", "sometimes"]);

const PHRASES: [RegExp, number][] = [
  [/(gets?|got|getting|runs?|running|becomes?|heats? up) (very |too |really |extremely |quite )?(hot|warm)|overheat\w*|heats? up|too hot/, -2.5],
  [/charg(es|ing) (is |was |feels? )?(very |really |so |too )?(slow|slowly|painfully slow)|slow charg\w*/, -2.5],
  [/stopped working|quit working|stops working/, -3],
  [/doesn'?t work|does not work|didn'?t work|not working|won'?t (turn on|start|charge|connect|pair)/, -3],
  [/waste of (money|time)/, -3],
  [/not worth( it| the)?( money| price| cost)?/, -2.5],
  [/too (expensive|pricey|slow|loud|small|complicated|hard|long)/, -2],
  [/cheaply made|poorly made|poorly built|badly made|falls? apart/, -3],
  [/hard to (use|follow|navigate|understand|set ?up|find)/, -2],
  [/easy to (use|set ?up|follow|navigate|understand|install|clean)/, 2],
  [/never (arrived|came|showed up|replied|responded|answered)/, -3],
  [/(did ?n'?t|did not|never) (reply|respond|answer|call back|get back)/, -3],
  [/(took|taking|takes) (forever|ages|too long|weeks)/, -2.5],
  [/long wait|waited (a long time|forever|over|nearly|almost)|wait(ed)? (for )?(an hour|\d+ ?(min|mins|minutes|hours?))/, -2],
  [/could (have been|be) better/, -1],
  [/not bad/, 1],
  [/highly recommend/, 3],
  [/value for money|good value|great value|worth every/, 2],
  [/(came|arrived|delivered) (early|on time|quickly|fast|promptly)/, 2],
  [/(arrived|came) (late|damaged|broken|crushed|dented|open)/, -2.5],
  [/battery (life )?(is |was )?(poor|bad|terrible|awful|short|weak|drains?|dies|died)|battery (barely )?lasts?/, -3],
  [/(no|zero) (response|reply|help|support)/, -2.5],
  [/lasts? (only )?(a few|\d+) ?(hours?|h)\b/, -2.5],
];

const SARCASM: RegExp[] = [
  /yeah,? right/,
  /\boh,? (great|wonderful|fantastic|perfect|joy|lovely)/,
  /(great|perfect|fantastic|wonderful)[.,!… ]+(another|more|just what)/,
  /thanks for nothing/,
  /just what i (needed|wanted|always wanted)/,
  /["“](great|helpful|fast|quick|friendly|excellent|premium|reliable|luxury)["”]/,
  /love how (it|they|you|the)/,
  /\bsure\b[.,!… ]*(because|that'?s totally)/,
];

const EXPECTATION_GAP =
  /not as (described|advertised|expected|promised|pictured|shown)|advertised|promised|supposed to|was told|they claim|claimed|misleading|looks? nothing like|different from (the )?(photos?|pictures?|description|listing)|expected (more|better|much)|expected it to|i expected|thought it would|unlike what/;

const INJECTION_LIKE =
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?)|disregard .{0,40}instructions|system prompt|you are (now )?(an? |the )?(ai|assistant|language model)|reveal .{0,30}(prompt|api key|secret)|as an ai|\bbegin (system|instructions)\b/i;

/** Keywords that are too generic to decide an aspect when a clause also matches a more specific one. */
const WEAK_KEYWORDS = new Set([
  "slow", "fast", "loud", "runs", "smooth", "late", "waited", "wait time", "looks", "feels", "design", "money", "cost*",
  "charge*", "stopped", "dead", "inconsistent", "box", "finish", "build", "server", "agent", "manager", "response", "replied",
  "responsive", "wrapped", "clean*", "sticky", "worth", "fee*", "cheap", "stained", "stain*",
]);

export function looksLikeInjection(text: string): boolean {
  return INJECTION_LIKE.test(text);
}

export function splitClauses(text: string): string[] {
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/);
  const out: string[] = [];
  for (const s of sentences) {
    const parts = s.split(/\s+(?:but|however|although|though|yet|whereas|except that)\s+|,\s+(?=(?:and\s+)?(?:the|their|its|it|my|our|customer|delivery|service|battery|price|staff)\b)/i);
    for (const p of parts) {
      const t = p.trim();
      if (t.length > 1) out.push(t);
    }
  }
  return out;
}

interface ClauseScore {
  score: number;
  pos: number;
  neg: number;
  strong: boolean;
}

export function scoreClause(clause: string): ClauseScore {
  let text = clause.toLowerCase().replace(/[’‘]/g, "'");
  let score = 0;
  let pos = 0;
  let neg = 0;
  let strong = false;

  for (const [re, w] of PHRASES) {
    const m = text.match(re);
    if (m) {
      score += w;
      if (w > 0) pos += w;
      else {
        neg += -w;
        if (w <= -3) strong = true;
      }
      text = text.replace(re, " ");
    }
  }

  const tokens = (text.replace(/n't/g, "nt").match(/[a-z]+/g) ?? []) as string[];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let w = POS[t] ?? NEG[t];
    if (w === undefined) continue;
    const prev = tokens.slice(Math.max(0, i - 3), i);
    const negated = prev.some((p) => NEGATORS.has(p));
    if (negated) w = w > 0 ? -w * 0.8 : -w * 0.6;
    else if (prev.length && INTENSIFIERS.has(prev[prev.length - 1])) w *= 1.4;
    else if (prev.length && DIMINISHERS.has(prev[prev.length - 1])) w *= 0.5;
    score += w;
    if (w > 0) pos += w;
    else {
      neg += -w;
      if (!negated && STRONG_NEG.has(t)) strong = true;
    }
  }
  return { score, pos, neg, strong };
}

function matchAspects(clause: string): AspectId[] {
  // A battery comment is one issue; counting it under both Performance and Reliability would double-count it.
  if (/\bbatter(y|ies)\b/i.test(clause)) return ["performance"];
  const hits = new Map<AspectId, { strong: number; weak: number }>();
  for (const a of ASPECTS) {
    for (const k of a.keywords) {
      if (keywordMatches(clause, k)) {
        const h = hits.get(a.id) ?? { strong: 0, weak: 0 };
        if (WEAK_KEYWORDS.has(k)) h.weak++;
        else h.strong++;
        hits.set(a.id, h);
      }
    }
  }
  const anyStrong = [...hits.values()].some((h) => h.strong > 0);
  const ids: AspectId[] = [];
  for (const [id, h] of hits) {
    if (h.strong > 0 || !anyStrong) ids.push(id);
  }
  return ids;
}

function toSentiment(score: number): Sentiment {
  if (score >= 1) return "positive";
  if (score <= -1) return "negative";
  return "neutral";
}

export function analyzeReviewOffline(review: Review): { mentions: Mention[]; overall: Sentiment; injectionLike: boolean } {
  const clauses = splitClauses(review.text);
  const mentions: Mention[] = [];
  let total = 0;
  for (const clause of clauses) {
    const cs = scoreClause(clause);
    total += cs.score;
    const aspects = matchAspects(clause);
    if (aspects.length === 0) continue;
    const lower = clause.toLowerCase();
    const sarcasm = SARCASM.some((re) => re.test(lower));
    const mixed = cs.pos > 0 && cs.neg > 0 && Math.abs(cs.score) < 1;
    const uncertain = sarcasm || mixed;
    const sentiment = uncertain ? "neutral" : toSentiment(cs.score);
    const severity: 1 | 2 | 3 = cs.strong || cs.score <= -3.5 ? 3 : cs.score <= -1.8 ? 2 : 1;
    for (const aspect of aspects.slice(0, 2)) {
      mentions.push({
        reviewId: review.id,
        aspect,
        sentiment,
        severity: sentiment === "negative" ? severity : 1,
        quote: clause.slice(0, 280),
        uncertain,
        expectationGap: sentiment === "negative" && EXPECTATION_GAP.test(lower),
      });
    }
  }
  return { mentions, overall: toSentiment(total / Math.max(1, Math.sqrt(clauses.length))), injectionLike: looksLikeInjection(review.text) };
}

export function analyzeOffline(reviews: Review[], extraNotes: string[] = []): ExtractionResult {
  const mentions: Mention[] = [];
  const overall: Record<string, Sentiment> = {};
  const engineByReview: Record<string, "offline"> = {};
  let injections = 0;
  for (const r of reviews) {
    const res = analyzeReviewOffline(r);
    mentions.push(...res.mentions);
    overall[r.id] = res.overall;
    engineByReview[r.id] = "offline";
    if (res.injectionLike) injections++;
  }
  const notes = [...extraNotes];
  if (injections > 0) {
    notes.push(`${injections} review${injections === 1 ? "" : "s"} contained instruction-like text. It was analysed as ordinary review wording and never followed.`);
  }
  return { mentions, overall, engine: "offline", engineByReview, notes };
}
