//! Optional WASM-owned, bounded canonical DSP parameter contract.
//! Unlike the external UI JSON, these bytes live INSIDE the verified .fwengine
//! WASM. No full-package SHA is included (that would be circular).
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Clone,Debug,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Canonical {
    pub host_slot:u32,
    pub semantic_id:String,
    pub codec_revision:u32,
    pub dimension:String,
    pub canonical_unit:String,
    pub min:f64,
    pub max:f64,
    pub default:f64,
    pub scale:String,
    pub steps:Option<u32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModuleContract {schema:String,bindings:Vec<Canonical>}
pub fn parse(bytes:&[u8],declared_mask:u64)->Option<Vec<Canonical>> {
    if bytes.is_empty()||bytes.len()>4096 || declared_mask==0 {return None}
    let doc:ModuleContract=serde_json::from_slice(bytes).ok()?;
    if doc.schema!="frequency-warp-wasm-semantics-v1" ||
       doc.bindings.is_empty() || doc.bindings.len()>64 {return None}
    let mut bits=0u64;
    let mut ids=HashSet::new();
    for b in &doc.bindings {
        if !(64..=127).contains(&b.host_slot) ||
           !(1..=65535).contains(&b.codec_revision) ||
           b.semantic_id.is_empty()||b.semantic_id.len()>128 ||
           !b.semantic_id.as_bytes()[0].is_ascii_lowercase() ||
           !b.semantic_id.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||
                                       c==b'_'||c==b'.'||c==b'-') ||
           !ids.insert(b.semantic_id.as_str()) ||
           ![b.min,b.max,b.default].iter().all(|x|x.is_finite()&&x.abs()<=1e9)||
           b.min>=b.max||b.default<b.min||b.default>b.max {return None}
        let unit=match b.dimension.as_str(){
            "frequency"=>"hz","ratio"|"signedRatio"=>"ratio",
            "fraction"=>"fraction","coordinate"=>"coordinate",
            "integer"=>"integer","boolean"=>"boolean",
            _=>return None
        };
        if b.canonical_unit!=unit ||
           !["linear","log","discrete","frequency-band","frequency-with-zero"].contains(&b.scale.as_str())||
           (b.scale=="log"&&b.min<=0.)||
           (b.dimension=="frequency"&&b.min<0.)||
           (b.dimension=="ratio"&&b.min<=0.)||
           (b.dimension=="fraction"&&(b.min<0.||b.max>1.))||
           (b.scale=="frequency-band"&&
             !(b.dimension=="frequency"&&b.min==0.001&&b.max==20000.))||
           (b.scale=="frequency-with-zero"&&
             !(b.dimension=="frequency"&&b.min==0.&&b.max==20000.))||
           ((b.scale=="discrete")!=b.steps.is_some()) {return None}
        if let Some(steps)=b.steps {
            if !(1..=65535).contains(&steps) ||
               (b.dimension=="integer"&&b.max-b.min!=steps as f64) {return None}
            let n=(b.default-b.min)*steps as f64/(b.max-b.min);
            if (n-n.round()).abs()>1e-9{return None}
        }
        if b.dimension=="integer" &&
           !(b.min.fract()==0.&&b.max.fract()==0.&&
             b.default.fract()==0.&&b.scale=="discrete"){return None}
        if b.dimension=="boolean" &&
           !(b.min==0.&&b.max==1.&&
             (b.default==0.||b.default==1.)&&
             b.scale=="discrete"&&b.steps==Some(1)){return None}
        const _:()=();
        let bit=1u64<<(b.host_slot-64);
        if bits&bit!=0{return None}
        bits|=bit;
    }
    if bits!=declared_mask{return None}
    Some(doc.bindings)
}
#[cfg(test)]
mod tests {
    use super::*;
    const GOOD:&[u8]=br#"{"schema":"frequency-warp-wasm-semantics-v1","bindings":[{"host_slot":64,"semantic_id":"gain","codec_revision":1,"dimension":"signedRatio","canonical_unit":"ratio","min":0,"max":4,"default":0.5,"scale":"linear"}]}"#;
    #[test] fn module_owned_bounds_and_semantic_identity(){
        let a=parse(GOOD,1).unwrap();
        assert_eq!(a[0].semantic_id,"gain");
        assert_eq!(a[0].min,0.);
        assert_eq!(a[0].default,0.5);
        assert!(parse(GOOD,0).is_none());
        assert!(parse(GOOD,2).is_none());
        assert!(parse(GOOD,3).is_none());
    }
    #[test] fn bad_contracts_fail_closed(){
        let s=String::from_utf8(GOOD.to_vec()).unwrap();
        assert!(parse(s.replace(r#""max":4"#,r#""max":-4"#).as_bytes(),1).is_none());
        assert!(parse(s.replace(r#""semantic_id":"gain""#,r#""semantic_id":"gain","semantic_id":"hijack""#).as_bytes(),1).is_none());
        assert!(parse(s.replace(r#""canonical_unit":"ratio""#,r#""canonical_unit":"hz""#).as_bytes(),1).is_none());
        assert!(parse(s.replace(r#""scale":"linear""#,r#""scale":"log""#).as_bytes(),1).is_none());
        assert!(parse(s.replace(r#""codec_revision":1"#,r#""codec_revision":0"#).as_bytes(),1).is_none());
        assert!(parse(&vec![b'a';4097],1).is_none());
    }
}
