// Hub-owned read-only query against an analyzed program in a persistent project (run with -process -noanalysis -readOnly).
// Ops: decompile <name|address>, xrefs <name|address>, search <text>, callgraph <name|address> <depth>.
// @category Hub.Analysis
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class HubQuery extends GhidraScript {
    private String q(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else if (c == '\t') out.append("\\t");
            else if (c < 32) out.append(String.format("\\u%04x", (int)c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
    private String ref(Function f) { return "{\"name\":" + q(f.getName(true)) + ",\"address\":" + q(f.getEntryPoint().toString()) + "}"; }

    /** Exact address, exact (namespaced or plain) name, then case-insensitive substring; null when ambiguous or absent. */
    private List<Function> resolve(String target) {
        FunctionManager fm = currentProgram.getFunctionManager();
        List<Function> out = new ArrayList<>();
        if (target.matches("(0x)?[0-9a-fA-F]{4,16}")) {
            Address a = toAddr(target.startsWith("0x") ? target.substring(2) : target);
            Function f = a == null ? null : fm.getFunctionContaining(a);
            if (f != null) { out.add(f); return out; }
        }
        String low = target.toLowerCase();
        List<Function> partial = new ArrayList<>();
        for (Function f : fm.getFunctions(true)) {
            if (monitor.isCancelled()) break;
            String plain = f.getName().toLowerCase(), full = f.getName(true).toLowerCase();
            if (plain.equals(low) || full.equals(low)) out.add(f);
            else if (partial.size() < 50 && full.contains(low)) partial.add(f);
        }
        return out.isEmpty() ? partial : out;
    }

    private String strings(Function f) {
        List<String> rows = new ArrayList<>();
        ReferenceManager rm = currentProgram.getReferenceManager();
        AddressIterator it = rm.getReferenceSourceIterator(f.getBody(), true);
        while (it.hasNext() && rows.size() < 40) {
            for (Reference r : rm.getReferencesFrom(it.next())) {
                Data d = getDataAt(r.getToAddress());
                if (d != null && d.hasStringValue() && d.getValue() != null) {
                    String s = d.getValue().toString();
                    rows.add(q(s.length() > 200 ? s.substring(0, 200) : s));
                }
            }
        }
        return "[" + String.join(",", rows) + "]";
    }

    private String decompile(List<Function> found) throws Exception {
        if (found.size() != 1) return candidates(found);
        Function f = found.get(0);
        DecompInterface d = new DecompInterface();
        try {
            d.openProgram(currentProgram);
            DecompileResults r = d.decompileFunction(f, 30, monitor);
            String c = r.decompileCompleted() ? r.getDecompiledFunction().getC() : null;
            if (c != null && c.length() > 20000) c = c.substring(0, 20000) + "\n/* truncated */";
            List<String> callers = new ArrayList<>(), callees = new ArrayList<>();
            for (Function x : f.getCallingFunctions(monitor)) if (callers.size() < 40) callers.add(ref(x));
            for (Function x : f.getCalledFunctions(monitor)) if (callees.size() < 40) callees.add(ref(x));
            return "{\"function\":" + ref(f) + ",\"signature\":" + q(f.getSignature().getPrototypeString()) +
                ",\"bytes\":" + f.getBody().getNumAddresses() + ",\"decompiled\":" + q(c) +
                ",\"callers\":[" + String.join(",", callers) + "],\"callees\":[" + String.join(",", callees) + "]" +
                ",\"strings\":" + strings(f) + ",\"evidence\":\"INFERRED\"}";
        } finally { d.dispose(); }
    }

    private String candidates(List<Function> found) {
        List<String> rows = new ArrayList<>();
        for (Function f : found) if (rows.size() < 50) rows.add(ref(f));
        return "{\"error\":" + q(found.isEmpty() ? "not_found" : "ambiguous_target") + ",\"candidates\":[" + String.join(",", rows) + "]}";
    }

    private String xrefs(List<Function> found) throws Exception {
        if (found.size() != 1) return candidates(found);
        Function f = found.get(0);
        List<String> to = new ArrayList<>();
        for (Reference r : getReferencesTo(f.getEntryPoint())) {
            if (to.size() >= 200) break;
            Function from = getFunctionContaining(r.getFromAddress());
            to.add("{\"from\":" + q(r.getFromAddress().toString()) + ",\"function\":" + (from == null ? "null" : q(from.getName(true))) + ",\"type\":" + q(r.getReferenceType().toString()) + "}");
        }
        return "{\"function\":" + ref(f) + ",\"referencesTo\":[" + String.join(",", to) + "]}";
    }

    private String search(String text) {
        String low = text.toLowerCase();
        List<String> fn = new ArrayList<>(), str = new ArrayList<>();
        for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
            if (fn.size() >= 60 || monitor.isCancelled()) break;
            if (f.getName(true).toLowerCase().contains(low)) fn.add(ref(f));
        }
        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext() && str.size() < 60 && !monitor.isCancelled()) {
            Data d = data.next();
            if (!d.hasStringValue() || d.getValue() == null) continue;
            String s = d.getValue().toString();
            if (!s.toLowerCase().contains(low)) continue;
            List<String> users = new ArrayList<>();
            for (Reference r : getReferencesTo(d.getAddress())) {
                Function u = getFunctionContaining(r.getFromAddress());
                if (u != null && users.size() < 8) users.add(ref(u));
            }
            str.add("{\"address\":" + q(d.getAddress().toString()) + ",\"text\":" + q(s.length() > 200 ? s.substring(0, 200) : s) + ",\"usedBy\":[" + String.join(",", users) + "]}");
        }
        return "{\"functions\":[" + String.join(",", fn) + "],\"strings\":[" + String.join(",", str) + "]}";
    }

    private String callgraph(List<Function> found, int depth) throws Exception {
        if (found.size() != 1) return candidates(found);
        List<String> edges = new ArrayList<>();
        Set<Function> seen = new HashSet<>();
        List<Function> frontier = new ArrayList<>(found);
        seen.addAll(found);
        for (int level = 0; level < depth && !frontier.isEmpty() && edges.size() < 300; level++) {
            List<Function> next = new ArrayList<>();
            for (Function f : frontier) for (Function c : f.getCalledFunctions(monitor)) {
                if (edges.size() >= 300) break;
                edges.add("{\"from\":" + q(f.getName(true)) + ",\"to\":" + q(c.getName(true)) + ",\"toAddress\":" + q(c.getEntryPoint().toString()) + ",\"depth\":" + (level + 1) + "}");
                if (seen.add(c) && !c.isExternal()) next.add(c);
            }
            frontier = next;
        }
        return "{\"root\":" + ref(found.get(0)) + ",\"edges\":[" + String.join(",", edges) + "],\"truncated\":" + (edges.size() >= 300) + "}";
    }

    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        if (a.length < 3) throw new IllegalArgumentException("usage: <out.json> <op> <target> [depth]");
        String op = a[1], target = a[2], json;
        switch (op) {
            case "decompile": json = decompile(resolve(target)); break;
            case "xrefs": json = xrefs(resolve(target)); break;
            case "search": json = search(target); break;
            case "callgraph": json = callgraph(resolve(target), a.length > 3 ? Math.max(1, Math.min(3, Integer.parseInt(a[3]))) : 2); break;
            default: throw new IllegalArgumentException("unknown op " + op);
        }
        Files.writeString(Path.of(a[0]), "{\"op\":" + q(op) + ",\"program\":" + q(currentProgram.getName()) + ",\"result\":" + json + "}", StandardCharsets.UTF_8);
    }
}
