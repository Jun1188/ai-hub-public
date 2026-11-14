# Third-party notices

AI Hub project code is licensed under MIT; that license does not replace third-party licenses.

- Electron 45.2.3 is distributed under its MIT license together with Chromium and other bundled components. Packaged binaries include `LICENSE.electron.txt` and `LICENSES.chromium.html`.
- The pinned Node.js runtime includes `resources/runtime/LICENSE-node.txt`. Its embedded third-party notices remain intact.
- Font Awesome vendor files preserve their CSS license and SIL Open Font License in `ui/vendor/font-awesome/`.
- GrapesJS vendor files preserve the BSD 3-Clause license and provenance in `ui/vendor/grapesjs/`.
- npm runtime dependencies are installed from the lockfile and distributed with their license/notice files. Dependency names, versions and SPDX metadata are recorded in `THIRD-PARTY-NPM.json` during the release preparation.
- The npm distributions of `@sapphire/async-queue` 1.5.5 and `@sapphire/snowflake` 3.5.3/3.5.5 omit an adjacent license file. Their supplier MIT text is included in `THIRD-PARTY-LICENSES/`, fetched from exact release-tag commits in sapphiredev/utilities: `36268acb83cc613e06836f6ebbdafeeba99c2365`, `bff73579e844cf9c9f4832cb68a8b87e88cb5f64`, and `dd52b66fc63099b2f95163eebd4df23c26b1cd16`, respectively. The nested fast-uri benchmark fixture is covered by its parent package's included ISC license.
- HerdR 0.9.5 is bundled by default under Apache-2.0. Its full directory includes the original Microsoft ConPTY runtime and legal notices. See `resources/herdr/herdr-manifest.json`, `LICENSE-herdr.txt`, and `THIRD-PARTY-NOTICES/` beside the installed HerdR executable. The supplier archive and all eight files are SHA256 pinned; the supplier executable is unsigned. The project MIT license does not replace these licenses.
