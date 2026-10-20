import { api, ApiError, type HistoryRow, type Sample, type Status } from "./api.ts";
import { clear, confirmDialog, fmtDate, h, logo, pct, plural, toast } from "./dom.ts";
import { OUTCOME_LABEL, renderResult } from "./results.ts";

const main = document.getElementById("main") as HTMLElement;
document.getElementById("brand")!.append(logo(30), "BlindSpot AI");

const nav = document.getElementById("nav")!;
const menuBtn = document.getElementById("menu-btn")!;
menuBtn.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", String(open));
});

let statusCache: Status | null = null;
const getStatus = async () => (statusCache ??= await api.status());

function setNav(active: string) {
  nav.querySelectorAll("a").forEach((a) => {
    if (a.dataset.nav === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  nav.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
}

function errorBox(e: unknown, hint?: string) {
  const msg = e instanceof ApiError ? e.message : "Something unexpected happened.";
  return h("div", { class: "error", role: "alert" }, h("strong", null, msg), hint ? h("p", { class: "small", style: "margin:.4em 0 0" }, hint) : null);
}

// ---------- New analysis ----------
async function viewNew() {
  setNav("new");
  document.title = "New analysis · BlindSpot AI";
  let status: Status;
  let samples: Sample[] = [];
  try {
    [status, samples] = await Promise.all([getStatus(), api.samples()]);
  } catch (e) {
    main.replaceChildren(errorBox(e, "Reload the page once the server is running."));
    return;
  }

  type Src = "sample" | "csv" | "manual";
  let src: Src = "sample";
  let sampleId = samples[0]?.id ?? "";
  let csvText = "";
  let csvName = "";
  const nameInput = h("input", { type: "text", id: "ds-name", maxlength: 100, placeholder: "e.g. Spring product reviews" });
  const modeSel = h("select", { id: "mode" }, h("option", { value: "auto" }, status.llmAvailable ? "Automatic (AI-assisted)" : "Automatic (offline keyword engine)"), h("option", { value: "offline" }, "Offline keyword engine only"));
  const manual = h("textarea", { id: "manual", placeholder: "Paste one review per line.\nThe delivery was quick but the battery died after two hours.\nGreat value for the price.", "aria-describedby": "manual-help" });
  const fileInfo = h("p", { class: "small muted", id: "file-info" }, "No file chosen.");
  const fileInput = h("input", { type: "file", id: "csv-file", accept: ".csv,.txt,text/csv,text/plain", onchange: async () => {
    const f = (fileInput as HTMLInputElement).files?.[0];
    csvText = ""; csvName = "";
    if (!f) { fileInfo.textContent = "No file chosen."; return; }
    if (!/\.(csv|txt)$/i.test(f.name)) { fileInfo.textContent = "Please choose a .csv file."; return; }
    if (f.size > status.maxCsvChars) { fileInfo.textContent = `That file is ${(f.size / 1e6).toFixed(1)} MB. The limit is about 1 MB.`; return; }
    csvText = await f.text();
    csvName = f.name.replace(/\.(csv|txt)$/i, "");
    fileInfo.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB) is ready.`;
  } });
  const sampleList = h("div", { role: "radiogroup", "aria-label": "Sample datasets" }, samples.map((s, i) => {
    const id = `smp-${s.id}`;
    return h("label", { class: "rev", for: id, style: "display:block;cursor:pointer;font-weight:400" },
      h("input", { type: "radio", name: "sample", id, value: s.id, checked: i === 0, onchange: () => (sampleId = s.id) }), " ",
      h("strong", null, s.name), h("div", { class: "small muted" }, s.description));
  }));

  const panes: Record<Src, HTMLElement> = {
    sample: h("div", null, h("p", { class: "small muted" }, "These are fictional, generated datasets for trying the tool. They are not real customer reviews."), sampleList),
    csv: h("div", null,
      h("label", { for: "csv-file" }, "CSV file"), fileInput, fileInfo,
      h("p", { class: "small muted" }, "Needs a header row and a column named ", h("code", null, "review"), " (or text, comment, feedback). Optional columns: ", h("code", null, "rating"), ", ", h("code", null, "date"), " (use 2025-03-14), ", h("code", null, "source"), ", ", h("code", null, "url"), ". Up to ", status.maxReviews.toString(), " reviews and about 1 MB.")),
    manual: h("div", null, h("label", { for: "manual" }, "Reviews"), manual, h("p", { class: "small muted", id: "manual-help" }, "One review per line. Without ratings or dates, hidden complaints are judged from wording and changes over time can't be assessed.")),
  };
  const tabBtns: Record<Src, HTMLElement> = {} as Record<Src, HTMLElement>;
  const paneHost = h("div");
  const show = (s: Src) => {
    src = s;
    paneHost.replaceChildren(panes[s]);
    (Object.keys(tabBtns) as Src[]).forEach((k) => tabBtns[k].setAttribute("aria-selected", String(k === s)));
  };
  (["sample", "csv", "manual"] as Src[]).forEach((k) => {
    tabBtns[k] = h("button", { type: "button", role: "tab", onclick: () => show(k) }, { sample: "Try a sample", csv: "Upload CSV", manual: "Paste reviews" }[k]);
  });

  const out = h("div", { "aria-live": "polite" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Analyse reviews");
  const form = h("form", { class: "card", novalidate: true, onsubmit: async (ev: Event) => {
    ev.preventDefault();
    const body: Record<string, unknown> = { source: src, name: (nameInput as HTMLInputElement).value, mode: (modeSel as HTMLSelectElement).value };
    if (src === "sample") body.sampleId = sampleId;
    else if (src === "csv") {
      if (!csvText) { out.replaceChildren(errorBox(new ApiError("Choose a CSV file first."), "A CSV with a header row and a review column works best.")); return; }
      body.csv = csvText;
      if (!body.name) body.name = csvName;
    } else body.text = (manual as HTMLTextAreaElement).value;
    (go as HTMLButtonElement).disabled = true;
    out.replaceChildren(h("p", null, h("span", { class: "spinner" }), "Reading reviews, finding aspects and checking the evidence…"));
    try {
      const r = await api.analyze(body);
      location.hash = `#/a/${r.id}`;
    } catch (e) {
      out.replaceChildren(errorBox(e, "Nothing was saved. You can fix the input and try again."));
      (go as HTMLButtonElement).disabled = false;
    }
  } },
    h("div", { class: "tabs", role: "tablist" }, tabBtns.sample, tabBtns.csv, tabBtns.manual),
    paneHost,
    h("div", { class: "cols", style: "margin-top:14px" },
      h("div", null, h("label", { for: "ds-name" }, "Name this analysis (optional)"), nameInput),
      h("div", null, h("label", { for: "mode" }, "Analysis engine"), modeSel)),
    h("p", { class: "small muted" }, status.llmAvailable
      ? "AI-assisted mode sends review text to an external AI service to extract aspects. Scoring and conclusions are computed on this server by fixed rules. Choose “offline” to keep text on this server."
      : "No AI service is configured here, so the offline keyword engine is used. It is transparent but simple, and its confidence is capped at medium."),
    h("div", { class: "row" }, go),
    out,
  );
  show("sample");

  main.replaceChildren(
    h("section", { class: "hero" },
      h("h1", null, "Your average rating isn't telling you everything."),
      h("p", null, "BlindSpot AI reads a batch of customer reviews and looks for recurring problems hiding behind good scores, then shows the exact reviews behind each finding and how sure it is."),
      h("ol", { class: "steps five" },
        h("li", null, h("strong", null, "Sentiment"), h("span", null, "How positive or negative is each review?")),
        h("li", null, h("strong", null, "Aspects"), h("span", null, "What do people talk about: camera, battery, service?")),
        h("li", null, h("strong", null, "Patterns"), h("span", null, "Which problems repeat across reviews?")),
        h("li", null, h("strong", null, "Blind spots"), h("span", null, "Which repeating problems does the overall score hide?")),
        h("li", null, h("strong", null, "Insights"), h("span", null, "What should a person look at first?"))),
      h("p", { class: "small muted" }, h("strong", null, "Evidence first."), " Every finding comes with the reviews behind it, and a person makes the final decision."),
    ),
    form,
  );
}

// ---------- History ----------
async function viewHistory() {
  setNav("history");
  document.title = "History · BlindSpot AI";
  main.replaceChildren(h("p", null, h("span", { class: "spinner" }), "Loading…"));
  let rows: HistoryRow[];
  try { rows = await api.history(); } catch (e) { main.replaceChildren(errorBox(e)); return; }
  const list = h("div");
  const draw = () => {
    if (!rows.length) {
      list.replaceChildren(h("div", { class: "card empty" }, h("p", null, "No analyses yet."), h("a", { class: "btn primary", href: "#/new" }, "Start your first analysis")));
      return;
    }
    list.replaceChildren(...rows.map((r) => h("div", { class: "card" },
      h("div", { class: "row between" },
        h("div", null,
          h("h3", { style: "margin:0" }, h("a", { href: `#/a/${r.id}` }, r.name)),
          h("div", { class: "small muted" }, fmtDate(r.createdAt), " · ", plural(r.reviews, "review"), " · ", r.engine === "llm" ? "AI-assisted" : "offline engine", " · engine v", r.version, " · data fingerprint ", h("span", { class: "mono" }, r.datasetHash.slice(0, 8)))),
        h("div", { class: "row" },
          h("span", { class: `pill ${r.outcome === "blind_spot_detected" ? "blind" : ""}` }, OUTCOME_LABEL[r.outcome] ?? r.outcome),
          h("a", { class: "btn small", href: `#/a/${r.id}` }, "Open"),
          h("button", { class: "btn small", type: "button", onclick: async () => {
            if (!(await confirmDialog("Delete this analysis?", `“${r.name}” and its stored evidence will be removed permanently.`, "Delete"))) return;
            try { await api.remove(r.id); rows = rows.filter((x) => x.id !== r.id); draw(); toast("Analysis deleted."); } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't delete."); }
          } }, "Delete"))),
      h("p", { class: "small", style: "margin:8px 0 0" }, r.summary))));
  };
  draw();
  main.replaceChildren(h("h1", null, "Analysis history"), h("p", { class: "muted" }, "Each run records its settings, engine version and a data fingerprint so you can tell exactly what produced a result. Only the reviews cited as evidence are stored, not the whole dataset."), list);
}

// ---------- Compare ----------
async function viewCompare() {
  setNav("compare");
  document.title = "Compare · BlindSpot AI";
  let rows: HistoryRow[];
  try { rows = await api.history(); } catch (e) { main.replaceChildren(errorBox(e)); return; }
  const head = h("h1", null, "Compare two datasets");
  if (rows.length < 2) {
    main.replaceChildren(head, h("div", { class: "card empty" }, h("p", null, "You need at least two saved analyses to compare. Run one for each product or business first."), h("a", { class: "btn primary", href: "#/new" }, "New analysis")));
    return;
  }
  const opts = () => rows.map((r) => h("option", { value: r.id }, `${r.name} (${r.reviews})`));
  const a = h("select", { id: "cmp-a" }, opts());
  const b = h("select", { id: "cmp-b" }, opts());
  (b as HTMLSelectElement).selectedIndex = 1;
  const out = h("div", { "aria-live": "polite" });
  const run = async () => {
    if ((a as HTMLSelectElement).value === (b as HTMLSelectElement).value) { out.replaceChildren(errorBox(new ApiError("Pick two different analyses.")));  return; }
    out.replaceChildren(h("p", null, h("span", { class: "spinner" }), "Comparing…"));
    try {
      const c = await api.compare((a as HTMLSelectElement).value, (b as HTMLSelectElement).value);
      out.replaceChildren(
        c.warnings.length ? h("div", { class: "notice" }, h("strong", null, "Read this before comparing"), h("ul", null, c.warnings.map((w) => h("li", null, w)))) : "",
        h("div", { class: "card" }, h("p", { style: "margin:0" }, h("strong", null, c.verdict))),
        h("div", { class: "card", style: "overflow-x:auto" }, h("table", { class: "data" },
          h("caption", { class: "small muted", style: "text-align:left;padding-bottom:6px" }, "Share of mentions that are negative, per aspect. Only aspects with at least 5 mentions on both sides are compared."),
          h("thead", null, h("tr", null, h("th", null, "Aspect"), h("th", null, c.nameA, ` (${c.sizes.a})`), h("th", null, c.nameB, ` (${c.sizes.b})`), h("th", null, ""))),
          h("tbody", null, c.rows.map((r) => h("tr", null,
            h("td", null, r.label),
            h("td", null, r.a ? `${pct(r.a.negativeShare)} negative · ${plural(r.a.reviews, "mention")}` : "not mentioned"),
            h("td", null, r.b ? `${pct(r.b.negativeShare)} negative · ${plural(r.b.reviews, "mention")}` : "not mentioned"),
            h("td", { class: "small muted" }, r.note || (r.comparable ? "Comparable" : "")))))),
        ),
        h("div", { class: "cols" },
          h("div", { class: "card" }, h("h3", null, c.nameA), c.findingsA.length ? h("ul", null, c.findingsA.map((f) => h("li", null, f))) : h("p", { class: "muted" }, "No evidence-supported blind spot.")),
          h("div", { class: "card" }, h("h3", null, c.nameB), c.findingsB.length ? h("ul", null, c.findingsB.map((f) => h("li", null, f))) : h("p", { class: "muted" }, "No evidence-supported blind spot."))),
      );
    } catch (e) { out.replaceChildren(errorBox(e)); }
  };
  main.replaceChildren(head,
    h("p", { class: "muted" }, "Side-by-side aspect sentiment, blind spots and data volume. Metrics are only compared where both datasets have enough evidence."),
    h("div", { class: "card" }, h("div", { class: "cols" }, h("div", null, h("label", { for: "cmp-a" }, "First dataset"), a), h("div", null, h("label", { for: "cmp-b" }, "Second dataset"), b)),
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn primary", type: "button", onclick: run }, "Compare"))),
    out);
}

// ---------- Privacy ----------
async function viewPrivacy() {
  setNav("privacy");
  document.title = "Privacy · BlindSpot AI";
  const status = await getStatus().catch(() => null);
  main.replaceChildren(
    h("h1", null, "Privacy and your data"),
    h("div", { class: "card" }, h("h3", null, "What is stored"),
      h("ul", null,
        h("li", null, "Per analysis: its name, time, settings, engine version, a data fingerprint (SHA-256 of the reviews) and the computed results."),
        h("li", null, "Only the reviews that are cited as evidence (their text, date, rating, source, link). The rest of your upload is discarded after analysis."),
        h("li", null, "Your feedback on findings (useful, not useful, incorrect, missing context). It is kept for evaluation only. It does not change how the tool behaves."),
        h("li", null, "A random identifier in a cookie so your analyses stay private to your browser. There is no account, email or name."))),
    h("div", { class: "card" }, h("h3", null, "External AI processing"),
      h("p", null, status?.llmAvailable
        ? "AI-assisted mode sends review text to an external AI provider so it can extract aspects. Review text is treated as data, never as instructions. Scores and conclusions are computed on this server. “Offline” mode sends nothing out."
        : "This server has no AI service configured, so review text is not sent anywhere. Analysis runs entirely with the offline keyword engine.")),
    h("div", { class: "card" }, h("h3", null, "Delete everything"),
      h("p", null, "Removes all analyses, evidence and feedback linked to this browser. This can't be undone."),
      h("button", { class: "btn danger", type: "button", onclick: async () => {
        if (!(await confirmDialog("Delete all your data?", "Every saved analysis and its evidence will be permanently removed.", "Delete everything"))) return;
        try { const r = await api.removeAll(); toast(`Deleted ${plural(r.deleted, "analysis", "analyses")}.`); } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't delete."); }
      } }, "Delete all my data")),
  );
}

// ---------- Router ----------
async function route() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, queryStr = ""] = raw.split("?");
  const query = new URLSearchParams(queryStr);
  const parts = path.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === "a" && /^[a-f0-9]{16}$/.test(parts[1] ?? "")) { setNav(""); await renderResult(main, parts[1], parts[2] ?? "overview", query); }
    else if (parts[0] === "history") await viewHistory();
    else if (parts[0] === "compare") await viewCompare();
    else if (parts[0] === "privacy") await viewPrivacy();
    else await viewNew();
  } catch (e) {
    clear(main);
    main.append(errorBox(e, "Try again, or go back to the start."), h("a", { class: "btn", href: "#/" }, "Back to start"));
  }
  main.focus({ preventScroll: true });
}
window.addEventListener("hashchange", route);
route();
