// Hub-owned annotation of the analysis database (run with -process -noanalysis, not -readOnly).
// Renames and comments are saved in the Ghidra project only; the analyzed binary file is never written.
// Input: one edit per line, tab-separated: rename|comment <TAB> <function name or address> <TAB> <value> ("\n" escapes newlines).
// @category Hub.Analysis
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class HubAnnotate extends GhidraScript {
    private String q(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : String.valueOf(value).toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32) out.append(' ');
            else out.append(c);
        }
        return out.append('"').toString();
    }

    private Function lookup(String target) {
        if (target.matches("(0x)?[0-9a-fA-F]{4,16}")) {
            Address a = toAddr(target.startsWith("0x") ? target.substring(2) : target);
            Function f = a == null ? null : getFunctionContaining(a);
            if (f != null) return f;
        }
        Function match = null;
        for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
            if (f.getName().equals(target) || f.getName(true).equals(target)) {
                if (match != null) return null; // ambiguous: require an address
                match = f;
            }
        }
        return match;
    }

    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        List<String> rows = new ArrayList<>();
        for (String line : Files.readAllLines(Path.of(a[1]), StandardCharsets.UTF_8)) {
            String[] p = line.split("\t", 3);
            if (p.length < 3) continue;
            Function f = lookup(p[1]);
            String status;
            if (f == null) status = "target_not_found_or_ambiguous";
            else if (p[0].equals("rename")) {
                if (!p[2].matches("[A-Za-z_][A-Za-z0-9_:]{0,200}")) status = "invalid_name";
                else { String before = f.getName(true); f.setName(p[2], SourceType.USER_DEFINED); status = "renamed_from:" + before; }
            } else if (p[0].equals("comment")) {
                String text = p[2].replace("\\n", "\n");
                setPlateComment(f.getEntryPoint(), text.length() > 2000 ? text.substring(0, 2000) : text);
                status = "commented";
            } else status = "unknown_op";
            rows.add("{\"op\":" + q(p[0]) + ",\"target\":" + q(p[1]) + ",\"address\":" + (f == null ? "null" : q(f.getEntryPoint().toString())) + ",\"status\":" + q(status) + "}");
        }
        Files.writeString(Path.of(a[0]), "{\"program\":" + q(currentProgram.getName()) + ",\"edits\":[" + String.join(",", rows) + "]}", StandardCharsets.UTF_8);
    }
}
