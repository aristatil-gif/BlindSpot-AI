import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, MAX_CSV_CHARS } from "../src/server/app.ts";
import { openDb } from "../src/server/db.ts";

let server: Server;
let base = "";
before(async () => {
  server = createApp({ db: openDb(":memory:"), llm: null, publicDir: "public", analyzeLimit: 6 });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, cookie, data: type.includes("json") ? await res.json() : await res.text() };
}

test("status never exposes secrets and samples are listed", async () => {
  const s = await call("/api/status");
  assert.deepEqual(Object.keys(s.data).sort(), ["llmAvailable", "maxCsvChars", "maxReviews"]);
  assert.equal(s.data.llmAvailable, false);
  assert.ok((await call("/api/samples")).data.length >= 3);
});

test("full journey: analyze sample, list, fetch, feedback, ask, report, delete", async () => {
  const a = await call("/api/analyze", { body: { source: "sample", sampleId: "earbuds" } });
  assert.equal(a.status, 201);
  assert.ok(a.cookie?.startsWith("bs_owner="));
  const id = a.data.id as string;
  assert.equal(a.data.result.outcome, "blind_spot_detected");
  const list = await call("/api/analyses", { cookie: a.cookie });
  assert.equal(list.data.length, 1);
  assert.ok(!JSON.stringify(list.data).includes("review text"), "list holds metadata only");
  const got = await call(`/api/analyses/${id}`, { cookie: a.cookie });
  assert.equal(got.status, 200);
  const fid = got.data.result.findings[0].id;
  assert.equal((await call(`/api/analyses/${id}/feedback`, { cookie: a.cookie, body: { findingId: fid, label: "useful" } })).status, 200);
  assert.equal((await call(`/api/analyses/${id}/feedback`, { cookie: a.cookie, body: { findingId: fid, label: "bogus" } })).status, 400);
  assert.equal((await call(`/api/analyses/${id}/feedback`, { cookie: a.cookie, body: { findingId: "nope", label: "useful" } })).status, 404);
  assert.equal((await call(`/api/analyses/${id}`, { cookie: a.cookie })).data.feedback[fid], "useful");
  const q = await call(`/api/analyses/${id}/ask`, { cookie: a.cookie, body: { question: "What are customers praising most?" } });
  assert.match(q.data.answer, /Most-praised/);
  const rep = await call(`/api/analyses/${id}/report`, { cookie: a.cookie });
  assert.match(rep.data as string, /<h1>Brightline Earbuds/);
  assert.equal((await call(`/api/analyses/${id}`, { cookie: a.cookie, method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/analyses/${id}`, { cookie: a.cookie })).status, 404);
});

test("15. another user cannot read, ask about, report on, delete or compare someone else's analysis", async () => {
  const mine = await call("/api/analyze", { body: { source: "sample", sampleId: "cafe" } });
  const theirs = await call("/api/analyses", {}); // gets a fresh identity
  const intruder = theirs.cookie;
  const id = mine.data.id;
  assert.equal((await call(`/api/analyses/${id}`, { cookie: intruder })).status, 404);
  assert.equal((await call(`/api/analyses/${id}/report`, { cookie: intruder })).status, 404);
  assert.equal((await call(`/api/analyses/${id}/ask`, { cookie: intruder, body: { question: "x" } })).status, 404);
  assert.equal((await call(`/api/analyses/${id}`, { cookie: intruder, method: "DELETE" })).status, 404);
  assert.equal((await call(`/api/compare?a=${id}&b=${id}`, { cookie: intruder })).status, 404);
  assert.equal((await call("/api/analyses", { cookie: intruder })).data.length, 0);
  assert.equal((await call(`/api/analyses/${id}`, { cookie: mine.cookie })).status, 200, "owner still has access");
});

test("input validation: empty, malformed, binary and oversized uploads are rejected safely", async () => {
  const c = (await call("/api/status")).cookie;
  assert.equal((await call("/api/analyze", { cookie: c, body: { source: "csv", csv: "" } })).status, 400);
  const noCol = await call("/api/analyze", { cookie: c, body: { source: "csv", csv: "a,b\n1,2" } });
  assert.equal(noCol.status, 400);
  assert.match(noCol.data.error, /review/);
  assert.equal((await call("/api/analyze", { cookie: c, body: { source: "csv", csv: "review\n\u0000\u0001" } })).status, 400);
  assert.equal((await call("/api/analyze", { cookie: c, body: { source: "csv", csv: "x".repeat(MAX_CSV_CHARS + 1) } })).status, 413);
  assert.equal((await call("/api/analyze", { cookie: c, body: { source: "nope" } })).status, 400);
  const res = await fetch(base + "/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
  const manual = await call("/api/analyze", { cookie: c, body: { source: "manual", text: "Delivery was quick.\nGreat value." } });
  assert.equal(manual.status, 201);
  assert.equal(manual.data.result.outcome, "insufficient_data");
});

test("delete-all removes every analysis for the owner only", async () => {
  const a = await call("/api/analyze", { body: { source: "sample", sampleId: "tiny" } });
  await call("/api/analyze", { cookie: a.cookie, body: { source: "sample", sampleId: "tiny" } });
  const other = await call("/api/analyze", { body: { source: "sample", sampleId: "tiny" } });
  assert.equal((await call("/api/data", { cookie: a.cookie, method: "DELETE" })).data.deleted, 2);
  assert.equal((await call("/api/analyses", { cookie: a.cookie })).data.length, 0);
  assert.equal((await call("/api/analyses", { cookie: other.cookie })).data.length, 1);
});

test("rate limiting protects the analyze endpoint", async () => {
  const c = (await call("/api/status")).cookie;
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await call("/api/analyze", { cookie: c, body: { source: "sample", sampleId: "tiny" } })).status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
});

test("compare endpoint and path traversal protection", async () => {
  const a = await call("/api/analyze", { body: { source: "sample", sampleId: "earbuds" } });
  const b = await call("/api/analyze", { cookie: a.cookie, body: { source: "sample", sampleId: "earbuds-pro" } });
  const cmp = await call(`/api/compare?a=${a.data.id}&b=${b.data.id}`, { cookie: a.cookie });
  assert.equal(cmp.status, 200);
  assert.ok(Array.isArray(cmp.data.rows) && typeof cmp.data.verdict === "string");
  const t = await fetch(base + "/..%2f..%2fpackage.json");
  assert.ok([403, 404].includes(t.status));
});
