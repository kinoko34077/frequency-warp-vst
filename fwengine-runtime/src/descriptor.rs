//! R3B2 necessary-only non-RT JSON descriptor preflight.
//! No change to .fwengine v1, host IDs, UI authority, or audio RT paths.
//! A matching file hash is NOT evidence that WASM implements these semantics.
//! R3B3 must obtain a WASM-attested canonical control contract before R3C.
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

const SCHEMA: &str = "frequency-warp-ui-descriptors-v1";
const MAX_BYTES: usize = 65_536;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DescriptorFile {
    schema: String,
    engine: Engine,
    bindings: Vec<Binding>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Engine {
    id: String,
    version: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    host_slot: u32,
    semantic_id: String,
    label: String,
    dimension: String,
    canonical_unit: String,
    min: f64,
    max: f64,
    default: f64,
    scale: String,
    widget: String,
    display_units: Vec<String>,
    codec_revision: u32,
    selector: Option<String>,
    steps: Option<u32>,
    snap: Option<Snap>,
    depends_on: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snap {values: Vec<f64>, radius_normalized: f64}

fn identifier(s:&str, dotted:bool)->bool {
    if s.is_empty() || s.len()>128 {return false}
    let bytes=s.as_bytes();
    if !bytes[0].is_ascii_lowercase() || !bytes.last().unwrap().is_ascii_alphanumeric() {return false}
    if !bytes.iter().all(|c| c.is_ascii_lowercase()||c.is_ascii_digit()||
                       *c==b'-'||*c==b'.'||(!dotted&&*c==b'_')) {return false}
    if !bytes.windows(2).all(|x| !(matches!(x[0],b'.'|b'-'|b'_') &&
                                    matches!(x[1],b'.'|b'-'|b'_'))) {return false}
    !dotted || (bytes.contains(&b'.')||bytes.contains(&b'-'))
}
fn version(s:&str)->bool {
    if s.is_empty()||s.len()>64 {return false}
    let (core,suffix)=match s.split_once('-'){Some((a,b))=>(a,Some(b)),None=>(s,None)};
    if core.split('.').count()!=3 || !core.split('.').all(|part|
        !part.is_empty()&& (part.len()==1||!part.starts_with('0')) &&
        part.bytes().all(|b|b.is_ascii_digit())) {return false}
    suffix.map_or(true,|s| !s.is_empty() && s.bytes().all(|b|
        b.is_ascii_alphanumeric() || b==b'-'||b==b'.'))
}
fn units(dimension:&str)->Option<(&'static str,&'static [&'static str])> {
    match dimension {
        "frequency"=>Some(("hz",&["hz","note","percent"])),
        "ratio"=>Some(("ratio",&["ratio","semitones","cents","percent"])),
        "fraction"=>Some(("fraction",&["percent"])),
        "signedRatio"=>Some(("ratio",&["ratio","percent"])),
        "coordinate"=>Some(("coordinate",&["coordinate","percent"])),
        "integer"=>Some(("integer",&["integer","percent"])),
        "boolean"=>Some(("boolean",&["boolean"])),
        _=>None
    }
}
fn valid_binding(b:&Binding,engine_id:&str)->bool {
    if !(64..=127).contains(&b.host_slot) ||
       !identifier(&b.semantic_id,false)||b.semantic_id==engine_id||
       b.label.is_empty()||b.label.chars().count()>64||
       b.label.chars().any(|c|c<='\u{001f}'||c=='\u{007f}')||
       !(1..=65535).contains(&b.codec_revision) {return false}
    let Some((canonical,legal_units))=units(&b.dimension) else{return false};
    if b.canonical_unit!=canonical||b.display_units.is_empty()||
       b.display_units.len()>legal_units.len()||
       !b.display_units.iter().all(|u|legal_units.contains(&u.as_str()))||
       b.display_units.iter().collect::<HashSet<_>>().len()!=b.display_units.len(){return false}
    if ![b.min,b.max,b.default].iter().all(|v|v.is_finite()&&v.abs()<=1e9)||
       b.min>=b.max||b.default<b.min||b.default>b.max{return false}
    if !["knob","slider","number","select","switch"].contains(&b.widget.as_str()) ||
       !["linear","log","discrete","frequency-band","frequency-with-zero"].contains(&b.scale.as_str()){return false}
    if b.dimension=="frequency"&&b.min<0.0{return false}
    if b.dimension=="ratio"&&b.min<=0.0{return false}
    if b.dimension=="fraction"&&(b.min<0.0||b.max>1.0){return false}
    if b.scale=="log"&&b.min<=0.0{return false}
    if b.scale=="frequency-band" &&!(b.dimension=="frequency"&&b.min==0.001&&b.max==20000.0){return false}
    if b.scale=="frequency-with-zero" &&!(b.dimension=="frequency"&&b.min==0.0&&b.max==20000.0){return false}
    if b.dimension=="boolean" &&
       !(b.min==0.0&&b.max==1.0&&(b.default==0.0||b.default==1.0)&&
         b.widget=="switch"&&b.scale=="discrete"&&b.steps==Some(1)){return false}
    if b.dimension=="integer"&&
       !(b.min.fract()==0.0&&b.max.fract()==0.0&&
         b.default.fract()==0.0&&b.scale=="discrete"){return false}
    if (b.scale=="discrete")!=b.steps.is_some(){return false}
    if let Some(steps)=b.steps {
        if !(1..=65535).contains(&steps){return false}
        if b.dimension=="integer" && (b.max-b.min)!=steps as f64{return false}
        let snapped=(b.default-b.min)*steps as f64/(b.max-b.min);
        if (snapped-snapped.round()).abs()>1e-9{return false}
    }
    if let Some(selector)=&b.selector {
        let rest=selector.strip_prefix('#');
        if !rest.is_some_and(|v|!v.is_empty()&&v.as_bytes()[0].is_ascii_alphabetic()&&
            v.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-')){return false}
    }
    if let Some(snap)=&b.snap {
        if snap.values.is_empty()||snap.values.len()>32||
           !snap.radius_normalized.is_finite()||
           !(0.0..=0.25).contains(&snap.radius_normalized)||
           snap.values.iter().any(|v|!v.is_finite()||*v<b.min||*v>b.max)||
           snap.values.iter().enumerate().any(|(i,v)|snap.values[..i].contains(v)){return false}
    }
    if let Some(depends)=&b.depends_on{
        if depends.len()>16||depends.iter().any(|s|!identifier(s,false)||s==&b.semantic_id)||
           depends.iter().collect::<HashSet<_>>().len()!=depends.len(){return false}
    }
    true
}
fn visit<'a>(id:&'a str,graph:&HashMap<&'a str,Vec<&'a str>>,
             visiting:&mut HashSet<&'a str>,visited:&mut HashSet<&'a str>)->bool {
    if visited.contains(id){return true}
    if !visiting.insert(id){return false}
    let ok=graph.get(id).is_some_and(|edges|edges.iter().all(|child|
        graph.contains_key(child) && visit(child,graph,visiting,visited)));
    visiting.remove(id);
    if ok{visited.insert(id);}
    ok
}
fn hex_sha(hash:&[u8;32])->String {
    let mut value=String::with_capacity(64);
    for b in hash {use std::fmt::Write;let _=write!(value,"{b:02x}");}
    value
}
/// Mandatory but NOT SUFFICIENT descriptor preflight. The active module
/// and saved FWS3 ledger must additionally be checked by the native R3B1 gate.
/// This return does NOT permit generic audio/DAW edits.
pub fn preflight(data:&[u8], engine_id:&str, package_sha:&[u8;32],
                 wasm_mask:u64, slot:u32, semantic:&str, codec:u32)->bool {
    if data.is_empty()||data.len()>MAX_BYTES||!(64..=127).contains(&slot)||
       wasm_mask&(1u64<<(slot-64))==0 {return false}
    let Ok(parsed)=serde_json::from_slice::<DescriptorFile>(data) else{return false};
    if parsed.schema!=SCHEMA||parsed.engine.id!=engine_id||
       parsed.engine.sha256!=hex_sha(package_sha)||
       !identifier(&parsed.engine.id,true)||
       !version(&parsed.engine.version)||parsed.bindings.len()>64{return false}
    let mut slots=HashSet::new();
    let mut names=HashSet::new();
    let mut selectors=HashSet::new();
    let mut graph=HashMap::<&str,Vec<&str>>::new();
    let mut target=false;
    for b in &parsed.bindings {
        if !valid_binding(b,engine_id)||
           !slots.insert(b.host_slot)||!names.insert(b.semantic_id.as_str())||
           b.selector.as_ref().is_some_and(|x|!selectors.insert(x.as_str())){return false}
        graph.insert(&b.semantic_id,b.depends_on.as_ref().map_or_else(Vec::new,
                      |deps|deps.iter().map(String::as_str).collect()));
        if b.host_slot==slot && b.semantic_id==semantic && b.codec_revision==codec {
            target=true;
        }
    }
    let mut visiting=HashSet::new();
    let mut visited=HashSet::new();
    target&&graph.keys().copied().all(|id|visit(id,&graph,&mut visiting,&mut visited))
}
/// R3C2D2: attest EVERY selected UI binding against the live module's
/// WASM-owned immutable contract, never just the requested first slot.
/// UI metadata controls display only; this result is candidate evidence,
/// NOT DAW/RT authorization or a saved FWS3 ledger.
pub fn attest_entire_descriptor_set(
    data:&[u8], engine_id:&str, package_sha:&[u8;32],
    wasm_mask:u64,
    canonical_for:impl Fn(u32)->Option<crate::module_contract::Canonical>
)->Option<u64> {
    if data.is_empty()||data.len()>MAX_BYTES||wasm_mask==0{return None}
    let doc=serde_json::from_slice::<DescriptorFile>(data).ok()?;
    if doc.schema!=SCHEMA || doc.engine.id!=engine_id ||
       doc.engine.sha256!=hex_sha(package_sha) ||
       !identifier(&doc.engine.id,true) || !version(&doc.engine.version) ||
       doc.bindings.is_empty()||doc.bindings.len()>64{return None}
    let mut selected=0u64;
    let mut names=HashSet::new();
    let mut selectors=HashSet::new();
    let mut graph=HashMap::<&str,Vec<&str>>::new();
    for b in &doc.bindings {
        if !valid_binding(b,engine_id) || !names.insert(b.semantic_id.as_str()) ||
           b.selector.as_ref().is_some_and(|x|!selectors.insert(x.as_str())){
            return None
        }
        let bit=1u64<<(b.host_slot-64);
        if (wasm_mask&bit)==0 || (selected&bit)!=0{return None}
        let canonical=canonical_for(b.host_slot)?;
        if canonical.host_slot!=b.host_slot ||
           canonical.semantic_id!=b.semantic_id ||
           canonical.codec_revision!=b.codec_revision ||
           canonical.dimension!=b.dimension ||
           canonical.canonical_unit!=b.canonical_unit ||
           canonical.min!=b.min || canonical.max!=b.max ||
           canonical.default!=b.default || canonical.scale!=b.scale ||
           canonical.steps!=b.steps{return None}
        selected|=bit;
        graph.insert(&b.semantic_id,b.depends_on.as_ref().map_or_else(
            Vec::new,|deps|deps.iter().map(String::as_str).collect()));
    }
    let mut visiting=HashSet::new();
    let mut visited=HashSet::new();
    if !graph.keys().copied().all(|id|visit(id,&graph,&mut visiting,&mut visited)){
        return None
    }
    Some(selected)
}
/// R3B3 second, independent proof: compare the external UI view to the
/// immutable WASM-authored canonical contract copied during preparation.
/// A designer may change *display-only* fields and widgets, but must not
/// change DSP semantic id, canonical min/max/default, scale or codec.
pub fn matches_wasm_semantics(data:&[u8],attested:&crate::module_contract::Canonical)->bool {
    if data.is_empty()||data.len()>MAX_BYTES{return false}
    let Ok(doc)=serde_json::from_slice::<DescriptorFile>(data) else{return false};
    doc.bindings.iter().any(|b|{
        b.host_slot==attested.host_slot &&
        b.semantic_id==attested.semantic_id &&
        b.codec_revision==attested.codec_revision &&
        b.dimension==attested.dimension &&
        b.canonical_unit==attested.canonical_unit &&
        b.min==attested.min && b.max==attested.max &&
        b.default==attested.default && b.scale==attested.scale &&
        b.steps==attested.steps
    })
}
/// Compatibility helper for callers which already borrow the canonical
/// WASM contract. Both native ABI variants share the SAME whole-set proof,
/// preventing semantic drift between optional mask/read interfaces.
pub fn attested_mask<'a,F>(
    data:&[u8],engine_id:&str,package_sha:&[u8;32],
    declared_mask:u64,lookup:F
)->Option<u64>
where F: Fn(u32)->Option<&'a crate::module_contract::Canonical> {
    attest_entire_descriptor_set(data,engine_id,package_sha,declared_mask,
        |slot|lookup(slot).cloned())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(semantic:&str)->String {
        format!(r#"{{"schema":"{SCHEMA}","engine":{{"id":"org.kinotch.gainhalf","version":"0.1.0","sha256":"{}"}},"bindings":[{{"host_slot":64,"semantic_id":"{semantic}","label":"Gain","dimension":"ratio","canonical_unit":"ratio","min":0.25,"max":4.0,"default":1.0,"scale":"log","widget":"knob","display_units":["ratio","cents"],"codec_revision":1,"snap":{{"values":[0.5,1,2],"radius_normalized":0.03}}}}]}}"#,hex_sha(&[0x37;32]))
    }
    fn accept(s:&str)->bool {preflight(s.as_bytes(),"org.kinotch.gainhalf",&[0x37;32],1,64,"gain",1)}
    #[test] fn valid_descriptor_identity_and_units(){
        assert!(accept(&fixture("gain")));
        assert!(!preflight(fixture("gain").as_bytes(),"org.kinotch.identity",&[0x37;32],1,64,"gain",1));
        assert!(!preflight(fixture("gain").as_bytes(),"org.kinotch.gainhalf",&[0x38;32],1,64,"gain",1));
        assert!(!preflight(fixture("gain").as_bytes(),"org.kinotch.gainhalf",&[0x37;32],0,64,"gain",1));
        assert!(!preflight(fixture("gain").as_bytes(),"org.kinotch.gainhalf",&[0x37;32],1,64,"changed",1));
        assert!(!preflight(fixture("gain").as_bytes(),"org.kinotch.gainhalf",&[0x37;32],1,64,"gain",2));
    }
    #[test] fn schema_rejects_unknown_duplicate_nonfinite_and_bad_units(){
        let s=fixture("gain");
        assert!(!accept(&s.replace(r#""widget":"knob""#,r#""widget":"new-vst-class""#)));
        assert!(!accept(&s.replace(r#""dimension":"ratio""#,r#""dimension":"fraction""#)));
        assert!(!accept(&s.replace(r#""max":4.0"#,r#""max":-1.0"#)));
        assert!(!accept(&s.replace(r#""scale":"log""#,r#""scale":"discrete""#)));
        assert!(!accept(&s.replace(r#""min":0.25"#,r#""min":0"#)));
        assert!(!accept(&s.replace(r#""host_slot":64"#,r#""host_slot":128"#)));
        assert!(!accept(&s.replace(r#""host_slot":64"#,r#""host_slot":64,"host_slot":65"#)));
        assert!(!accept(&s.replace(r#""widget":"knob""#,r#""widget":"knob","native_path":"C:/tmp/evil.dll""#)));
        assert!(!accept(&s.replace(r#""radius_normalized":0.03"#,r#""radius_normalized":-0.1"#)));
        assert!(!accept(&s.replace(r#""display_units":["ratio","cents"]"#,
                                  r#""display_units":["ratio","hz"]"#)));
        assert!(!accept(&s.replace(r#""default":1.0"#,r#""default":1e999"#)));
        assert!(!accept(&s.repeat(10000)));
        assert!(!accept("{"));
    }
    #[test] fn complete_two_slot_wasm_attestation_or_total_denial(){
        use crate::module_contract::Canonical;
        let first=fixture("gain");
        let second=r#",{"host_slot":65,"semantic_id":"drive","label":"Drive","dimension":"ratio","canonical_unit":"ratio","min":0.25,"max":4.0,"default":1.0,"scale":"log","widget":"knob","display_units":["ratio"],"codec_revision":1}"#;
        let doc=format!("{}{}]}}",first.strip_suffix("]}").unwrap(),second);
        let verify=|text:&str,declared:u64|{
            attest_entire_descriptor_set(text.as_bytes(),"org.kinotch.gainhalf",
                &[0x37;32],declared,|slot|{
                    if slot!=64&&slot!=65{return None}
                    Some(Canonical{
                        host_slot:slot,
                        semantic_id:if slot==64{"gain"}else{"drive"}.into(),
                        codec_revision:1,dimension:"ratio".into(),
                        canonical_unit:"ratio".into(),min:0.25,max:4.0,
                        default:1.0,scale:"log".into(),steps:None,
                    })
                })
        };
        assert_eq!(verify(&doc,3),Some(3));
        assert_eq!(verify(&doc,1),None); // cannot silently skip slot65
        assert_eq!(verify(&doc.replace(r#""semantic_id":"drive""#,
                                        r#""semantic_id":"foreign""#),3),None);
        assert_eq!(verify(&doc.replace(r#""host_slot":65"#,
                                        r#""host_slot":64"#),3),None);
        assert_eq!(verify(&doc.replace(r#""max":4.0"#,
                                        r#""max":3.0"#),3),None);
    }
    #[test] fn dependencies_and_utf8_limit(){
        let s=fixture("gain");
        let dupe=s.replace("]}",r#",{"host_slot":65,"semantic_id":"gain","label":"Other","dimension":"ratio","canonical_unit":"ratio","min":0.25,"max":4,"default":1,"scale":"log","widget":"knob","display_units":["ratio"],"codec_revision":1}]}"#);
        assert!(!accept(&dupe));
        assert!(!accept(&s.replace(r#""codec_revision":1"#,
                        r#""codec_revision":1,"depends_on":["missing"]"#)));
        assert!(!accept(&s.replace(r#""codec_revision":1"#,
                        r#""codec_revision":1,"depends_on":["gain"]"#)));
        assert!(!accept(&s.replace(r#""label":"Gain""#, &format!(r#""label":"{}""#,"木".repeat(22000)))));
    }
}
