"""Hub bounded AST adapter. No model, provider key, or semantic extraction."""
from contextlib import redirect_stdout
import hashlib
import importlib.metadata
import json
import re
import sys
from pathlib import Path


def identifier(kind, text):
    return kind + ':' + hashlib.sha256(text.encode('utf-8')).hexdigest()[:20]


def engine_metadata(files, root):
    nodes, edges = [], []
    for file in files:
        rel = file.relative_to(root).as_posix()
        text = file.read_text(encoding='utf-8-sig')
        node_id = identifier('engine-config', rel)
        origin = {'source_file': rel, 'source_location': rel + ':1',
                  'evidence': 'EXTRACTED', 'confidence': 1.0}
        kind, links = None, []
        if file.suffix.lower() in ('.uplugin', '.uproject'):
            data = json.loads(text)
            kind = 'Unreal project/plugin'
            links = [('declares_module', row['Name']) for row in data.get('Modules', [])]
            links += [('configures_plugin', row['Name']) for row in data.get('Plugins', [])
                      if row.get('Enabled')]
        elif file.suffix.lower() == '.asmdef':
            data = json.loads(text)
            kind = 'Unity assembly'
            links = [('references_assembly', str(x)) for x in data.get('references', [])]
        elif file.name == 'manifest.json' and file.parent.name == 'Packages':
            kind = 'Unity package manifest'
            links = [('requires_package', name) for name in json.loads(text).get('dependencies', {})]
        elif file.name.endswith('.Build.cs'):
            kind = 'Unreal module build rules'
            for match in re.finditer(r'(Public|Private)DependencyModuleNames\s*\.\s*Add(?:Range)?\s*\((.*?)\)\s*;', text, re.S):
                line = text[:match.start()].count('\n') + 1
                links += [('declares_' + match.group(1).lower() + '_dependency', name, line)
                          for name in re.findall(r'"([^"\n]+)"', match.group(2))]
        if kind:
            nodes.append({'id': node_id, 'label': file.name, 'type': kind, **origin})
            for link in links:
                relationship, label = link[:2]
                line = link[2] if len(link) > 2 else 1
                target = identifier('configured', rel + ':' + label)
                nodes.append({'id': target, 'label': label, 'type': 'configured dependency',
                              **origin, 'source_location': rel + ':' + str(line)})
                edges.append({'source': node_id, 'target': target, 'relation': relationship,
                              **origin, 'source_location': rel + ':' + str(line),
                              'note': 'Configuration declaration; runtime loading is not confirmed.'})
    return nodes, edges


def main():
    if '--probe' in sys.argv:
        import graphify.extract
        print(json.dumps({'available': True, 'version': importlib.metadata.version('graphifyy')}))
        return
    request = json.load(sys.stdin)
    root = Path(request['root']).resolve()
    files = [Path(p).resolve() for p in request['files']]
    for file in files:
        file.relative_to(root)
    code = [file for file in files if file.suffix.lower() in
            ('.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs', '.js', '.jsx', '.ts', '.tsx', '.py')]
    # Graphify can print cache statistics. Stdout carries exactly one JSON response to the Hub.
    with redirect_stdout(sys.stderr):
        from graphify.extract import extract
        result = extract(code, cache_root=Path(request['cache']), root=root,
                         parallel=False, max_workers=2) if code else {'nodes': [], 'edges': []}
    config_nodes, config_edges = engine_metadata(files, root)
    result['nodes'] += config_nodes
    result['edges'] += config_edges
    # MonoBehaviour method declarations are observed; Unity runtime dispatch is inferred.
    lifecycle = {'Awake', 'OnEnable', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnDisable', 'OnDestroy'}
    for node in result['nodes']:
        method = re.sub(r'\(.*\)$', '', node.get('label', '').split('.')[-1])
        if str(node.get('source_file', '')).endswith('.cs') and method in lifecycle:
            node['lifecycle_candidate'] = 'Unity message name; MonoBehaviour inheritance/runtime dispatch requires confirmation'
    result['runtime'] = {'name': 'graphifyy', 'version': importlib.metadata.version('graphifyy'),
                         'semantic_tokens': 0, 'scope': 'explicit selected files'}
    unresolved = result.get('unresolved_calls', [])
    if unresolved:
        result.setdefault('warnings', []).append(f'{len(unresolved)} call targets were not statically resolved.')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
