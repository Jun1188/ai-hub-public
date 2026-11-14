"""Shader evidence table -> deterministic checks -> a `request` for the Hub's existing expert_reprompt tool.

  check TABLE.json [--payload OUT.json]   print the report; optionally write {"request", "target"} for expert_reprompt
  selftest                                run the synthetic cases in synthetic/ against expected.json

No GPU, no model, no Hub call. A check reports a finding only from values present in the table or in an attached
frame_capture_analyze result; anything absent is listed under notObserved, never guessed.
Table schema: README.md. Hub shapes used: frame_capture_analyze output {passes[{name, draws}], largestResources},
expert_reprompt input {request (1..8000 chars), target}.
"""
import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REQUEST_LIMIT = 8000  # expert_reprompt inputSchema: request maxLength
MIN_GROWTH_BYTES = 1 << 20


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def check_shader(shader, capture):
    findings, missing, unobserved = [], [], []

    def finding(check, evidence):
        findings.append(dict(check=check, evidence=evidence))

    for key in ('id', 'pass', 'stage'):
        if not shader.get(key):
            missing.append(key)
    # space and unit: both ends must be stated, otherwise there is nothing to compare
    for kind, field, check in (('coordinates', 'space', 'space-mismatch'), ('units', 'unit', 'unit-mismatch')):
        rows = shader.get(kind)
        if not rows:
            unobserved.append(kind)
            continue
        for row in rows:
            have, used = row.get(field), row.get('consumedAs')
            if not have or not used:
                missing.append('%s.%s' % (kind, row.get('name', '?')))
            elif have != used:
                finding(check, '%s is %s but consumed as %s' % (row.get('name', '?'), have, used))
    textures = shader.get('textures')
    if not textures:
        unobserved.append('textures')
    for texture in textures or []:
        have, used = texture.get('colorSpace'), texture.get('sampledAs')
        if have and used and have != used:
            finding('colorspace-mismatch', '%s is %s but sampled as %s' % (texture.get('name', '?'), have, used))
    seen = shader.get('observations') or {}
    measured = {}
    bad = [(key, seen[key]) for key in ('nanPixels', 'infPixels') if number(seen.get(key))]
    if not bad:
        unobserved.append('nan')
    for key, count in bad:
        measured[key] = count
        if count > 0:
            finding('nan', '%s=%d in the pass output' % (key, count))
    # draw calls: a measured count (table, else the attached capture's pass row) against a budget stated in the table
    draws = seen.get('drawCalls')
    basis = 'table'
    if not number(draws) and capture:
        matches = [p for p in capture.get('passes') or [] if p.get('name') == shader.get('pass')]
        if len(matches) == 1:
            draws, basis = matches[0].get('draws'), 'frame_capture_analyze'
    budget = seen.get('drawCallBudget')
    if number(budget):
        measured['drawCallBudget'] = budget
    if not number(draws):
        unobserved.append('drawcalls')
    else:
        measured.update(drawCalls=draws, drawSource=basis)
        if not number(budget):
            missing.append('drawCallBudget')
        elif draws > budget:
            finding('drawcalls', '%d draws in pass %s (%s) over budget %d' % (draws, shader.get('pass'), basis, budget))
    series = seen.get('resourceBytesByFrame')
    if isinstance(series, list) and series and all(number(v) for v in series):
        measured['resourceBytesByFrame'] = series
    if not isinstance(series, list) or len(series) < 3 or not all(number(v) for v in series):
        unobserved.append('resource-growth')
    elif all(b > a for a, b in zip(series, series[1:])) and series[-1] - series[0] >= MIN_GROWTH_BYTES:
        # growth in every sample is evidence of growth, not proof of a leak
        finding('resource-growth', 'resource bytes rose in all %d samples: %d -> %d' % (len(series), series[0], series[-1]))
    return dict(id=shader.get('id'), origin=(shader.get('capture') or {}).get('source', 'unstated'),
                findings=findings, measurements=measured, missingInputs=missing, notObserved=unobserved)


