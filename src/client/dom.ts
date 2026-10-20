// Tiny DOM helpers. Text is only ever set through textContent / text nodes, so review text can never run as HTML.

export type Child = Node | string | number | null | undefined | false | Child[];

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function applyAttrs(el: Element, attrs: Record<string, unknown> | null) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", String(v));
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (k === "checked" && "checked" in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function s(tag: string, attrs: Record<string, unknown> | null = null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el as SVGElement;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Only plain http(s) links from imported data are ever rendered as links. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function logo(size = 28): SVGElement {
  return s("svg", { width: size, height: size, viewBox: "0 0 32 32", role: "img", "aria-label": "BlindSpot AI" },
    s("circle", { cx: 16, cy: 16, r: 13, fill: "none", stroke: "currentColor", "stroke-width": 2.5 }),
    s("path", { d: "M16 7a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", fill: "currentColor", opacity: 0.12 }),
    s("circle", { cx: 21, cy: 11, r: 4.2, fill: "var(--amber)" }),
    s("circle", { cx: 16, cy: 16, r: 3, fill: "currentColor" }),
  );
}

let toastTimer: number | undefined;
export function toast(message: string) {
  let box = document.getElementById("toast");
  if (!box) {
    box = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box!.classList.remove("show"), 2600);
}

/** Accessible confirmation dialog for destructive actions. */
export function confirmDialog(title: string, body: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dialog", "aria-labelledby": "dlg-title" },
      h("h2", { id: "dlg-title" }, title),
      h("p", null, body),
      h("div", { class: "row end" },
        h("button", { class: "btn", type: "button", onclick: () => { dlg.close(); resolve(false); } }, "Cancel"),
        h("button", { class: "btn danger", type: "button", onclick: () => { dlg.close(); resolve(true); } }, confirmLabel),
      ),
    );
    dlg.addEventListener("close", () => { dlg.remove(); resolve(false); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/** Inline "what does this mean?" explanation, keyboard accessible. */
export function term(label: string, explanation: string): HTMLElement {
  const note = h("span", { class: "term-note", hidden: true }, explanation);
  const btn = h("button", { class: "term", type: "button", "aria-expanded": "false", onclick: () => {
    const open = note.hidden;
    note.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  } }, label, h("span", { class: "term-i", "aria-hidden": "true" }, "?"));
  return h("span", { class: "term-wrap" }, btn, note);
}
