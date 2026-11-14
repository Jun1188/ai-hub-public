// Hub-owned headless post-script. Static facts retain binary addresses; no source mapping is inferred.
// @category Hub.Analysis
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import ghidra.program.model.block.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class HubGraphExport extends GhidraScript {
    private final List<String> nodes = new ArrayList<>();
    private final List<String> edges = new ArrayList<>();
    private final Set<String> seen = new HashSet<>();
    private final int MAX_NODES = 50000, MAX_EDGES = 100000;
    private boolean truncated = false;

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
    private String id(Address address) { return "binary:" + address.toString(); }
    private void node(Address address, String label, String type) {
        String key = id(address);
        if (seen.contains(key)) return;
        if (nodes.size() >= MAX_NODES) { truncated = true; return; }
        seen.add(key);
        nodes.add("{\"id\":" + q(key) + ",\"label\":" + q(label) + ",\"type\":" + q(type) +
            ",\"binary_address\":" + q(address.toString()) + ",\"source_location\":" + q("binary@" + address) +
            ",\"evidence\":\"EXTRACTED\",\"confidence\":1.0}");
    }
    private void edge(Address from, Address to, String relation, String note) {
        if (edges.size() >= MAX_EDGES) { truncated = true; return; }
        if (!seen.contains(id(from)) || !seen.contains(id(to))) return;
        edges.add("{\"source\":" + q(id(from)) + ",\"target\":" + q(id(to)) +
            ",\"relation\":" + q(relation) + ",\"binary_address\":" + q(from.toString()) +
            ",\"evidence\":\"EXTRACTED\",\"confidence\":1.0,\"note\":" + q(note) + "}");
    }
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length < 1) throw new IllegalArgumentException("Output JSON path required");
        Set<String> selected = new HashSet<>();
        if (arguments.length > 1) selected.addAll(Arrays.asList(arguments[1].split(",")));
        FunctionManager manager = currentProgram.getFunctionManager();
        FunctionIterator functions = manager.getFunctions(true);
        while (functions.hasNext() && !monitor.isCancelled()) {
            Function function = functions.next();
            node(function.getEntryPoint(), function.getName(true), function.isExternal() ? "import" : "function");
        }
        SymbolIterator external = currentProgram.getSymbolTable().getExternalSymbols();
        while (external.hasNext() && !monitor.isCancelled()) {
            Symbol symbol = external.next();
            node(symbol.getAddress(), symbol.getName(true), "import");
        }
        functions = manager.getFunctions(true);
        while (functions.hasNext() && !monitor.isCancelled()) {
            Function function = functions.next();
            for (Function target : function.getCalledFunctions(monitor)) {
                node(target.getEntryPoint(), target.getName(true), target.isExternal() ? "import" : "function");
                edge(function.getEntryPoint(), target.getEntryPoint(), "calls", "Statically resolved call; indirect/virtual targets may be incomplete.");
            }
        }
        int strings = 0;
        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext() && strings < 5000 && !monitor.isCancelled()) {
            Data item = data.next();
            if (!item.hasStringValue()) continue;
            Object value = item.getValue();
            if (value == null) continue;
            String label = value.toString();
            if (label.length() > 512) label = label.substring(0, 512);
            node(item.getAddress(), label, "string");
            strings++;
            for (Reference reference : currentProgram.getReferenceManager().getReferencesTo(item.getAddress())) {
                Function caller = manager.getFunctionContaining(reference.getFromAddress());
                if (caller != null) edge(caller.getEntryPoint(), item.getAddress(), "references_string", "Reference observed at " + reference.getFromAddress());
            }
        }
        if (strings >= 5000) truncated = true;
        List<String> details = new ArrayList<>();
        SimpleBlockModel blocks = new SimpleBlockModel(currentProgram);
        DecompInterface decompiler = new DecompInterface();
        try {
            decompiler.openProgram(currentProgram);
            for (String text : selected) {
                if (text.isEmpty() || details.size() >= 5) continue;
                Address address = currentProgram.getAddressFactory().getAddress(text);
                Function function = address == null ? null : manager.getFunctionAt(address);
                if (function == null) continue;
                List<String> blockRows = new ArrayList<>(), flows = new ArrayList<>();
                CodeBlockIterator iterator = blocks.getCodeBlocksContaining(function.getBody(), monitor);
                int count = 0;
                while (iterator.hasNext() && count++ < 500 && !monitor.isCancelled()) {
                    CodeBlock block = iterator.next();
                    blockRows.add("{\"address\":" + q(block.getFirstStartAddress().toString()) + ",\"end\":" + q(block.getMaxAddress().toString()) + "}");
                    CodeBlockReferenceIterator destinations = block.getDestinations(monitor);
                    while (destinations.hasNext() && flows.size() < 2000) {
                        CodeBlockReference flow = destinations.next();
                        flows.add("{\"source\":" + q(flow.getSourceAddress().toString()) + ",\"target\":" + q(flow.getDestinationAddress().toString()) + ",\"type\":" + q(flow.getFlowType().toString()) + "}");
                    }
                }
                DecompileResults result = decompiler.decompileFunction(function, 15, monitor);
                String pseudo = result.decompileCompleted() ? result.getDecompiledFunction().getC() : null;
                if (pseudo != null && pseudo.length() > 8000) pseudo = pseudo.substring(0, 8000);
                details.add("{\"address\":" + q(text) + ",\"blocks\":[" + String.join(",", blockRows) +
                    "],\"flows\":[" + String.join(",", flows) + "],\"decompiled\":" + q(pseudo) +
                    ",\"evidence\":\"INFERRED\",\"note\":\"Decompiler reconstruction; original source equivalence is unverified.\"}");
            }
        } finally { decompiler.dispose(); }
        // With a matching PDB beside the binary (UE ships them) names are real symbols, not FUN_ addresses.
        boolean pdb = currentProgram.getOptions(Program.PROGRAM_INFO).getBoolean("PDB Loaded", false);
        String json = "{\"nodes\":[" + String.join(",", nodes) + "],\"edges\":[" + String.join(",", edges) +
            "],\"selectedFunctions\":[" + String.join(",", details) + "],\"truncated\":" + truncated + ",\"pdbLoaded\":" + pdb +
            ",\"language\":" + q(currentProgram.getLanguageID().toString()) +
            ",\"imageBase\":" + q(currentProgram.getImageBase().toString()) + "}";
        Files.writeString(Path.of(arguments[0]), json, StandardCharsets.UTF_8);
        println("Hub static graph exported: " + nodes.size() + " nodes, " + edges.size() + " edges");
    }
}
