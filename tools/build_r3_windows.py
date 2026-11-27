#!/usr/bin/env python3
"""Prepare, build, and package the Windows thin client for R3 Code."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://github.com/longbridge/nsh.git"
NSH_VERSION = "0.7.1"
NSH_COMMIT = "f78eace7af23a9c1c72605c7ee46204f57f3e8e6"
WINDOWS_PATCH = ROOT / "third_party/nsh-host-patches/windows-nsh-v0.7.1.patch"
DEFAULT_NSH_SOURCE = ROOT / "build/nsh-windows-sources" / f"v{NSH_VERSION}-{NSH_COMMIT[:12]}"

SPEECH_IMPORT_RE = re.compile(
    r'(import\s*\{[^}]*?),\s*Speech\b([^}]*\}\s*from\s*"nsh";)'
)
SPEECH_SHIM = (
    "\nconst Speech = {\n"
    "  available: async () => false,\n"
    "  start: () => ({ stop() {}, abort() {} }),\n"
    "};\n"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def marker_value(patch_path: Path = WINDOWS_PATCH) -> str:
    normalized = patch_path.read_bytes().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(normalized).hexdigest()
    return f"{NSH_COMMIT}:{digest}\n"


def prepare_nsh_source(output: Path, upstream: str = ORIGIN, patch_path: Path = WINDOWS_PATCH) -> Path:
    output = output.absolute()
    marker = output / ".git/r3-windows-nsh"
    expected = marker_value(patch_path)
    if marker.is_file() and marker.read_text(encoding="utf-8") == expected:
        return output
    if output.exists() or output.is_symlink():
        raise FileExistsError(
            f"Windows NSH source destination already exists with unexpected state: {output}"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-nsh-win-", dir=output.parent) as temporary:
        temp_path = Path(temporary)
        checkout = temp_path / "checkout"
        checkout.mkdir()

        def git(*args: str) -> None:
            subprocess.run(["git", "-C", str(checkout), *args], check=True)

        git("init", "--quiet")
        git("config", "core.autocrlf", "false")
        git("config", "core.eol", "lf")
        git("remote", "add", "origin", upstream)
        git("fetch", "--quiet", "--depth=1", "origin", NSH_COMMIT)
        git("checkout", "--quiet", "--detach", NSH_COMMIT)
        lf_patch = temp_path / "windows-nsh.patch"
        lf_patch.write_bytes(patch_path.resolve(strict=True).read_bytes().replace(b"\r\n", b"\n"))
        git("apply", "--index", "--whitespace=nowarn", str(lf_patch))
        (checkout / ".git/r3-windows-nsh").write_text(expected, encoding="utf-8")
        checkout.rename(output)
    return output


def windows_manifest(manifest: dict) -> dict:
    updated = json.loads(json.dumps(manifest))
    caps = updated.setdefault("capabilities", {})
    caps["windows"] = True
    caps["homeDir"] = True
    caps["application"] = True
    caps["notifications"] = True
    caps["audio"] = True

    fs_caps = caps.setdefault("fs", {})
    fs_read = list(fs_caps.get("read", []))
    for entry in ("${homeDir}", "${dataDir}"):
        if entry not in fs_read:
            fs_read.append(entry)
    fs_caps["read"] = fs_read

    proc_caps = caps.setdefault("process", {})
    proc_env = list(proc_caps.get("env", []))
    for var in ("USERPROFILE", "APPDATA", "LOCALAPPDATA"):
        if var not in proc_env:
            proc_env.append(var)
    proc_caps["env"] = proc_env

    proc_exec = list(proc_caps.get("execute", []))
    if "ssh.exe" not in proc_exec:
        proc_exec.append("ssh.exe")
    proc_caps["execute"] = proc_exec

    host_caps = list(caps.get("host", []))
    for capability in ("secureStorage.*", "dialogs.pickFiles", "r3.*"):
        if capability not in host_caps:
            host_caps.append(capability)
    caps["host"] = host_caps
    return updated


def adapt_composer_for_v07(source: str) -> str:
    """NSH 0.7 moved Speech into nsh-extra; replace the nsh import in the staged Windows copy."""
    updated, count = SPEECH_IMPORT_RE.subn(r"\1\2" + SPEECH_SHIM, source, count=1)
    if count != 1:
        raise ValueError("Could not locate Speech import in Composer.tsx for NSH 0.7 staging")
    return updated


def standalone_build_identity(
    root: Path = ROOT,
    host_exe: Path | None = None,
    nsh_commit: str = NSH_COMMIT,
) -> dict:
    def git_out(*args: str) -> str:
        try:
            return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
        except Exception:
            return "unknown"

    release = json.loads((root / "t3-release.json").read_text(encoding="utf-8"))
    official_version = release["version"]
    official_sha = release["commit"][:9]
    dirty = bool(git_out("status", "--porcelain", "--untracked-files=normal"))
    identity: dict = {
        "r3Version": (root / "R3_VERSION").read_text(encoding="utf-8").strip(),
        "r3Sha": git_out("rev-parse", "--short=9", "HEAD"),
        "r3Dirty": dirty,
        "t3Version": official_version,
        "t3Sha": official_sha,
        "t3Dirty": False,
        "referenceT3Version": official_version,
        "referenceT3Sha": official_sha,
        "referenceT3Dirty": False,
        "officialT3Version": official_version,
        "officialT3Sha": official_sha,
        "nshVersion": NSH_VERSION,
        "nshCommit": nsh_commit,
        "platform": "windows",
    }
    if host_exe is not None and host_exe.is_file():
        identity["hostExecutableSha256"] = sha256_file(host_exe)
    return identity


def _copy_ignore(app_dir: Path):
    def ignore(directory: str, names: list[str]) -> set[str]:
        here = Path(directory)
        ignored: set[str] = set()
        for name in names:
            if (
                name in {".nsh", "node_modules", "__pycache__"}
                or name.endswith((".test.ts", ".test.tsx", ".log"))
                or "Fixture" in name
            ):
                ignored.add(name)
        if here == app_dir:
            for name in names:
                if name.endswith(".png") or name == "usage-probe":
                    ignored.add(name)
        return ignored

    return ignore


WINDOWS_SHIKI_STUB = (
    'const PLAIN = new Set(["", "text", "txt", "plain", "plaintext"]);\n'
    "export function shikiHasLanguage(id) {\n"
    '  return typeof id === "string" && id.length > 0 && !PLAIN.has(id.toLowerCase());\n'
    "}\n"
    "export function shikiLoadLanguageSync() { return false; }\n"
    "export function shikiTokens() { return null; }\n"
    "export function shikiTokensFromState() { return null; }\n"
)

WINDOWS_MATHJAX_STUB = (
    'export function texToSvg() { throw new Error("native math"); }\n'
)


STAGE_MARKER = ".r3-windows-stage"
BUNDLE_MARKER = ".r3-windows-bundle"


def _is_within(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def _paths_overlap(a: Path, b: Path) -> bool:
    return _is_within(a, b) or _is_within(b, a)


def _validate_cleanable_dir(
    target: Path,
    *,
    root: Path,
    extra_inputs: tuple[Path, ...] = (),
    is_owned,
    label: str,
) -> Path:
    if target.is_symlink():
        raise ValueError(f"Refusing to replace symlink at {label}: {target}")
    resolved_target = target.resolve(strict=False)
    resolved_root = root.resolve(strict=False)
    if resolved_target == resolved_target.parent:
        raise ValueError(f"Refusing to use filesystem root as {label}: {resolved_target}")
    if _is_within(resolved_root, resolved_target):
        raise ValueError(f"Refusing to overwrite repository root with {label}: {resolved_target}")
    protected = [
        resolved_root / name
        for name in ("t3ui", "tools", "third_party", "server-rs", "assets", "LICENSES", ".git")
    ]
    protected.extend(path.resolve(strict=False) for path in extra_inputs)
    for item in protected:
        if _paths_overlap(resolved_target, item):
            raise ValueError(f"Refusing to use {label} path overlapping input {item}: {resolved_target}")
    if resolved_target.exists():
        if not resolved_target.is_dir():
            raise ValueError(f"Refusing to overwrite non-directory at {label}: {resolved_target}")
        if any(resolved_target.iterdir()) and not is_owned(resolved_target):
            raise ValueError(
                f"Refusing to delete unowned non-empty directory at {label}: {resolved_target}"
            )
    return resolved_target


def validate_build_destinations(
    stage_dir: Path | None,
    output_dir: Path,
    *,
    root: Path = ROOT,
    extra_inputs: tuple[Path, ...] = (),
) -> tuple[Path | None, Path]:
    output_inputs = extra_inputs + ((stage_dir,) if stage_dir is not None else ())
    validated_output = _validate_cleanable_dir(
        output_dir,
        root=root,
        extra_inputs=output_inputs,
        is_owned=_is_owned_bundle_dir,
        label="output directory",
    )
    validated_stage: Path | None = None
    if stage_dir is not None:
        validated_stage = _validate_cleanable_dir(
            stage_dir,
            root=root,
            extra_inputs=extra_inputs + (validated_output,),
            is_owned=_is_owned_stage_dir,
            label="stage directory",
        )
    return validated_stage, validated_output


def _replace_directory_atomically(staged: Path, target: Path) -> None:
    backup: Path | None = None
    if target.exists():
        backup = target.parent / f".{target.name}.old-{os.getpid()}-{hashlib.sha256(str(staged).encode()).hexdigest()[:8]}"
        if backup.exists():
            shutil.rmtree(backup)
        target.rename(backup)
    try:
        staged.rename(target)
    except Exception:
        if backup is not None and backup.exists() and not target.exists():
            backup.rename(target)
        raise
    if backup is not None and backup.exists():
        shutil.rmtree(backup)


def _is_owned_stage_dir(path: Path) -> bool:
    return (path / STAGE_MARKER).is_file()


def _is_owned_bundle_dir(path: Path) -> bool:
    return (path / BUNDLE_MARKER).is_file() or (
        (path / "R3 Code.exe").is_file() and (path / "nsh/bundle.nshc").is_file()
    )


def extract_native_licenses_json(ts_path: Path) -> dict:
    """Extract the JSON payload from t3ui/pages/settings/nativeDependencyNotices.ts."""
    source = ts_path.read_text(encoding="utf-8")
    marker = "export const nativeLicenseData"
    start = source.find(marker)
    if start == -1:
        raise ValueError(f"Could not find nativeLicenseData export in {ts_path}")
    eq = source.find("=", start)
    brace = source.find("{", eq) if eq != -1 else -1
    end = source.rfind("}")
    if brace == -1 or end == -1 or end <= brace:
        raise ValueError(f"Could not locate JSON object in {ts_path}")
    payload = json.loads(source[brace : end + 1])
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("texts"), list)
        or not isinstance(payload.get("packages"), list)
        or len(payload["packages"]) == 0
    ):
        raise ValueError(f"Invalid nativeLicenseData payload in {ts_path}")
    return payload


def slim_windows_stage(stage_dir: Path) -> None:
    """Externalize locales and cold data, and replace heavy JS vendor bundles with native host bridges."""
    translations_dir = stage_dir / "i18n/translations"
    if translations_dir.is_dir():
        for locale_file in sorted(translations_dir.glob("*.json")):
            locale_file.write_text("{}\n", encoding="utf-8")

    shiki_js = stage_dir / "vendor/shiki/shiki.js"
    if shiki_js.is_file():
        shiki_js.write_text(WINDOWS_SHIKI_STUB, encoding="utf-8")

    mathjax_js = stage_dir / "vendor/mathjax/tex2svg.js"
    if mathjax_js.is_file():
        mathjax_js.write_text(WINDOWS_MATHJAX_STUB, encoding="utf-8")

    rpc_schemas = stage_dir / "backend/rpcResultSchemas.json"
    if rpc_schemas.is_file():
        rpc_schemas.write_text('{"methods":{},"definitions":{},"external":true}\n', encoding="utf-8")

    native_notices = stage_dir / "pages/settings/nativeDependencyNotices.ts"
    if native_notices.is_file():
        count = len(extract_native_licenses_json(native_notices)["packages"])
        native_notices.write_text(
            "export const nativeLicenseData: { texts: string[]; packages: { name: string; version: string; license: string; sourceUrl: string | null; texts: number[] }[]; external?: boolean; packageCount?: number } = "
            + json.dumps({"texts": [], "packages": [], "external": True, "packageCount": count})
            + ";\n",
            encoding="utf-8",
        )


def stage_windows_ui(stage_dir: Path, root: Path = ROOT, identity: dict | None = None) -> None:
    app_dir = root / "t3ui"
    target = _validate_cleanable_dir(
        stage_dir,
        root=root,
        extra_inputs=(app_dir,),
        is_owned=_is_owned_stage_dir,
        label="stage directory",
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}.tmp-", dir=target.parent) as temporary:
        staged = Path(temporary) / "stage"
        shutil.copytree(app_dir, staged, ignore=_copy_ignore(app_dir), symlinks=False)

        manifest_path = staged / "nsh.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_path.write_text(
            json.dumps(windows_manifest(manifest), indent=2) + "\n",
            encoding="utf-8",
        )

        composer_path = staged / "components/Composer.tsx"
        composer_path.write_text(
            adapt_composer_for_v07(composer_path.read_text(encoding="utf-8")),
            encoding="utf-8",
        )
        slim_windows_stage(staged)

        if identity is not None:
            (staged / "buildIdentity.ts").write_text(
                "// Generated for this build; do not edit.\nexport const buildIdentity = "
                + json.dumps(identity, ensure_ascii=False)
                + " as const;\n",
                encoding="utf-8",
            )
            (staged / "build-identity.json").write_text(
                json.dumps(identity, indent=2) + "\n",
                encoding="utf-8",
            )
        (staged / STAGE_MARKER).write_text("r3-windows-stage\n", encoding="utf-8")
        _replace_directory_atomically(staged, target)


def extract_icns_pngs(icns_path: Path) -> list[tuple[int, bytes]]:
    """Extract deduplicated <=256px square PNG icon frames from an .icns file."""
    data = icns_path.read_bytes()
    if len(data) < 8 or data[:4] != b"icns":
        return []
    by_size: dict[int, bytes] = {}
    offset = 8
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset + 4 : offset + 8])[0]
        if length < 8 or offset + length > len(data):
            break
        payload = data[offset + 8 : offset + length]
        if payload.startswith(b"\x89PNG\r\n\x1a\n") and len(payload) >= 24:
            width, height = struct.unpack(">II", payload[16:24])
            if width == height and 16 <= width <= 256 and width not in by_size:
                by_size[width] = payload
        offset += length
    return sorted(by_size.items())


def build_ico_bytes(png_frames: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(png_frames))
    entries = bytearray()
    body = bytearray()
    image_offset = 6 + 16 * len(png_frames)
    for dim, png in png_frames:
        dim_byte = 0 if dim >= 256 else dim
        entries.extend(struct.pack("<BBBBHHII", dim_byte, dim_byte, 0, 0, 1, 32, len(png), image_offset))
        body.extend(png)
        image_offset += len(png)
    return header + bytes(entries) + bytes(body)


def build_group_icon_resource(png_frames: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(png_frames))
    entries = bytearray()
    for index, (dim, png) in enumerate(png_frames, start=1):
        dim_byte = 0 if dim >= 256 else dim
        entries.extend(struct.pack("<BBBBHHIH", dim_byte, dim_byte, 0, 0, 1, 32, len(png), index))
    return header + bytes(entries)


def extract_ico_from_icns(icns_path: Path, ico_path: Path) -> bool:
    """Wrap the embedded PNG icons from r3-icon.icns into a Vista+ Windows .ico file."""
    png_frames = extract_icns_pngs(icns_path)
    if not png_frames:
        return False
    ico_path.parent.mkdir(parents=True, exist_ok=True)
    ico_path.write_bytes(build_ico_bytes(png_frames))
    return True


def embed_icon_in_exe(exe_path: Path, png_frames: list[tuple[int, bytes]]) -> bool:
    """Embed RT_ICON and RT_GROUP_ICON (id 1) into a Windows PE executable."""
    if os.name != "nt" or not png_frames:
        return False
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    kernel32.BeginUpdateResourceW.restype = wintypes.HANDLE
    kernel32.UpdateResourceW.argtypes = [
        wintypes.HANDLE,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.WORD,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.UpdateResourceW.restype = wintypes.BOOL
    kernel32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    kernel32.EndUpdateResourceW.restype = wintypes.BOOL

    rt_icon = ctypes.c_void_p(3)
    rt_group_icon = ctypes.c_void_p(14)
    handle = kernel32.BeginUpdateResourceW(str(exe_path), False)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"BeginUpdateResourceW failed for {exe_path}")

    discard = True
    try:
        for index, (_, png) in enumerate(png_frames, start=1):
            buf = ctypes.create_string_buffer(png, len(png))
            if not kernel32.UpdateResourceW(handle, rt_icon, ctypes.c_void_p(index), 0, buf, len(png)):
                raise OSError(ctypes.get_last_error(), f"UpdateResourceW RT_ICON #{index} failed")
        group = build_group_icon_resource(png_frames)
        group_buf = ctypes.create_string_buffer(group, len(group))
        if not kernel32.UpdateResourceW(handle, rt_group_icon, ctypes.c_void_p(1), 0, group_buf, len(group)):
            raise OSError(ctypes.get_last_error(), "UpdateResourceW RT_GROUP_ICON #1 failed")
        discard = False
    finally:
        ended = kernel32.EndUpdateResourceW(handle, discard)
        if not discard and not ended:
            raise OSError(ctypes.get_last_error(), f"EndUpdateResourceW failed for {exe_path}")
    return True


def prepare_host_exe(
    host_exe: Path,
    dest_exe: Path,
    *,
    root: Path = ROOT,
    embed_icon: bool = True,
) -> Path:
    dest_exe.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(host_exe, dest_exe)
    if embed_icon:
        icns = root / "assets/r3-icon.icns"
        if icns.is_file():
            png_frames = extract_icns_pngs(icns)
            if png_frames:
                embed_icon_in_exe(dest_exe, png_frames)
    return dest_exe


def package_windows_bundle(
    ui_dir: Path,
    host_exe: Path,
    output_dir: Path,
    *,
    identity: dict | None = None,
    root: Path = ROOT,
    zip_path: Path | None = None,
    embed_icon: bool = True,
) -> Path:
    target = _validate_cleanable_dir(
        output_dir,
        root=root,
        extra_inputs=(ui_dir, host_exe),
        is_owned=_is_owned_bundle_dir,
        label="output directory",
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}.tmp-", dir=target.parent) as temporary:
        staged = Path(temporary) / "bundle"
        nsh_dir = staged / "nsh"
        nsh_dir.mkdir(parents=True)

        exe_dest = staged / "R3 Code.exe"
        shutil.copy2(host_exe, exe_dest)
        shutil.copy2(ui_dir / "bundle.nshc", nsh_dir / "bundle.nshc")
        assets_src = ui_dir / "assets"
        if assets_src.is_dir():
            shutil.copytree(assets_src, nsh_dir / "assets")

        staged_i18n = root / "t3ui/i18n/translations"
        if staged_i18n.is_dir():
            i18n_dest = nsh_dir / "assets/i18n"
            i18n_dest.mkdir(parents=True, exist_ok=True)
            for locale_file in sorted(staged_i18n.glob("*.json")):
                shutil.copy2(locale_file, i18n_dest / locale_file.name)

        data_dest = nsh_dir / "assets/data"
        rpc_schemas_src = root / "t3ui/backend/rpcResultSchemas.json"
        if rpc_schemas_src.is_file():
            data_dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(rpc_schemas_src, data_dest / "rpcResultSchemas.json")

        native_notices_src = root / "t3ui/pages/settings/nativeDependencyNotices.ts"
        if native_notices_src.is_file():
            data_dest.mkdir(parents=True, exist_ok=True)
            native_payload = extract_native_licenses_json(native_notices_src)
            (data_dest / "nativeDependencyNotices.json").write_text(
                json.dumps(native_payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )

        icns = root / "assets/r3-icon.icns"
        if icns.is_file():
            png_frames = extract_icns_pngs(icns)
            if png_frames:
                (nsh_dir / "icon.ico").write_bytes(build_ico_bytes(png_frames))
                if embed_icon:
                    embed_icon_in_exe(exe_dest, png_frames)

        manifest = windows_manifest(json.loads((root / "t3ui/nsh.json").read_text(encoding="utf-8")))
        app_json = {
            "name": manifest.get("name", "R3 Code"),
            "id": manifest.get("id", "com.example.t3ui"),
            "version": manifest.get("version", "1.0.0"),
            "singleInstance": True,
        }
        (nsh_dir / "app.json").write_text(json.dumps(app_json, indent=2) + "\n", encoding="utf-8")
        if isinstance(manifest.get("capabilities"), dict):
            (nsh_dir / "capabilities.json").write_text(
                json.dumps(manifest["capabilities"], indent=2) + "\n",
                encoding="utf-8",
            )

        if identity is not None:
            resolved_identity = dict(identity)
            resolved_identity["hostExecutableSha256"] = sha256_file(exe_dest)
            (nsh_dir / "build-identity.json").write_text(
                json.dumps(resolved_identity, indent=2) + "\n",
                encoding="utf-8",
            )

        for license_name in ("LICENSE", "LICENSING.md", "COMPONENT-LICENSES.md"):
            src = root / license_name
            if src.is_file():
                dst_name = "LICENSE.txt" if license_name == "LICENSE" else license_name
                shutil.copy2(src, staged / dst_name)
        licenses_dir = root / "LICENSES"
        if licenses_dir.is_dir():
            shutil.copytree(licenses_dir, staged / "LICENSES")

        (staged / BUNDLE_MARKER).write_text("r3-windows-bundle\n", encoding="utf-8")
        _replace_directory_atomically(staged, target)

    if zip_path is not None:
        zip_path = zip_path.absolute()
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for file_path in sorted(target.rglob("*")):
                if file_path.is_file() and file_path.name != BUNDLE_MARKER:
                    arcname = Path(target.name) / file_path.relative_to(target)
                    archive.write(file_path, arcname.as_posix())
    return target


def build_nsh_binaries(nsh_source: Path, target_dir: Path | None = None) -> tuple[Path, Path]:
    env = os.environ.copy()
    if target_dir is not None:
        env["CARGO_TARGET_DIR"] = str(target_dir.absolute())
    resolved_target = target_dir.absolute() if target_dir is not None else nsh_source / "target"

    subprocess.run(
        ["cargo", "build", "--locked", "--release", "-p", "nsh-cli"],
        cwd=nsh_source,
        env=env,
        check=True,
    )
    subprocess.run(
        ["cargo", "build", "--locked", "--release", "-p", "nsh-windows-app"],
        cwd=nsh_source,
        env=env,
        check=True,
    )
    exe_suffix = ".exe" if os.name == "nt" else ""
    return (
        resolved_target / "release" / f"nsh{exe_suffix}",
        resolved_target / "release" / f"nsh-windows-app{exe_suffix}",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nsh-source", type=Path, default=DEFAULT_NSH_SOURCE)
    parser.add_argument("--upstream", default=ORIGIN)
    parser.add_argument("--target-dir", type=Path, help="Optional Cargo target directory")
    parser.add_argument("--nsh-bin", type=Path, help="Prebuilt nsh CLI executable")
    parser.add_argument("--host-exe", type=Path, help="Prebuilt nsh-windows-app.exe executable")
    parser.add_argument("--output", type=Path, default=ROOT / "build/R3 Code")
    parser.add_argument("--zip", type=Path, help="Optional portable .zip output path")
    parser.add_argument("--stage-dir", type=Path, help="Optional directory to keep staged Windows t3ui sources")
    parser.add_argument("--prepare-only", action="store_true", help="Only prepare and verify patched NSH source")
    args = parser.parse_args()

    nsh_bin, host_exe = args.nsh_bin, args.host_exe
    if args.prepare_only or nsh_bin is None or host_exe is None:
        nsh_source = prepare_nsh_source(args.nsh_source, upstream=args.upstream)
        print(f"Prepared Windows NSH {NSH_VERSION} source at {nsh_source}", flush=True)
        if args.prepare_only:
            return
        built_cli, built_host = build_nsh_binaries(nsh_source, target_dir=args.target_dir)
        nsh_bin = nsh_bin or built_cli
        host_exe = host_exe or built_host

    nsh_bin = nsh_bin.resolve(strict=True)
    host_exe = host_exe.resolve(strict=True)
    validated_stage, validated_output = validate_build_destinations(
        args.stage_dir,
        args.output,
        root=ROOT,
        extra_inputs=(nsh_bin, host_exe),
    )

    with tempfile.TemporaryDirectory(prefix="r3-win-stage-") as temporary:
        temp_root = Path(temporary)
        final_host_exe = prepare_host_exe(host_exe, temp_root / "R3 Code.exe", root=ROOT, embed_icon=True)
        identity = standalone_build_identity(ROOT, host_exe=final_host_exe)
        stage_dir = validated_stage if validated_stage is not None else temp_root / "t3ui"
        ui_out = temp_root / "ui"
        stage_windows_ui(stage_dir, ROOT, identity=identity)
        subprocess.run(
            [str(nsh_bin), "build", str(stage_dir / "App.tsx"), "--release", "--out", str(ui_out)],
            cwd=ROOT,
            check=True,
        )
        packaged = package_windows_bundle(
            ui_out,
            final_host_exe,
            validated_output,
            identity=identity,
            root=ROOT,
            zip_path=args.zip,
            embed_icon=False,
        )
    print(f"Packaged Windows bundle at {packaged}", flush=True)
    if args.zip:
        print(f"Created portable archive at {args.zip.absolute()}", flush=True)


if __name__ == "__main__":
    main()
