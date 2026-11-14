'use strict';
const { z } = require('zod');
const graph = require('../core/analysis-graph');
const { scrub } = require('../core/secret-scrub');
const apiScrub = require('../core/secret-scrub').sanitize;
const name = z.string().min(1).max(80).regex(/^[\p{L}\p{N}_. -]+$/u);
const hashes = new Set(['binaryHash','sha256','scopeHash','extractorHash','exporterHash','evidenceId','graphSha256','extractorSha256','scopeSha256','reaEvidenceId']);
function sanitize(value, key = '') {
  if (typeof value === 'string') return hashes.has(key) ? value : apiScrub(scrub(value)).replace(/nvapi-[a-z0-9_-]{20,}/gi, '[redacted]');
  if (Array.isArray(value)) return value.map(row => sanitize(row, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, row]) => [field, sanitize(row, field)]));
  return value;
}
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(sanitize(value), null, 2) }] });
const pending = new Map(); // graph name -> build promise (status also appears in analysis_graph_list)
const compactGraph = g => g && g.nodes ? { name: g.name, kind: g.kind, nodes: g.nodes.length, edges: g.edges.length, engineMap: g.engineMap || null,
  engineScope: g.engineScope || null, pdbLoaded: g.pdbLoaded ?? null, reusedAnalysis: g.reusedAnalysis ?? null, warnings: g.warnings } : g;
