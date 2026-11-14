# AI Hub Lite

A public Windows desktop variant of AI Hub. This repository contains the application source rather than only the earlier four safety utilities. It uses a separate application ID and a separate data directory; existing private Hub installations are not imported.

The initial public profile includes local resource/status views, debugging, source analysis and learning, a knowledge browser, local memory, and the HerdR orchestration screen. Optional tools and authenticated providers must be configured by their owner. Missing tools are reported as unavailable. This build does not ship account credentials or models.

Automatic account discovery, credential reuse, private repository updates, Google Drive mirroring, Discord collection/publication, login startup and background model preparation are disabled. The MCP HTTP listener is off by default. Source and memory stay on the local machine unless the user explicitly configures and uses an external provider.

## Build

Windows x64, Node 24 and npm are required for development. Run `npm ci`, then `npm run test:public`. Runtime inputs are pinned in `scripts/release-runtimes.json`; `scripts/Verify-ReleaseRuntimes.ps1` verifies them before and after packaging. In PowerShell, run `./scripts/Get-PublicReleaseInputs.ps1 -DownloadRoot <new-build-input-folder>` to fetch the official pinned Electron, Node and HerdR inputs and set `AIHUB_ELECTRON_ZIP` in that shell. Then run `npm run dist -- --publish never`. The vendor executables are build inputs rather than Git-tracked files. The Windows workflow performs the same build followed by an isolated install/first-paint/uninstall check.

## Install and use

Use the published Setup to install in a new per-user directory. Open **AI Hub Lite** from its own shortcut. The dashboard shows local state; memory saves local notes; source analysis uses files chosen by the user. Existing private Hub profiles and client MCP configuration are not migrated. Closing the window exits by default. Uninstall through Windows installed-app settings; user data is retained unless the user removes it separately.

This is a public Lite variant, not a complete reproduction of the maintainer's private operational setup. Full-only background publishing and deployment automation are intentionally outside the public profile. See `public-profile.json` for the source boundary and `VALIDATION.md` for the exact checks and limitations. Until validation is complete, source previews are not an installation-success claim.

**Known limitations in 1.32.61:** the bundled HerdR 0.9.5 runtime launches and its version is verified. Task delivery has known adapter defects involving prompt argument rejection, Codex completion waits and onboarding readiness. Corrections are being prepared separately for 1.32.62. Claude onboarding and Antigravity workspace trust require the user's direct interaction. A successful agent task handoff is not certified by the package/version checks.

## License

Project code: MIT, copyright 2026 Jun1188. Third-party components retain their own licenses; see `THIRD-PARTY-NOTICES.md` and the included vendor license files. No signing certificate is bundled; any unsigned installer must be identified as unsigned in the release notes.
