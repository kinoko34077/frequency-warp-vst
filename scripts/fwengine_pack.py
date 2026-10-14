#!/usr/bin/env python3
"""Build exactly one self-contained, deterministic .fwengine ZIP from WASM.
This is an offline packer; the production loader is fwengine-package/src/lib.rs.
"""
import argparse
import hashlib
import json
import pathlib
import zipfile

def pack(wasm_path, destination, engine_id, engine_version="0.1.0"):
    wasm = pathlib.Path(wasm_path).read_bytes()
    if not wasm.startswith(b"\x00asm\x01\x00\x00\x00"):
        raise ValueError("not wasm32 core module v1")
    if len(wasm) > 7*1024*1024:
        raise ValueError("WASM larger than 7MB")
    manifest = dict(
        format="frequency-warp-engine", format_version=1,
        engine_id=engine_id, engine_version=engine_version,
        abi_major=1, abi_minor=0, entry="engine.wasm",
        sha256=hashlib.sha256(wasm).hexdigest(),
        max_memory_bytes=67108864, max_frames=2048,
        supported_channels=[1, 2], nominal_latency_frames=0,
        parameter_schema="host-slots-v1"
    )
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    dest = pathlib.Path(destination)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", allowZip64=False) as z:
        for name, content in (("manifest.json", manifest_bytes), ("engine.wasm", wasm)):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100644 << 16)
            info.compress_type = zipfile.ZIP_STORED
            z.writestr(info, content)
    print(f"{dest}: {len(wasm)}B WASM + {len(manifest_bytes)}B manifest")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wasm")
    parser.add_argument("destination")
    parser.add_argument("engine_id")
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args()
    pack(args.wasm,args.destination,args.engine_id,args.version)
