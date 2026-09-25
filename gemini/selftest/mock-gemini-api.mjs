#!/usr/bin/env node
// Minimal, dependency-free mock of the Gemini REST API (generativelanguage.googleapis.com)
// good enough to drive the REAL Gemini CLI (verified with @google/gemini-cli 0.61.0) headless.
//
// Usage:
//   node server.mjs --script scenarios/happy.json [--port 0] [--host 127.0.0.1]
//                   [--log requests.jsonl] [--port-file port.txt] [--workspace <dir>] [--dump-dir <dir>] [--quiet]
//
// On start it prints ONE JSON line to stdout:  {"event":"listening","url":"http://127.0.0.1:PORT"}
// Point the CLI at it with:  GOOGLE_GEMINI_BASE_URL=<url>  (+ settings security.auth.selectedType=gemini-api-key, see README)
//
// Script (.json):
// {
//   "turns": [ <step>, <step>, ... ],        // turn N answers the request whose history holds N model turns
//   "failures": [ { "turn": 0, "times": 2, "code": 429, "retryDelay": "2s" } ],   // injected before the step
//   "afterLastTurn": "repeat-last" | "error" | <step>,   // default: {"text":"(mock) no more scripted turns"}
//   "generateContent": [ <step>, ... ]        // non-streaming utility calls (optional, consumed in order)
// }
// <step>: { text?, thought?, functionCalls?: [{name,args,id?}], parts?: [raw parts], finishReason?: "STOP",
//           chunks?: n (split text over n SSE events), chunkDelayMs?, delayMs? (before headers),
//           stallAfterChunks?, stallMs? (send k events then go silent), drop? (destroy socket mid-stream),
//           httpError?: {code,status,message,retryDelay,quotaId}, usage?: {prompt,candidates,thoughts},
//           expect?: { functionResponse?: { name, contains?, notContains? }, requestContains?: "..." } }
// Strings inside args/text may use {{cwd}} (first workspace dir parsed from the CLI's session context),
// {{tmp}} (CLI project temp dir) and {{sep}} (path separator of the CLI's OS).
//
// Script (.mjs): `export default async function (ctx) { return <step> }`
//   ctx = { turn, kind, model, request, contents, functionResponses, cwd, tmp, callNo, log }
//
// Script (.jsonl): a file written by the real CLI with `--record-responses <file>` (e.g. on the work PC).
//   Turn N replays recorded entry N chunk-by-chunk. With --rewrite-root <recorded workspace dir>
//   every functionCall arg that starts with that dir is re-rooted onto the current workspace
//   (backslashes converted), so a Windows recording replays on Linux and vice versa.
//
// Control endpoints: GET /__mock/health, GET /__mock/log, GET /__mock/state,
//                    POST /__mock/script (body = new script JSON), POST /__mock/reset
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const HOST = opt('host', '127.0.0.1');
const PORT = Number(opt('port', 0));
const LOG_FILE = opt('log', null);
const PORT_FILE = opt('port-file', null);
const WORKSPACE_FALLBACK = opt('workspace', null);
const QUIET = !!opt('quiet', false);
const DUMP_DIR = opt('dump-dir', null); // write every model request body to <dir>/<callNo>-<method>.json
const REWRITE_ROOT = opt('rewrite-root', null);
let scriptPath = opt('script', null);

// ---------------------------------------------------------------- state
let script = { turns: [{ text: 'Hello from the mock Gemini API.' }] };
let handler = null; // .mjs mode
const state = { callNo: 0, failuresUsed: new Map(), utilityIdx: 0, requests: [], expectFailures: [] };

async function loadScript(p) {
  if (!p) return;
  const abs = path.resolve(p);
  if (abs.endsWith('.jsonl')) {
    const entries = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    const stream = entries.filter(e => e.method === 'generateContentStream');
    script = { turns: stream.map(e => ({ rawChunks: e.response })), generateContent: entries.filter(e => e.method === 'generateContent').map(e => ({ raw: e.response })), afterLastTurn: 'error' };
    handler = null;
    return;
  }
  if (abs.endsWith('.mjs') || abs.endsWith('.js')) {
    handler = (await import(pathToFileURL(abs).href + `?t=${Date.now()}`)).default;
    script = {};
  } else {
    script = JSON.parse(fs.readFileSync(abs, 'utf8'));
    handler = null;
  }
}
function resetState() {
  state.callNo = 0; state.failuresUsed = new Map(); state.utilityIdx = 0; state.requests = []; state.expectFailures = [];
}

