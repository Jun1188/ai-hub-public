"""Fetch an explicitly approved remote and deliver its hash-guarded Hub overlay.

The working tree and active agent context stay unchanged. A running GUI only
checks; the detached worker applies after the GUI exits.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import zipfile


HUB_ORIGINS = {"https://github.com/your-org/your-shared-context.git",
               "git@github.com:your-org/your-shared-context.git"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def git(repo, *args, binary=False):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never",
           "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=10"}
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false",
         "-c", "submodule.recurse=false", "-C", str(repo), *args],
        capture_output=True, timeout=45, env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        # Git output can contain credentials embedded in a remote URL.
        raise RuntimeError("Git 작업 실패: " + args[0] + ". 원격 연결과 권한을 확인하세요.")
    return result.stdout if binary else result.stdout.decode("utf-8", errors="replace").strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dependency_contract(package, lock):
    return {
        "package": {key: package.get(key) for key in
                    ("dependencies", "optionalDependencies", "engines", "type")},
        "electron": package.get("devDependencies", {}).get("electron"),
        "lock": {key: value for key, value in lock.get("packages", {}).items() if key},
        "legacy": lock.get("dependencies"),
    }


def discard_plugin_copy(store, folder):
    """Preserve prior plugin sources and staging until exact cleanup approval."""
    return


def refresh_plugin(root, settings_path, settings, hub_version):
    """Use Codex's installer; never edit its managed cache or activation state."""
    if settings.get("plugin", {}).get("enabled") is not True:
        return {"status": "disabled", "message": "이 PC의 플러그인 자동 갱신 승인이 필요합니다."}
    executable = settings["plugin"].get("codex") or shutil.which("codex.exe") or shutil.which("codex")
    if not executable or not Path(executable).is_file():
        raise RuntimeError("플러그인 자동 갱신에 Codex CLI가 필요합니다. 설치 경로를 확인해 주세요.")
    source = root / "plugins/ai-hub-panel"
    if not (source / ".codex-plugin/plugin.json").is_file():
        raise RuntimeError("원격에 ai-hub 플러그인 패키지가 없습니다. 플러그인 배포를 요청해 주세요.")
    # Stable local authoring source, not a managed Codex cache. No temporary marketplace roots.
    # Documents avoids a packaged Codex process registering a virtualized AppData source.
    store = Path(settings["repository"]).resolve().parent / ".codex-hub-plugin-source"
    files = {str(p.relative_to(source)).replace("\\", "/"): p.read_bytes()
             for p in source.rglob("*") if p.is_file()}
    plugin_manifest = read_json(source / ".codex-plugin/plugin.json")
    if plugin_manifest.get("name") != "ai-hub-panel":
        raise RuntimeError("ai-hub 플러그인 패키지 이름이 다릅니다.")
    # A Hub-only update must still trigger a fresh plugin installation/version label.
    plugin_manifest["version"] = hub_version
    # User-approved exception: Codex's plugin JSON parser rejects a UTF-8 BOM.
    files[".codex-plugin/plugin.json"] = (json.dumps(plugin_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if ".mcp.json" in files:
        files[".mcp.json"] = files[".mcp.json"].decode("utf-8-sig").encode("utf-8")
    fingerprint = hashlib.sha256()
    for name, data in sorted(files.items()):
        fingerprint.update(name.encode("utf-8") + b"\0" + data + b"\0")
    identity = fingerprint.hexdigest()
    state_path = settings_path.parent / "repository-plugin-state.json"
    previous = read_json(state_path) if state_path.is_file() else {}
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    cache_root = codex_home / "plugins/cache/ai-hub-local/ai-hub-panel"
    def installed():
        return any(all((cache / name).is_file() and (cache / name).read_bytes() == data
                       for name, data in files.items()) for cache in (cache_root / hub_version, cache_root / "local"))
    if previous.get("sha256") == identity and installed():
        return {"status": "up-to-date", "version": hub_version, "message": "플러그인도 최신입니다."}
    store.mkdir(parents=True, exist_ok=True)
    # Replace the source only after all the committed plugin files have been prepared.
    stage = Path(tempfile.mkdtemp(prefix=".plugin-source-", dir=store))
    target = store / "plugins/ai-hub-panel"
    backup = store / ("previous-plugin-" + uuid.uuid4().hex)
    # Every directory move stays within this device's approved authoring-source folder.
    for folder in (stage, target, backup):
        if not folder.resolve().is_relative_to(store.resolve()):
            raise RuntimeError("플러그인 원본 경로가 승인 폴더 밖을 가리킵니다.")
    try:
        for name, data in files.items():
            file = stage / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        if target.exists():
            target.rename(backup)
        target.parent.mkdir(parents=True, exist_ok=True)
        stage.rename(target)
        market = store / ".agents/plugins/marketplace.json"
        market.parent.mkdir(parents=True, exist_ok=True)
        market.write_bytes((root / ".agents/plugins/marketplace.json").read_bytes())
        def codex(*arguments):
            result = subprocess.run([str(executable), "plugin", *arguments], cwd=store,
                                    capture_output=True, timeout=45,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode:
                raise RuntimeError("Codex CLI 플러그인 갱신 실패. 마켓플레이스와 설치 권한을 확인해 주세요.")
            return result.stdout.decode("utf-8", errors="replace")
        registration = json.loads(codex("marketplace", "add", str(store), "--json"))
        if Path(registration["installedRoot"]).resolve() != store.resolve():
            raise RuntimeError("ai-hub 마켓플레이스가 다른 원본 폴더를 사용합니다. 원본 경로 갱신을 요청해 주세요.")
        codex("add", "ai-hub-panel@ai-hub-local", "--json")
        if not installed():
            raise RuntimeError("플러그인 설치 파일이 원본과 다릅니다. Codex 플러그인 새로고침을 요청해 주세요.")
        state_path.write_text(json.dumps({"version": hub_version, "sha256": identity}, indent=2) + "\n", encoding="utf-8-sig")
        cleanup_warning = ""
        try:
            discard_plugin_copy(store, backup)
        except (OSError, RuntimeError):
            cleanup_warning = " 플러그인 임시 복사본 정리를 보류했습니다."
        return {"status": "installed", "version": hub_version,
                "message": "플러그인을 자동 설치했습니다. 사용 중인 Codex는 다시 열면 새 패키지를 읽습니다." + cleanup_warning}
    except Exception:
        # Keep the previous local source available if registration/installation failed.
        if backup.exists():
            if target.exists():
                failed = store / ("failed-plugin-" + uuid.uuid4().hex)
                if not failed.resolve().is_relative_to(store.resolve()):
                    raise RuntimeError("플러그인 복구 경로가 승인 폴더 밖을 가리킵니다.")
                target.rename(failed)
            backup.rename(target)
        raise
    finally:
        # If preparation failed before the rename, no installed source refers to this stage.
        try:
            discard_plugin_copy(store, stage)
        except (OSError, RuntimeError):
            pass


def read_approval(settings_path):
    try:
        settings = read_json(settings_path)
    except FileNotFoundError:
        return None
    except (ValueError, OSError) as error:
        raise RuntimeError("자동 갱신 승인 파일의 형식과 접근 권한을 확인하세요.") from error
    if (not isinstance(settings, dict) or type(settings.get("schemaVersion")) is not int
            or settings["schemaVersion"] != 1 or not isinstance(settings.get("enabled"), bool)):
        raise RuntimeError("자동 갱신 승인 파일의 형식을 확인하세요.")
    return settings


def set_approval(settings_path, hub, repository, panel_executable=None):
    """Called under repository-update.lock. No fetch, sync or plugin enrollment."""
    previous = read_approval(settings_path)
    enabled = repository is not None
    settings = dict(previous or {}, schemaVersion=1, enabled=enabled)
    if enabled:
        repo = Path(repository).resolve(strict=True)
        origin = git(repo, "remote", "get-url", "origin")
        if origin not in HUB_ORIGINS:
            raise RuntimeError("your-org/your-shared-context 원본 저장소를 선택하세요.")
        if Path(git(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
            raise RuntimeError("공유 저장소의 최상위 폴더를 선택하세요.")
        if (not (hub / "package-lock.json").is_file()
                or not read_json(hub / "package.json").get("devDependencies", {}).get("electron")):
            raise RuntimeError("이 Hub 설치본에 잠금 파일 또는 Electron 버전 정보가 없습니다. 호환 설치본이 필요합니다.")
        if previous and previous["enabled"] and (
                Path(previous["repository"]).resolve() != repo or previous["origin"] != origin):
            raise RuntimeError("다른 저장소가 이미 승인되어 있습니다. 설정을 다시 여세요.")
        settings.update(repository=str(repo), origin=origin)
        if panel_executable:
            codex = Path(panel_executable).resolve(strict=True)
            if not codex.is_file() or codex.name.lower() != "codex.exe":
                raise RuntimeError("패널 등록에 사용할 Codex 실행 파일을 확인하세요.")
            settings["plugin"] = {**settings.get("plugin", {}), "enabled": True, "codex": str(codex)}
    if settings != previous and (enabled or previous is not None):
        if previous is not None:
            shutil.copyfile(settings_path, settings_path.with_name(settings_path.name + ".before-toggle-" + uuid.uuid4().hex))
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=settings_path.parent,
                                         prefix=".hub-toggle-", delete=False) as stream:
            json.dump(settings, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(stream.name, settings_path)
    return {"status": "not-checked" if enabled else "disabled",
            "message": "이 PC에서 Hub 자동 갱신을 켰습니다." if enabled else "이 PC에서 Hub 자동 갱신을 껐습니다."}


def sync(settings_path, hub, check_only=False, lite=False, expected_commit=None, recover=False):
    settings = read_approval(settings_path)
    if not settings or not settings["enabled"]:
        return {"status": "disabled", "message": "저장소 자동 갱신이 승인되지 않았습니다."}
    if (not all(isinstance(settings.get(key), str) for key in ("origin", "repository"))
            or settings["origin"] not in HUB_ORIGINS or not Path(settings["repository"]).is_absolute()):
        raise RuntimeError("이 PC에 승인된 저장소의 경로나 원격 주소가 올바르지 않습니다.")
    repo = Path(settings["repository"]).resolve(strict=True)
    if not (hub / "package.json").is_file():
        raise RuntimeError("기존 앱 폴더에서만 교체할 수 있습니다. 압축 앱 또는 누락된 앱 경로는 적용을 보류합니다.")
    if git(repo, "remote", "get-url", "origin") != settings["origin"]:
        raise RuntimeError("원격 주소가 승인값과 다릅니다. 자동 갱신 설정을 다시 확인해 주세요.")
    if Path(git(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
        raise RuntimeError("승인된 저장소의 최상위 폴더를 확인하세요.")
    # Never alter the checkout: installed skills/memories may point into it.
    if recover:
        if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", expected_commit or ""):
            raise RuntimeError("복구할 갱신의 커밋을 확인할 수 없습니다.")
        # The original apply already fetched this object. Later network changes must not change the repair target.
        git(repo, "merge-base", "--is-ancestor", expected_commit, "refs/remotes/origin/main")
        commit = expected_commit
    else:
        git(repo, "fetch", "--no-tags", "--no-recurse-submodules", "origin",
            "refs/heads/main:refs/remotes/origin/main")
        commit = git(repo, "rev-parse", "refs/remotes/origin/main")
        if expected_commit and commit != expected_commit:
            return {"status": "changed", "safeToRelaunch": True,
                    "message": "확인한 뒤 원격 버전이 바뀌었습니다. 업데이트 확인을 다시 실행하세요."}
    archive = git(repo, "archive", "--format=zip", commit,
                  "integrations/ai-hub", "tools/hub_overlay.py", "plugins/ai-hub-panel",
                  ".agents/plugins/marketplace.json", binary=True)
    with tempfile.TemporaryDirectory(prefix="aihub-update-") as folder:
        root = Path(folder)
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            for entry in bundle.infolist():
                target = (root / entry.filename).resolve()
                if not target.is_relative_to(root) or entry.external_attr >> 16 & 0o170000 == 0o120000:
                    raise RuntimeError("업데이트 묶음에 허용되지 않은 경로가 있습니다.")
            bundle.extractall(root)
        overlay = root / "integrations/ai-hub/overlay"
        manifest_path = root / "integrations/ai-hub/manifest.json"
        manifest = read_json(manifest_path)
        installed = read_json(hub / "package.json")
        target_package = read_json(overlay / "package.json")
        def version(value):
            return tuple(int(part) for part in value.split("."))
        if version(installed["version"]) > version(target_package["version"]):
            return {"status": "local-newer", "commit": commit,
                    "message": "저장소 fetch 완료. 설치본이 원격보다 새 버전이므로 유지합니다."}
        required_lite = ("src/core/device-profile.js", "src/core/feature-profile.js", "scripts/Launch-LiteHub.ps1")
        if lite and any(not (overlay / rel).is_file() for rel in required_lite):
            raise RuntimeError("경량 버전 필수 파일이 없습니다. 일반판의 경량 자동 패치를 보류했습니다. 경량 배포본을 제공하거나 복구를 승인해 주세요.")
        if not (hub / "package-lock.json").is_file():
            raise RuntimeError("기존 앱에 의존성 잠금 파일이 없어 안전한 교체를 확인할 수 없습니다. 같은 경로의 초기 구성을 요청해 주세요.")
        if dependency_contract(installed, read_json(hub / "package-lock.json")) != dependency_contract(
                target_package, read_json(overlay / "package-lock.json")):
            raise RuntimeError("새 의존성 또는 Electron 런타임이 필요해 파일 교체를 보류했습니다. 같은 앱 경로의 런타임 갱신을 요청해 주세요. Setup은 실행하지 않습니다.")
        # Check all downloaded source hashes before executing the delivery tool.
        for item in manifest["files"]:
            rel = Path(item["path"])
            source = (overlay / rel).resolve()
            destination = (hub / rel).resolve()
            if not source.is_relative_to(overlay.resolve()) or not destination.is_relative_to(hub):
                raise RuntimeError("Manifest 경로가 앱 폴더 밖을 가리킵니다.")
            if not item.get("deleted") and digest(source) != item["sha256"]:
                raise RuntimeError("업데이트 원본 해시가 다릅니다: " + item["path"])
        spec = importlib.util.spec_from_file_location("hub_delivery", root / "tools/hub_overlay.py")
        delivery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(delivery)
        # Keep backups outside the temporary export; the checkout is never patched.
        delivery.ROOT, delivery.OVERLAY, delivery.MANIFEST = repo, overlay, manifest_path
        _, rows = delivery.classify(hub)
        blocked = [row["path"] for row in rows if row["state"] in ("missing", "other")]
        if blocked:
            raise RuntimeError("현지 변경 또는 필수 파일 누락으로 적용 보류: " + ", ".join(blocked[:5]) + ". 파일 비교와 복구를 요청해 주세요.")
        changed = [row["path"] for row in rows if row["state"] != "same"]
        result = {"status": "up-to-date", "commit": commit, "version": manifest["resultHubVersion"],
                  "changed": len(changed), "message": "저장소 fetch 완료. 최신 앱 소스입니다."}
        # Read-only hash check; the repair itself (and any download) happens only in the apply run after the Hub exits.
        herdr_missing = getattr(delivery, "herdr_missing", lambda _hub: False)(hub)
        if changed and check_only:
            result.update(status="pending", message="저장소 fetch 완료. 앱을 완전히 종료한 뒤 다시 실행하면 업데이트를 적용합니다.")
        elif herdr_missing and check_only:
            result.update(status="pending", herdr={"status": "missing"},
                          message="앱 소스는 최신이지만 Herdr 기본 런타임이 없거나 검토본과 다릅니다. 동기화를 적용하면 복구합니다.")
        elif herdr_missing and not changed:
            result.update(status="applied", backup=None, herdr=delivery.repair_herdr(hub),
                          message="앱 소스는 최신입니다. Herdr 기본 런타임을 검증해 복구했습니다.")
        elif changed:
            try:
                applied = delivery.apply(hub, delivery.manifest_id())
            except RuntimeError as error:
                if not isinstance(error, getattr(delivery, "RollbackVerified", ())):
                    raise
                # A failed repair can roll back to a *mixed* tree left by the interrupted first attempt.
                runtime = getattr(error, "runtimeRollback", None)
                return {"status": "rolled-back", "commit": commit, "backup": error.backup, "safeToRelaunch": not recover,
                        "runtimeRollback": runtime,
                        "message": "파일 교체가 실패하여 기존 파일의 해시를 확인하고 복구했습니다." + (
                            " Herdr 런타임 일부는 되돌리지 못했습니다: " + ", ".join(runtime["failedFiles"])
                            if runtime and not runtime["ok"] else "")}
            result.update(status="applied", backup=applied["backup"], cleanup=applied["cleanup"], herdr=applied.get("herdr"),
                          message="기존 앱 경로에 최신 파일을 교체했습니다. 바로가기와 저장소 경로는 유지합니다.")
        if not check_only and not changed:
            result["cleanup"] = delivery.prune_backups(hub)
        if result.get("cleanup", {}).get("warnings"):
            result["message"] += " 복구 백업 일부의 자동 정리를 보류했습니다."
        try:
            # During live sync, install only the plugin paired with the currently loaded Hub.
            if changed and check_only:
                plugin = {"status": "pending", "message": "플러그인은 앱 소스와 함께 다음 실행에 갱신합니다."}
            else:
                plugin = refresh_plugin(root, Path(settings_path), settings, manifest["resultHubVersion"])
        except Exception as error:
            plugin = {"status": "blocked", "message": str(error) if isinstance(error, RuntimeError)
                      else "플러그인 자동 갱신을 완료하지 못했습니다. 설치 권한을 확인해 주세요."}
        result["plugin"] = plugin
        result["message"] += " " + plugin["message"]
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", required=True)
    parser.add_argument("--hub", required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--lite", action="store_true")
    permission = parser.add_mutually_exclusive_group()
    permission.add_argument("--enable-for", "--enroll", dest="enable_for", metavar="REPOSITORY")
    permission.add_argument("--disable", action="store_true")
    parser.add_argument("--expected-commit")
    parser.add_argument("--recover", action="store_true", help="Finish an interrupted update from its reviewed local commit")
    parser.add_argument("--panel-executable")
    args = parser.parse_args()
    settings = Path(args.settings)
    hub = Path(args.hub).resolve(strict=True)
    configuring = args.enable_for is not None or args.disable
    if configuring:
        settings.parent.mkdir(parents=True, exist_ok=True)
    # OS-owned advisory lock is released even if a previous updater was killed.
    with (settings.parent / "repository-update.lock").open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            result = {"status": "busy", "message": "다른 Hub 갱신 작업이 실행 중입니다. 다음 동기화에서 다시 확인합니다."}
        else:
            try:
                result = (set_approval(settings, hub, args.enable_for, args.panel_executable) if configuring
                          else sync(settings, hub, args.check_only, args.lite, args.expected_commit, args.recover))
            except (Exception, SystemExit) as error:
                message = str(error) if isinstance(error, RuntimeError) else "자동 갱신에 실패했습니다. 연결·설정·설치 폴더 권한을 확인해 주세요."
                result = {"status": "blocked", "message": message}
        if not configuring:
            (settings.parent / "repository-update-result.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8-sig")
        print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
