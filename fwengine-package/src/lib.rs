//! Native archive preflight; never call it on the audio thread.
//! A verified package contains only manifest.json + engine.wasm.
//! Runtime import/fuel/semantic checks are separate mandatory gates.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, io::{Cursor, Read}};
use zip::{CompressionMethod, ZipArchive};

pub const MAX_PACKAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_WASM_BYTES: usize = 7 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024 / 1024;
const ABI_MAJOR: u32 = 1;
const ALLOWED_MINOR: u32 = 0;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub engine_id: String,
    pub engine_version: String,
    pub abi_major: u32,
    pub abi_minor: u32,
    pub entry: String,
    pub sha256: String,
    pub max_memory_bytes: u64,
    pub max_frames: u32,
    pub supported_channels: Vec<u32>,
    pub nominal_latency_frames: u32,
    pub parameter_schema: String,
}

pub struct VerifiedPackage {
    pub manifest: Manifest,
    pub wasm: Vec<u8>,
}

#[derive(Debug)]
pub struct VerifyError(pub String);
impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl std::error::Error for VerifyError {}
fn invalid(msg: impl Into<String>) -> VerifyError { VerifyError(msg.into()) }

fn dotted_id(v: &str) -> bool {
    v.len() >= 3 && v.len() <= 128 && v.as_bytes()[0].is_ascii_lowercase()
        && (v.contains('.') || v.contains('-'))
        && v.split(['.', '-']).all(|segment|
            !segment.is_empty() && segment.bytes().all(|b|
                b.is_ascii_lowercase() || b.is_ascii_digit()))
}
fn semver(v: &str) -> bool {
    if v.is_empty() || v.len() > 64 || !v.is_ascii() { return false }
    let (base, pre) = match v.split_once('-') { Some((a,b)) => (a,Some(b)),None => (v,None) };
    if let Some(pr) = pre {
        if pr.is_empty() || !pr.split('.').all(|x|!x.is_empty()
            && x.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-')) { return false }
    }
    let mut pieces=base.split('.');
    (0..3).all(|_| {
        if let Some(x)=pieces.next() {
            !x.is_empty() && (x.len()==1 || !x.starts_with('0'))
                && x.bytes().all(|b|b.is_ascii_digit())
        } else { false }
    }) && pieces.next().is_none()
}
fn validate(m: &Manifest) -> Result<(),VerifyError> {
    if m.format!="frequency-warp-engine" || m.format_version!=1
        || m.abi_major!=ABI_MAJOR || m.abi_minor>ALLOWED_MINOR
        || m.entry!="engine.wasm" || m.parameter_schema!="host-slots-v1" {
        return Err(invalid("incompatible format/ABI/entry/parameter schema"));
    }
    if !dotted_id(&m.engine_id) || !semver(&m.engine_version) {
        return Err(invalid("invalid engine identity or version"));
    }
    if m.max_memory_bytes < 1_048_576 || m.max_memory_bytes > 67_108_864
        || !(1..=2048).contains(&m.max_frames) || m.nominal_latency_frames>4095
        || m.supported_channels.is_empty() || m.supported_channels.len()>2
        || !m.supported_channels.iter().all(|c|*c==1||*c==2)
        || (m.supported_channels.len()==2 && m.supported_channels[0]==m.supported_channels[1]) {
        return Err(invalid("invalid DSP bounds/channels/latency"));
    }
    if m.sha256.len()!=64 || !m.sha256.bytes().all(|x|x.is_ascii_hexdigit() && !x.is_ascii_uppercase()) {
        return Err(invalid("sha256 must be 64 lowercase hex digits"));
    }
    Ok(())
}

/// Bounded, hash-checked, no-path, no-symlink, no-resource archive preflight.
/// IMPORTANT: a valid archive is NOT yet safe to execute; the WASM runtime
/// must separately validate imports, memory/fuel bounds, callable ABI and PCM.
pub fn verify_package(data: &[u8]) -> Result<VerifiedPackage,VerifyError> {
    if data.len() > MAX_PACKAGE_BYTES || data.len()<30 {
        return Err(invalid("package size out of bounds"));
    }
    let mut archive=ZipArchive::new(Cursor::new(data)).map_err(|e|invalid(format!("invalid zip: {e}")))?;
    if archive.len()!=2 { return Err(invalid("must contain precisely two files")); }
    let mut manifest_bytes=None;
    let mut wasm_bytes=None;
    for i in 0..archive.len() {
        let mut f=archive.by_index(i).map_err(|e|invalid(format!("zip entry: {e}")))?;
        let (max_bytes, target)=match f.name() {
            "manifest.json" => (MAX_MANIFEST_BYTES, &mut manifest_bytes),
            "engine.wasm" => (MAX_WASM_BYTES, &mut wasm_bytes),
            _ => return Err(invalid("unexpected/unsafe zip path or entry")),
        };
        if f.is_dir() || f.enclosed_name().is_none() || target.is_some() {
            return Err(invalid("directory, traversal or duplicate entry"));
        }
        if let Some(mode)=f.unix_mode() {
            if mode & 0o170000 == 0o120000 || mode & 0o170000 == 0o040000 {
                return Err(invalid("symlink/directory refused"));
            }
        }
        if f.compression()!=CompressionMethod::Stored && f.compression()!=CompressionMethod::Deflated {
            return Err(invalid("unknown/unsupported ZIP compression"));
        }
        if f.size() > max_bytes as u64 { return Err(invalid("expanded entry too large")); }
        let mut bytes=Vec::with_capacity(f.size() as usize);
        f.by_ref().take(max_bytes as u64 + 1).read_to_end(&mut bytes)
            .map_err(|e|invalid(format!("cannot read archive entry: {e}")))?;
        if bytes.len()>max_bytes || bytes.len() as u64!=f.size() {
            return Err(invalid("entry expansion bound/integrity failure"));
        }
        *target=Some(bytes);
    }
    let manifest_bytes=manifest_bytes.ok_or_else(||invalid("missing manifest.json"))?;
    let wasm=wasm_bytes.ok_or_else(||invalid("missing engine.wasm"))?;
    let manifest:Manifest=serde_json::from_slice(&manifest_bytes)
        .map_err(|e|invalid(format!("invalid manifest: {e}")))?;
    validate(&manifest)?;
    if wasm.len()<8 || wasm[..8] != [0,97,115,109,1,0,0,0] {
        return Err(invalid("not a core WASM v1 binary"));
    }
    let actual=format!("{:x}",Sha256::digest(&wasm));
    if actual!=manifest.sha256 { return Err(invalid("WASM SHA256 mismatch")); }
    Ok(VerifiedPackage{manifest,wasm})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn identity_rules() {
        assert!(dotted_id("org.example.gain"));
        assert!(dotted_id("org-gain")); // manifest JSON schema allows period or hyphen
        assert!(!dotted_id("org.EXAMPLE"));
        assert!(!dotted_id("foo..bar"));
        assert!(semver("0.1.0"));
        assert!(semver("10.12.3-rc.2"));
        assert!(!semver("01.2.3"));
        assert!(!semver("1.2"));
    }
    #[test] fn rejects_nonzip() { assert!(verify_package(b"not-a-zip").is_err()); }
}
