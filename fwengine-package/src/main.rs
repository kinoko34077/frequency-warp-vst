use std::{fs, path::PathBuf};
fn main() {
    let mut args=std::env::args_os().skip(1);
    let Some(path)=args.next() else {
        eprintln!("Usage: fwengine-package <engine.fwengine> [extracted-engine.wasm]");
        std::process::exit(2)
    };
    let destination=args.next().map(PathBuf::from);
    if args.next().is_some() { eprintln!("too many arguments"); std::process::exit(2); }
    let input=fs::read(path).unwrap_or_else(|e|{eprintln!("read failure: {e}"); std::process::exit(1)});
    match fwengine_package::verify_package(&input) {
        Ok(v)=>{
            if let Some(target)=destination {
                fs::write(&target,&v.wasm).unwrap_or_else(|e|{
                    eprintln!("validated WASM extraction failed: {e}");
                    std::process::exit(1)
                });
            }
            println!("VERIFIED engine={} version={} ABI={}.{} bytes={} latency={}",
                v.manifest.engine_id,v.manifest.engine_version,
                v.manifest.abi_major,v.manifest.abi_minor,
                v.wasm.len(),v.manifest.nominal_latency_frames)
        },
        Err(e)=>{eprintln!("REJECTED: {e}"); std::process::exit(1)},
    }
}
