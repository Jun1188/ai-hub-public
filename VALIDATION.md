# Validation status

This file is updated from actual release checks. A source snapshot, successful build, isolated profile launch, installed application test and a clean Windows test are distinct evidence.

- Source base: installed 1.32.60 application, 540 files before the public boundary; frozen 1.32.61 changes are applied while preserving the public guards.
- Public source variant: 1.32.61-public.1; private operational documentation and agent-local logs are excluded.
- Default HerdR 0.9.5 package: eight pinned supplier files including ConPTY and legal notices, with a verified version-specific staging script. No HerdR agent/server is started by the adapter test.
- Local native 1.32.60-public.1 preview: dashboard CPU/RAM/GPU and independent profile observed through Computer Use; a synthetic memory note was saved and remained visible after navigating away and returning. Restart persistence and final 1.32.61 interaction are separate.
- Preliminary 1.32.60-public.1 Setup: installed into a new local folder, launched with a separate empty APPDATA, captured a visible public first page with both queue entries and no renderer errors, then uninstalled. Setup SHA256 `295cfc95a754a6f2407df75d7816dd6cd8147fb34fdbde93f6034fadcc14c349`, 156519370 bytes. The in-place test uninstaller remains as a retained test fixture; no application process remains. This is not a clean Windows claim.
- Final source checks: public boundary 9 groups, HerdR adapter 18, queue projection 14, debugging 49, governor/tool routes 25 passed. The queue junction-escape case was skipped because symlink creation was unavailable. Debug/parser checks are not an assertion that real GPU ETW or physical devices were measured.
- Fresh Windows CI installer/first-run/uninstall: pending; no clean Windows VM or other physical PC has been claimed.
- Final 1.32.61-public.1 Setup and remote publication: pending.

The synthetic `test:public` boundary regression checks profile separation, retained private-profile bytes, disabled automatic account discovery and synchronization, and retained local work paths. It does not certify external providers, app installation or a clean machine.