def build(table):
    if table.get('schemaVersion') != 1 or not isinstance(table.get('shaders'), list) or not table['shaders']:
        raise ValueError('Table needs schemaVersion 1 and a non-empty shaders list')
    capture = table.get('frameCapture')
    shaders = [check_shader(shader, capture) for shader in table['shaders']]
    lines = ['Diagnose these shader passes. Use only the evidence below; where an item is listed as not observed, say what to capture instead of guessing.',
             'Evidence origin per shader is stated; synthetic rows are not measurements of a real frame.']
    if capture:
        lines.append('Capture: api=%s events=%s drawCalls=%s passBasis=%s' % tuple(capture.get(k) for k in ('api', 'events', 'drawCalls', 'passBasis')))
    for shader, source in zip(shaders, table['shaders']):
        lines.append('')
        lines.append('[%s] pass=%s stage=%s origin=%s' % (shader['id'], source.get('pass'), source.get('stage'), shader['origin']))
        if shader['measurements']:
            lines.append('  measurements: ' + json.dumps(shader['measurements'], allow_nan=False))
        for row in source.get('textures') or []:
            lines.append('  texture %s format=%s colorSpace=%s sampledAs=%s' % tuple(row.get(k) for k in ('name', 'format', 'colorSpace', 'sampledAs')))
        for row in source.get('coordinates') or []:
            lines.append('  coordinate %s space=%s consumedAs=%s' % tuple(row.get(k) for k in ('name', 'space', 'consumedAs')))
        for row in source.get('units') or []:
            lines.append('  unit %s unit=%s consumedAs=%s' % tuple(row.get(k) for k in ('name', 'unit', 'consumedAs')))
        for item in shader['findings']:
            lines.append('  FINDING %s: %s' % (item['check'], item['evidence']))
        if shader['missingInputs']:
            lines.append('  missing inputs: ' + ', '.join(shader['missingInputs']))
        if shader['notObserved']:
            lines.append('  not observed: ' + ', '.join(shader['notObserved']))
    request = '\n'.join(lines)
    if len(request) > REQUEST_LIMIT:
        raise ValueError('Request is %d chars, over expert_reprompt limit %d; split the table' % (len(request), REQUEST_LIMIT))
    return dict(schemaVersion=1, shaders=shaders, request=request)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def selftest():
    expected = load(ROOT / 'synthetic/expected.json')['cases']
    for name, want in expected.items():
        report = build(load(ROOT / 'synthetic' / (name + '.json')))
        got = {shader['id']: dict(checks=sorted(item['check'] for item in shader['findings']),
                                  missingInputs=sorted(shader['missingInputs']), notObserved=sorted(shader['notObserved']))
               for shader in report['shaders']}
        want = {key: dict(checks=sorted(value['checks']), missingInputs=sorted(value.get('missingInputs', [])),
                          notObserved=sorted(value.get('notObserved', []))) for key, value in want.items()}
        assert got == want, '%s\n got  %s\n want %s' % (name, json.dumps(got), json.dumps(want))
        assert 0 < len(report['request']) <= REQUEST_LIMIT
    for bad in (dict(), dict(schemaVersion=1, shaders=[])):
        try:
            build(bad)
        except ValueError:
            continue
        raise AssertionError('an empty table was accepted')
    print('selftest ok: %d cases' % len(expected))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    checker = sub.add_parser('check')
    checker.add_argument('table')
    checker.add_argument('--payload')
    sub.add_parser('selftest')
    args = parser.parse_args()
    if args.command == 'selftest':
        return selftest()
    report = build(load(args.table))
    if args.payload:
        Path(args.payload).write_text(json.dumps(dict(request=report['request'], target='agent'), ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    sys.stdout.buffer.write((json.dumps(report, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit('shader_table: ' + str(error))
