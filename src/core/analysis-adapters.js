'use strict';
// Binary/artifact analysis runs through REA first (rea-analysis.js). These rows are what REA does not cover,
// Hub's own fallback, and knowledge sources for engine-source explanations. None is an installed integration.
// Typed manifest checked by adapter-resolver.js: tool is set only for tools Hub itself runs; capability "runtime"
// means the tool works inside or against a live process, so it needs a user gate and is never listed over MCP.
const row = (id, integration, target, supportedTargets, repository, evidence, extra = {}) => ({ id, integration, target, supportedTargets,
  repository, evidence, tool: null, capabilities: ['static'], userGate: 'none', incompatibleWith: [], dependencies: { hard: [], soft: [] }, ...extra });
const runtime = { capabilities: ['runtime'], userGate: 'approval' };
const references = [
  row('rea', 'primary', 'native / .NET / Electron-JS / Go / WASM / APK', ['native', 'dotnet', 'electron-js', 'go', 'wasm', 'apk'], 'https://github.com/morluto/rea',
    'REA evidence_id with stated limitations; Windows Ghidra provider is experimental and read-only', { tool: { name: 'rea-agents', range: '6.4.0' } }),
  // Hub does not pin a Ghidra release; any detected install is used.
  row('ghidra', 'hub-fallback-headless','native executable / library', ['native'], 'https://github.com/NationalSecurityAgency/ghidra',
    'addresses, imports, static calls; selected pseudocode is inferred', { tool: { name: 'ghidra', range: '*' } }),
  row('ilspy', 'reference-candidate', '.NET C# decompilation beyond REA metadata/CIL', ['dotnet'], 'https://github.com/icsharpcode/ILSpy',
    'C# reconstruction is inferred; requires a compatible local CLI'),
  row('cpp2il', 'reference-candidate', 'Unity IL2CPP', ['unity-il2cpp'], 'https://github.com/SamboyCoding/Cpp2IL',
    'metadata and address mapping; original bodies may be unavailable'),
  // Interop assemblies are generated from Cpp2IL output.
  row('il2cppinterop', 'reference-candidate', 'Unity IL2CPP runtime bridge', ['unity-il2cpp'], 'https://github.com/BepInEx/Il2CppInterop',
    'interop contracts; requires exact Unity/IL2CPP compatibility', { ...runtime, dependencies: { hard: ['cpp2il'], soft: [] } }),
  row('bepinex', 'reference-candidate', 'Unity plugin loading', ['unity-mono', 'unity-il2cpp'], 'https://github.com/BepInEx/BepInEx',
    'plugin lifecycle; requires game/runtime matching', { ...runtime, dependencies: { hard: ['harmonyx'], soft: ['il2cppinterop'] } }),
  row('harmonyx', 'reference-candidate', 'managed method interception', ['dotnet', 'unity-mono', 'unity-il2cpp'], 'https://github.com/BepInEx/HarmonyX',
    'runtime patch contracts; static analysis does not prove hook safety', runtime),
  row('ue4ss', 'reference-candidate', 'Unreal reflection / runtime inspection', ['unreal-game'], 'https://github.com/UE4SS-RE/RE-UE4SS',
    'reflection and generated SDK; exact game version is required', runtime),
  row('unreal-source-explained', 'knowledge-source', 'Unreal engine source (4.23-4.27) learning', ['unreal-source'], 'https://github.com/Jun1188/unreal_source_explained',
    'profiler-based module explanations; verify against the analyzed engine version'),
  row('unreal-engine-deepdive', 'knowledge-source', 'Unreal engine layer architecture (symbolmap/source-qa)', ['unreal-source'], 'https://github.com/Jun1188/UnrealEngineDeepDive',
    'architecture notes; not source evidence'),
  row('epic-official-docs', 'knowledge-source', 'Unreal Engine official documentation', ['unreal-source'], 'https://dev.epicgames.com/documentation/en-us/unreal-engine',
    'official API and system docs; cite version-specific pages'),
  row('skycraft', 'design-reference', 'host / guest game bridge', ['game-bridge'], 'https://github.com/chasmlol/SkyCraft',
    'separate state owners, heartbeat, epochs and explicit coordinate units', runtime),
  row('passthrough-mod-toolkit', 'design-reference', 'schema-driven local IPC', ['game-bridge'], 'https://github.com/Orinkle/passthrough-mod-toolkit',
    'protocol schema and fake host tests; not a ready game mod', runtime),
];
module.exports = { references };
