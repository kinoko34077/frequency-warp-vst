#!/usr/bin/env python3
"""Negative/fault-injection archive tests against the native Rust loader."""
import copy
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

def rezip(items):
    bio=io.BytesIO()
    with zipfile.ZipFile(bio, 'w', compression=zipfile.ZIP_STORED,allowZip64=False) as z:
        for name, data in items:
            z.writestr(name,data)
    return bio.getvalue()

def main():
    exe=pathlib.Path(sys.argv[1])
    base=pathlib.Path(sys.argv[2]).read_bytes()
    with zipfile.ZipFile(io.BytesIO(base)) as z:
        raw=z.read("manifest.json");wasm=z.read("engine.wasm")
    good=json.loads(raw)
    cases=[
        ("tampered-sha", [("manifest.json",raw),("engine.wasm",wasm+b"x")]),
        ("wrong-abi", [("manifest.json",json.dumps({**good,"abi_major":2}).encode()),("engine.wasm",wasm)]),
        ("future-minor", [("manifest.json",json.dumps({**good,"abi_minor":1}).encode()),("engine.wasm",wasm)]),
        ("wrong-size", [("manifest.json",json.dumps({**good,"max_frames":999999}).encode()),("engine.wasm",wasm)]),
        ("missing-entry",[("manifest.json",raw)]),
        ("extra-entry",[("manifest.json",raw),("engine.wasm",wasm),("extra.dll",b"evil")]),
        ("path-traversal",[("../manifest.json",raw),("engine.wasm",wasm)]),
        ("duplicate",[("manifest.json",raw),("manifest.json",raw)]),
        ("invalid-manifest",[("manifest.json",b"{broken"),("engine.wasm",wasm)]),
        ("bad-memory",[("manifest.json",json.dumps({**good,"max_memory_bytes":99999999999}).encode()),("engine.wasm",wasm)]),
        ("bad-header",[("manifest.json",json.dumps({**good,"sha256":__import__("hashlib").sha256(b"notwasm").hexdigest()}).encode()),("engine.wasm",b"notwasm")]),
        ("unknown-manifest-key",[("manifest.json",json.dumps({**good,"load_dll":"oops"}).encode()),("engine.wasm",wasm)])
    ]
    with tempfile.TemporaryDirectory() as tmp:
        goodpath=pathlib.Path(tmp)/"valid.fwengine"
        goodpath.write_bytes(base)
        result=subprocess.run([str(exe),str(goodpath)],capture_output=True,text=True)
        if result.returncode: raise AssertionError("valid package rejected: "+result.stderr)
        for name, entries in cases:
            candidate=pathlib.Path(tmp)/(name+".fwengine")
            candidate.write_bytes(rezip(entries))
            result=subprocess.run([str(exe),str(candidate)],capture_output=True,text=True)
            assert result.returncode!=0, f"{name}: insecure package accepted! "+result.stdout
            print("REJECTED",name, result.stderr.strip()[:120])
        oversized=pathlib.Path(tmp)/"oversized.fwengine"
        oversized.write_bytes(base+b" "* (8*1024*1024))
        assert subprocess.run([str(exe),str(oversized)],capture_output=True).returncode!=0
        print(f"PASS: valid package loaded and {len(cases)+1} malformed variants rejected")
if __name__=="__main__":
    main()