// ---------------------------------------------------------------- logging
const t0 = Date.now();
function note(line) {
  if (!QUIET) process.stderr.write(`[mock +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}\n`);
}
function record(entry) {
  const e = { ts: new Date().toISOString(), ...entry };
  state.requests.push(e);
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n');
}

// ---------------------------------------------------------------- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
function firstText(contents) {
  for (const c of contents || []) for (const p of c.parts || []) if (typeof p.text === 'string') return p.text;
  return '';
}
function sessionPaths(contents) {
  const t = firstText(contents);
  const cwd = (t.match(/\*\*Workspace Directories:\*\*\s*\r?\n\s*-\s*(.+)/) || [])[1]?.trim() || WORKSPACE_FALLBACK || process.cwd();
  const tmp = (t.match(/temporary directory is:\s*(.+)/) || [])[1]?.trim() || '';
  const sep = /^[A-Za-z]:\\/.test(cwd) || cwd.includes('\\') ? '\\' : '/';
  return { cwd, tmp, sep };
}
function subst(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{(cwd|tmp|sep)\}\}/g, (_, k) => vars[k]);
  if (Array.isArray(value)) return value.map(v => subst(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, vars)]));
  return value;
}
function functionResponsesOf(contents) {
  // functionResponse parts that were sent back after the LAST model turn
  const out = [];
  for (let i = (contents?.length ?? 0) - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role === 'model') break;
    for (const p of c.parts || []) if (p.functionResponse) out.unshift(p.functionResponse);
  }
  return out;
}
function googleError({ code = 429, status, message, retryDelay, quotaId, reason, details } = {}) {
  const st = status || { 400: 'INVALID_ARGUMENT', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' }[code] || 'UNKNOWN';
  const d = details ? [...details] : [];
  if (!details && code === 429) {
    d.push({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: quotaId || 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' }] });
    if (reason) d.push({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'generativelanguage.googleapis.com' });
    if (retryDelay) d.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  }
  return { error: { code, message: message || (code === 429 ? 'You exceeded your current quota, please check your plan and billing details. (mock)' : `mock error ${code}`), status: st, details: d } };
}
function usageOf(step, reqBytes) {
  const u = step.usage || {};
  const prompt = u.prompt ?? Math.max(1, Math.round(reqBytes / 4));
  const candidates = u.candidates ?? Math.max(1, Math.round(JSON.stringify(step.parts || step.text || step.functionCalls || '').length / 4));
  const thoughts = u.thoughts ?? 0;
  return { promptTokenCount: prompt, candidatesTokenCount: candidates, thoughtsTokenCount: thoughts || undefined, totalTokenCount: prompt + candidates + thoughts };
}
function partsOf(step, vars, turn) {
  if (step.parts) return subst(step.parts, vars);
  const parts = [];
  if (step.thought) parts.push({ text: subst(step.thought, vars), thought: true });
  if (step.text !== undefined) parts.push({ text: subst(String(step.text), vars) });
  for (const [i, fc] of (step.functionCalls || []).entries()) {
    parts.push({ functionCall: { name: fc.name, args: subst(fc.args || {}, vars), ...(fc.id ? { id: fc.id } : {}) } });
  }
  if (!parts.length) parts.push({ text: `(mock) empty step for turn ${turn}` });
  return parts;
}
function splitTextParts(parts, n) {
  // Split the (single) text part into n pieces so the CLI receives several SSE events.
  if (!n || n < 2) return [parts];
  const idx = parts.findIndex(p => typeof p.text === 'string' && !p.thought);
  if (idx === -1) return [parts];
  const text = parts[idx].text, size = Math.ceil(text.length / n), events = [];
  const head = parts.slice(0, idx), tail = parts.slice(idx + 1);
  for (let i = 0; i < n; i++) {
    const piece = text.slice(i * size, (i + 1) * size);
    if (!piece && i > 0) continue;
    events.push([...(i === 0 ? head : []), { text: piece }, ...(i === n - 1 ? tail : [])]);
  }
  if (events.length && tail.length && !events[events.length - 1].includes(tail[0])) events[events.length - 1].push(...tail);
  return events;
}
function checkExpect(step, ctx) {
  const problems = [];
  const e = step.expect;
  if (!e) return problems;
  if (e.functionResponse) {
    const fr = ctx.functionResponses.find(r => r.name === e.functionResponse.name);
    if (!fr) problems.push(`expected a functionResponse for ${e.functionResponse.name}, got [${ctx.functionResponses.map(r => r.name).join(', ')}]`);
    else {
      const s = JSON.stringify(fr.response);
      if (e.functionResponse.contains && !s.includes(subst(e.functionResponse.contains, ctx))) problems.push(`functionResponse ${fr.name} lacks ${JSON.stringify(e.functionResponse.contains)}: ${s.slice(0, 300)}`);
      if (e.functionResponse.notContains && s.includes(subst(e.functionResponse.notContains, ctx))) problems.push(`functionResponse ${fr.name} unexpectedly contains ${JSON.stringify(e.functionResponse.notContains)}: ${s.slice(0, 300)}`);
    }
  }
  if (e.requestContains && !JSON.stringify(ctx.contents).includes(e.requestContains)) problems.push(`request lacks ${JSON.stringify(e.requestContains)}`);
  return problems;
}

// ---------------------------------------------------------------- step resolution
async function resolveStep(kind, ctx) {
  if (handler) return (await handler(ctx)) || { text: '(mock handler returned nothing)' };
  if (kind === 'generateContent') {
    const list = script.generateContent || [];
    if (state.utilityIdx < list.length) return list[state.utilityIdx++];
    return script.generateContentDefault || { text: '{}' };
  }
  const turns = script.turns || [];
  if (ctx.turn < turns.length) return turns[ctx.turn];
  const after = script.afterLastTurn ?? { text: '(mock) no more scripted turns' };
  if (after === 'repeat-last') return turns[turns.length - 1];
  if (after === 'error') return { httpError: { code: 500, message: `mock: no scripted step for turn ${ctx.turn}` } };
  return after;
}
function pendingFailure(turn) {
  for (const [i, f] of (script.failures || []).entries()) {
    if ((f.turn ?? 0) !== turn) continue;
    const used = state.failuresUsed.get(i) || 0;
    if (used < (f.times ?? 1)) { state.failuresUsed.set(i, used + 1); return { ...f, attempt: used + 1 }; }
  }
  return null;
}

// ---------------------------------------------------------------- responders
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=UTF-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function rerootArgs(value, ctx) {
  if (!REWRITE_ROOT) return value;
  const norm = x => x.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const from = norm(REWRITE_ROOT), cs = !/^[A-Za-z]:/.test(from);
  const walk = v => {
    if (typeof v === 'string') {
      const n = norm(v);
      const hit = cs ? n.startsWith(from) : n.toLowerCase().startsWith(from.toLowerCase());
      if (!hit || (n.length > from.length && n[from.length] !== '/')) return v;
      const rest = n.slice(from.length).replace(/^\//, '');
      return rest ? `${ctx.cwd}${ctx.sep}${rest.split('/').join(ctx.sep)}` : ctx.cwd;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}
async function streamStep(req, res, step, ctx, reqBytes) {
  if (step.delayMs) { note(`  delaying headers ${step.delayMs}ms`); await sleep(step.delayMs); }
  if (step.httpError) { note(`  -> HTTP ${step.httpError.code ?? 429}`); return sendJson(res, step.httpError.code ?? 429, googleError(step.httpError)); }
  if (step.rawChunks) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const raw of step.rawChunks) {
      const chunk = structuredClone(raw);
      for (const cand of chunk.candidates || []) for (const part of cand.content?.parts || []) if (part.functionCall) part.functionCall.args = rerootArgs(part.functionCall.args || {}, ctx);
      res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      if (step.chunkDelayMs) await sleep(step.chunkDelayMs);
    }
    return res.end();
  }
  const vars = { cwd: ctx.cwd, tmp: ctx.tmp, sep: ctx.sep };
  const parts = partsOf(step, vars, ctx.turn);
  const events = splitTextParts(parts, step.chunks);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders?.();
  for (let i = 0; i < events.length; i++) {
    if (step.stallAfterChunks !== undefined && i === step.stallAfterChunks) {
      note(`  stalling mid-stream for ${step.stallMs ?? 'ever'}ms after ${i} event(s)`);
      if (step.drop) { res.socket?.destroy(); return; }
      await sleep(step.stallMs ?? 2 ** 31 - 1);
      if (res.destroyed || res.writableEnded) return;
    }
    const last = i === events.length - 1;
    const chunk = {
      candidates: [{ content: { role: 'model', parts: events[i] }, ...(last ? { finishReason: step.finishReason ?? 'STOP' } : {}), index: 0 }],
      ...(last ? { usageMetadata: usageOf(step, reqBytes) } : {}),
      modelVersion: ctx.model,
      responseId: `mock-${state.callNo}-${i}`
    };
    if (last && step.finishReason === null) delete chunk.candidates[0].finishReason;
    res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    if (!last && step.chunkDelayMs) await sleep(step.chunkDelayMs);
  }
  if (step.drop && step.stallAfterChunks === undefined) { res.socket?.destroy(); return; }
  res.end();
}
async function generateStep(res, step, ctx, reqBytes) {
  if (step.delayMs) await sleep(step.delayMs);
  if (step.httpError) return sendJson(res, step.httpError.code ?? 429, googleError(step.httpError));
  if (step.raw) return sendJson(res, 200, step.raw);
  const parts = partsOf(step, { cwd: ctx.cwd, tmp: ctx.tmp, sep: ctx.sep }, ctx.turn);
  sendJson(res, 200, { candidates: [{ content: { role: 'model', parts }, finishReason: step.finishReason ?? 'STOP', index: 0 }], usageMetadata: usageOf(step, reqBytes), modelVersion: ctx.model });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  await new Promise(r => req.on('end', r));
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname;
  try {
    // ---- control plane
    if (p === '/__mock/health') return sendJson(res, 200, { ok: true, callNo: state.callNo });
    if (p === '/__mock/log') return sendJson(res, 200, state.requests);
    if (p === '/__mock/state') return sendJson(res, 200, { callNo: state.callNo, expectFailures: state.expectFailures, failuresUsed: [...state.failuresUsed] });
    if (p === '/__mock/reset' && req.method === 'POST') { resetState(); return sendJson(res, 200, { ok: true }); }
    if (p === '/__mock/script' && req.method === 'POST') { script = JSON.parse(raw); handler = null; resetState(); return sendJson(res, 200, { ok: true }); }

    // ---- model listing (GET /v1beta/models, GET /v1beta/models/x)
    const m = p.match(/^\/(v1beta|v1alpha|v1)\/models(?:\/([^:/]+))?(?::(\w+))?$/);
    if (!m) { note(`404 ${req.method} ${req.url}`); record({ kind: 'unknown', method: req.method, url: req.url }); return sendJson(res, 404, googleError({ code: 404, message: `mock: unknown path ${p}` })); }
    const [, , model = 'unknown', method] = m;
    if (req.method === 'GET') {
      const one = { name: `models/${model}`, displayName: model, inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] };
      record({ kind: 'models', method: 'GET', url: req.url });
      return sendJson(res, 200, m[2] ? one : { models: [one] });
    }
    const body = raw ? JSON.parse(raw) : {};
    const contents = body.contents || [];
    if (method === 'countTokens') { record({ kind: 'countTokens', url: req.url }); return sendJson(res, 200, { totalTokens: Math.max(1, Math.round(raw.length / 4)) }); }
    if (method === 'embedContent') { record({ kind: 'embedContent', url: req.url }); return sendJson(res, 200, { embedding: { values: new Array(8).fill(0) } }); }
    if (method === 'batchEmbedContents') { record({ kind: 'batchEmbedContents', url: req.url }); return sendJson(res, 200, { embeddings: (body.requests || []).map(() => ({ values: new Array(8).fill(0) })) }); }
    if (method !== 'streamGenerateContent' && method !== 'generateContent') { record({ kind: 'unsupported', url: req.url }); return sendJson(res, 400, googleError({ code: 400, message: `mock: unsupported method ${method}` })); }

    state.callNo++;
    if (DUMP_DIR) { fs.mkdirSync(DUMP_DIR, { recursive: true }); fs.writeFileSync(path.join(DUMP_DIR, `${String(state.callNo).padStart(3, '0')}-${method}.json`), JSON.stringify(body, null, 1)); }
    const turn = contents.filter(c => c.role === 'model').length;
    const { cwd, tmp, sep } = sessionPaths(contents);
    const ctx = { kind: method, turn, model, request: body, contents, functionResponses: functionResponsesOf(contents), cwd, tmp, sep, callNo: state.callNo, log: note };
    const summary = ctx.functionResponses.map(r => `${r.name}(${JSON.stringify(r.response).slice(0, 80)})`).join(' ');
    note(`#${state.callNo} ${method} model=${model} turn=${turn}${summary ? ' functionResponses=' + summary : ''}`);

    let step, failure = null;
    if (method === 'streamGenerateContent') failure = pendingFailure(turn);
    if (failure) {
      note(`  injecting failure ${failure.attempt}/${failure.times ?? 1}: ${failure.kind || 'http'} ${failure.code ?? ''}`);
      step = failure.kind === 'stall' ? { delayMs: failure.delayMs ?? failure.stallMs ?? 2 ** 31 - 1, text: '(mock) late reply after stall' }
        : failure.kind === 'midstream-stall' ? { text: 'partial reply that stalls', chunks: 2, stallAfterChunks: 1, stallMs: failure.stallMs }
        : failure.kind === 'drop' ? { text: 'partial reply then connection drop', chunks: 2, stallAfterChunks: 1, drop: true }
        : { httpError: failure, delayMs: failure.delayMs };
    } else {
      step = await resolveStep(method, ctx);
    }
    const problems = failure ? [] : checkExpect(step, ctx);
    for (const pr of problems) { note(`  EXPECT FAILED: ${pr}`); state.expectFailures.push({ callNo: state.callNo, turn, problem: pr }); }
    record({
      kind: method, callNo: state.callNo, model, turn, url: req.url, headers: { 'x-goog-api-key': req.headers['x-goog-api-key'] ? '(set)' : '(missing)', 'user-agent': req.headers['user-agent'] },
      injectedFailure: failure ? { code: failure.code, kind: failure.kind || 'http', attempt: failure.attempt } : undefined,
      functionResponses: ctx.functionResponses, expectProblems: problems.length ? problems : undefined,
      generationConfig: body.generationConfig, toolNames: (body.tools || []).flatMap(t => (t.functionDeclarations || []).map(f => f.name)),
      lastUserParts: (contents[contents.length - 1]?.parts || []).map(pt => Object.keys(pt).join('+')),
      servedStep: failure ? undefined : { text: step.text, functionCalls: step.functionCalls?.map(f => f.name), httpError: step.httpError?.code, replayedChunks: step.rawChunks?.length }
    });
    if (method === 'streamGenerateContent') return await streamStep(req, res, step, ctx, raw.length);
    return await generateStep(res, step, ctx, raw.length);
  } catch (err) {
    note(`mock internal error: ${err.stack}`);
    if (!res.headersSent) sendJson(res, 500, googleError({ code: 500, message: `mock internal error: ${err.message}` }));
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.requestTimeout = 0; // allow long stalls
server.headersTimeout = 0;

await loadScript(scriptPath);
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${server.address().port}`;
  if (PORT_FILE) fs.writeFileSync(PORT_FILE, String(server.address().port));
  process.stdout.write(JSON.stringify({ event: 'listening', url, script: scriptPath || '(default)' }) + '\n');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); });
