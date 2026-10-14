use std::fs;
fn main() {
    let Some(path)=std::env::args_os().nth(1) else {
        eprintln!("Usage: fwengine-package <engine.fwengine>");
        std::process::exit(2)
    };
    let input=fs::read(path).unwrap_or_else(|e|{eprintln!("read failure: {e}"); std::process::exit(1)});
    match fwengine_package::verify_package(&input) {
        Ok(v)=>println!("VERIFIED engine={} version={} ABI={}.{} bytes={} latency={}",
            v.manifest.engine_id,v.manifest.engine_version,
            v.manifest.abi_major,v.manifest.abi_minor,
            v.wasm.len(),v.manifest.nominal_latency_frames),
        Err(e)=>{eprintln!("REJECTED: {e}"); std::process::exit(1)},
    }
}