function register(server) {
  server.registerTool('analysis_graph_list', {
    title: 'List local source/binary structural graphs',
    description: 'List built graphs and running builds (state=running). Read-only; no scan, process or model.',
    inputSchema: {},
  }, async () => text(await graph.list()));
  server.registerTool('analysis_graph_build', {
    title: 'Build a structural graph (engine topic, source scope or binary)',
    description: 'kind=engine: an engine topic (e.g. "Lumen", "CharacterMovement") picks files through the symbol/cvar/render maps and builds a call/reference graph whose nodes carry module, class, cvars and GPU stats. kind=source: explicit root + paths (<=200 files). kind=binary: one EXE/DLL analyzed by Ghidra into a persistent project (first run minutes; engine DLLs with PDBs get real names linked to engine classes). Hardware admission applies; never executes the target. Waits up to wait_s; poll with analysis_graph_list.',
    inputSchema: { name, kind: z.enum(['engine', 'source', 'binary']), map: z.string().regex(/^[\w-]{1,64}$/).optional(), topic: z.string().min(3).max(80).optional(),
      render_map: z.string().regex(/^[\w-]{1,64}$/).optional(), root: z.string().max(400).optional(), paths: z.array(z.string().max(400)).max(200).optional(),
      file: z.string().max(400).optional(), wait_s: z.number().int().min(0).max(50).optional() },
  }, async a => {
    if (!pending.has(a.name)) {
      const run = a.kind === 'binary' ? graph.binary({ name: a.name, file: a.file })
        : graph.build(a.kind === 'engine' ? { name: a.name, engine: { map: a.map, topic: a.topic, renderMap: a.render_map } } : { name: a.name, root: a.root, paths: a.paths });
      pending.set(a.name, run.finally(() => setTimeout(() => pending.delete(a.name), 60000)));
    }
    const result = await Promise.race([pending.get(a.name).then(compactGraph, e => ({ error: e.message })),
      new Promise(r => setTimeout(() => r({ name: a.name, state: 'running' }), (a.wait_s ?? 45) * 1000))]);
    return text(result);
  });
  server.registerTool('analysis_binary_query', {
    title: 'Query a binary graph’s saved Ghidra analysis',
    description: 'decompile (function name or address), xrefs, search (function names + strings), callgraph (depth 1–3) against the persistent analysis of a binary graph — seconds, no re-analysis. Engine DLL functions also return their source definition (file:line). Decompiled C is inferred, not the original source. Read-only.',
    inputSchema: { graph: name, op: z.enum(['decompile', 'xrefs', 'search', 'callgraph']), target: z.string().min(1).max(200), depth: z.number().int().min(1).max(3).optional() },
    annotations: { readOnlyHint: true },
  }, async a => text(await graph.binaryQuery(a.graph, a.op, a.target, a.depth)));
  server.registerTool('analysis_binary_annotate', {
    title: 'Rename or comment functions in the analysis database',
    description: 'Record understanding in the saved analysis: rename a function or set its plate comment (1–50 edits). Changes live only in the Hub’s Ghidra project and refresh the graph labels; the analyzed binary file is never written.',
    inputSchema: { graph: name, edits: z.array(z.object({ op: z.enum(['rename', 'comment']), target: z.string().min(1).max(200), value: z.string().min(1).max(2000) })).min(1).max(50) },
  }, async a => text(await graph.binaryAnnotate(a.graph, a.edits)));
  server.registerTool('analysis_graph_export', {
    title: 'Export graph facts as JSONL',
    description: 'Write one line per node with its location, evidence level, engine coordinates and typed neighbors (local file) — a grounded corpus for retrieval, study cards or fine-tuning sets. include_source adds a masked 30-line excerpt for source nodes. Returns the file path, not the content.',
    inputSchema: { graph: name, include_source: z.boolean().optional() },
  }, async a => text(await graph.exportFacts(a.graph, { includeSource: a.include_source })));
  server.registerTool('analysis_graph_query', {
    title: 'Query existing structural evidence',
    description: 'Find source functions, references, configured UE/Unity modules or binary-address facts in an existing graph. Returns bounded neighbors, direction and uncertainty. Selected decompiler reconstruction is inferred. No new analysis or execution.',
    inputSchema: { graph: name, query: z.string().min(1).max(512),
      direction: z.enum(['both','upstream','downstream']).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async a => text(await graph.query(a.graph, a.query, { direction: a.direction, limit: a.limit })));
  server.registerTool('analysis_graph_path', {
    title: 'Trace an existing directed relation path',
    description: 'Trace directed relations between exact node IDs returned by analysis_graph_query. Preserves file/line or binary hash/address and evidence levels. A static path does not prove runtime execution. Read-only; no scan, model or process.',
    inputSchema: { graph: name, source: z.string().min(1).max(512), target: z.string().min(1).max(512) },
  }, async a => text(await graph.shortestPath(a.graph, a.source, a.target)));
  server.registerTool('analysis_context_prepare', {
    title: 'Prepare frozen analysis evidence for learning or development',
    description: 'Freeze evidence for learning or development. Either select 1–12 exact nodes of an existing Hub graph (engine/source/binary analysis), or pass reaEvidenceId of REA evidence the Hub stored (.NET/JS analysis). Input hashes are verified; source or pseudocode excerpts only with includeSource=true. Writes a bounded immutable local snapshot, no model/process, edits or external transmission. Evidence is reference only. REA bundles preserve provider confidence and authority, report stored/exported locations and an unknown original total; locations omitted from this projection do not prove absence.',
    inputSchema: { graph: name.optional(), nodeIds: z.array(z.string().min(1).max(512)).min(1).max(12).optional(),
      reaEvidenceId: z.string().regex(/^ev_[a-f0-9]{64}$/).optional(),
      purpose: z.enum(['learning','development','modding']), includeSource: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async a => {
    if (!a.reaEvidenceId && (!a.graph || !a.nodeIds)) throw new Error('graph_and_nodeIds_or_reaEvidenceId_required');
    const { localHandoff, ...result } = await require('../core/analysis-context').prepare(a.reaEvidenceId
      ? { reaEvidenceId: a.reaEvidenceId, purpose: a.purpose, includeSource: a.includeSource } : a);
    return text(result);
  });
  server.registerTool('analysis_context_check', {
    title: 'Check whether prepared analysis is still current',
    description: 'Verify the immutable evidence hash, graph snapshot and source/binary inputs. No scan, process or model. current=false requires rebuilding the graph and preparing fresh evidence before dispatch.',
    inputSchema: { evidenceId: z.string().regex(/^[a-f0-9]{64}$/) }, annotations: { readOnlyHint: true },
  }, async a => text(await require('../core/analysis-context').check(a.evidenceId)));
}
module.exports = { register, sanitize };
