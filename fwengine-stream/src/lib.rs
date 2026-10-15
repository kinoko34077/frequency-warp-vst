//! S4a: ABI v1 wrapper over the SAME Stream used by native and browser code.
 //! One Wasmi instance per plugin; no imports, no custom frequency transform.
use frequency_warp_core::{Progression,Settings,Stream};
use std::ptr::{addr_of,addr_of_mut};

const MAX_FRAMES:usize=2048;
const MAX_CHANNELS:usize=2;
const MAX_EVENTS:usize=128;
const MAX_SAMPLES:usize=MAX_FRAMES*MAX_CHANNELS;
const HANDLE:i32=1;
const OUTSIDE_PASS:u32=0;

#[repr(C)]
#[derive(Clone,Copy)]
pub struct Event {pub id:u32,pub offset:u32,pub value:f64}
const NEUTRAL_EVENT:Event=Event{id:2,offset:0,value:20.};

static mut INPUT:[f32;MAX_SAMPLES]=[0.;MAX_SAMPLES];
static mut OUTPUT:[f32;MAX_SAMPLES]=[0.;MAX_SAMPLES];
static mut EVENTS:[Event;MAX_EVENTS]=[NEUTRAL_EVENT;MAX_EVENTS];
// Local strides of each *segment* differ from host block strides.
static mut SEG_IN:[f32;MAX_SAMPLES]=[0.;MAX_SAMPLES];
static mut SEG_OUT:[f32;MAX_SAMPLES]=[0.;MAX_SAMPLES];
static mut STREAM:Option<Stream>=None;
static mut SETTINGS:Option<Settings>=None;
// Physics/state reuse the canonical Stream setters already used by Web.
#[derive(Clone,Copy)]
struct ExtraControls {
    shift:f64,pivot:f64,slope:f64,gain:f64,decay:f64,
    ring:bool,rational:bool,
    crusher_enabled:bool,crusher_bits:u32,crusher_rate_hz:f64,
    a_min_hz:f64,a_quality:u32,a_band_bins:u32,a_reverb:f64,
    engine_choice:u32,outside_policy:u32,
}
impl Default for ExtraControls {
    fn default()->Self {
        Self{shift:0.,pivot:350.,slope:1.,gain:1.,decay:0.,
             ring:false,rational:false,
             crusher_enabled:false,crusher_bits:8,crusher_rate_hz:12000.,
             a_min_hz:20.,a_quality:0,a_band_bins:1,a_reverb:0.,
             engine_choice:0,outside_policy:0}
    }
}
static mut EXTRA:Option<ExtraControls>=None;
static mut CHANNELS:usize=0;
static mut SAMPLE_RATE:f64=0.;

fn defaults(rate:f64)->Settings {
    Settings{low:20.,high:16000_f64.min(rate*0.45),curvature:1.,
             invert:0.,mode:Progression::Blend,quality:0}
}
// Optional capability export: legacy .fwengine without this symbol is
// conservatively limited by the host to original physical IDs2..5.
// Bit positions are permanent DAW ParamIDs, not a new remapping.
#[cfg(not(feature="legacy-no-mask"))]
#[no_mangle]pub extern "C" fn fw_supported_param_mask()->i64 {
    let mut mask=0u64;
    for id in [2,3,4,5,6,7,8,9,10,11,13,16,17,18,25,27,28,29,30,31,32] {
        if cfg!(feature="legacy-fourteen-mask") && id>=27 {continue;}
        mask|=1u64<<id;
    }
    mask as i64
}
#[no_mangle]pub extern "C" fn fw_abi_major()->i32{1}
#[no_mangle]pub extern "C" fn fw_input_offset()->u32{addr_of!(INPUT) as usize as u32}
#[no_mangle]pub extern "C" fn fw_output_offset()->u32{addr_of_mut!(OUTPUT) as usize as u32}
#[no_mangle]pub extern "C" fn fw_event_offset()->u32{addr_of_mut!(EVENTS) as usize as u32}
#[no_mangle]pub extern "C" fn fw_event_capacity()->i32{MAX_EVENTS as i32}
#[no_mangle]pub extern "C" fn fw_event_stride()->i32{std::mem::size_of::<Event>() as i32}
#[no_mangle]
pub extern "C" fn fw_create(rate:f64,channels:i32,max_block:i32)->i32{
    if !rate.is_finite()||!(8000.0..=384000.).contains(&rate)||
       !(1..=2).contains(&channels)||max_block<=0||
       max_block>MAX_FRAMES as i32{return 0;}
    let settings=defaults(rate);
    match Stream::new(rate,channels as usize,settings,OUTSIDE_PASS){
        Ok(engine)=>unsafe{
            STREAM=Some(engine);SETTINGS=Some(settings);EXTRA=Some(ExtraControls::default());
            CHANNELS=channels as usize;
            SAMPLE_RATE=rate;
            HANDLE
        },
        Err(_)=>0
    }
}
#[no_mangle]pub extern "C" fn fw_get_latency_frames(handle:i32)->i32{
    if handle!=HANDLE{return -1;}
    unsafe{STREAM.as_ref().map(|engine|engine.latency() as i32).unwrap_or(-1)}
}
#[no_mangle]pub extern "C" fn fw_reset(handle:i32)->i32{
    if handle!=HANDLE{return -1;}
    unsafe{match STREAM.as_mut(){
        Some(engine)=>{engine.reset();0},None=>-1
    }}
}
#[no_mangle]pub extern "C" fn fw_destroy(handle:i32){
    if handle==HANDLE{unsafe{STREAM=None;SETTINGS=None;EXTRA=None;CHANNELS=0;SAMPLE_RATE=0.;}}
}
fn valid_event(event:Event,sample_rate:f64)->bool{
    event.value.is_finite()&&match event.id{
        2|3=>event.value>=0.001&&event.value<=20000.,
        4|5|9|13=>event.value>=0.&&event.value<=1.,
        6=>event.value>=-2.&&event.value<=2.,
        7=>event.value>=0.&&event.value<=20000.,
        8=>event.value>=-4.&&event.value<=4.,
        10|11|18=>event.value==0.||event.value==1.,
        16=>(2.0..=16.0).contains(&event.value)&&event.value.fract()==0.,
        17=>event.value>=0.&&event.value<=sample_rate,
        27=>event.value>=0.001&&event.value<=20000.,
        28|30=>event.value>=0.&&event.value<=1.,
        29=>(1.0..=8.0).contains(&event.value)&&event.value.fract()==0.,
        25|32=>event.value==0.||event.value==1.,
        31=>(0.0..=2.0).contains(&event.value)&&event.value.fract()==0.,
        _=>false,
    }
}
fn modify_extra(extra:&mut ExtraControls,event:Event)->bool {
    match event.id {
        6=>extra.shift=event.value,
        7=>extra.pivot=event.value,
        8=>extra.slope=event.value,
        9=>extra.gain=event.value,
        10=>extra.ring=event.value!=0.,
        13=>extra.decay=event.value,
        18=>extra.rational=event.value!=0.,
        11=>extra.crusher_enabled=event.value!=0.,
        16=>extra.crusher_bits=event.value as u32,
        17=>extra.crusher_rate_hz=event.value,
        27=>extra.a_min_hz=event.value,
        28=>extra.a_quality=(event.value*100.).round() as u32,
        29=>extra.a_band_bins=event.value as u32,
        30=>extra.a_reverb=event.value,
        25=>extra.engine_choice=event.value as u32,
        32=>extra.outside_policy=event.value as u32,
        _=>return false,
    }
    true
}
// Error-free for prevalidated physical values. Keep the same public Stream
// setters that the Web AudioWorklet invokes; do not clone any spectral math.
fn apply_extra(engine:&mut Stream,extra:ExtraControls,rate:f64)->Result<(),&'static str>{
    engine.set_transform(extra.shift,350.,extra.ring as u32,
                         extra.rational as u32)?;
    engine.set_geometry(extra.pivot,extra.slope)?;
    engine.set_zero_reflect_gain(extra.gain)?;
    engine.set_zero_reflect_decay(extra.decay)?;
    // Same sample-clock contract as Web crusher-visual::holdFromFrequency.
    // Physical clock=0 freezes first output sample; normal clocks are
    // rounded to an integer number of input frames, never fractional.
    let hold=if extra.crusher_rate_hz==0. {0}
        else {(rate/extra.crusher_rate_hz).round().clamp(1.,1_000_000_000.) as u32};
    let bits=if extra.crusher_enabled {extra.crusher_bits}else{0};
    engine.set_crusher(bits,hold)?;
    // Engine A controls are the exact canonical Web Rust Stream setters.
    // No new peak detector, spectral conversion or reverb is introduced.
    engine.set_a_options(extra.a_min_hz,extra.a_reverb)?;
    engine.set_a_peak_band(extra.a_band_bins)?;
    engine.set_a_quality(extra.a_quality)?;
    Ok(())
}
fn modify(settings:&mut Settings,event:Event) {
    match event.id{
        2=>settings.low=event.value,
        3=>settings.high=event.value,
        4=>settings.invert=event.value,
        5=>settings.curvature=event.value,
        31=>settings.mode=match event.value as u32 {
            0=>Progression::Reciprocal,
            1=>Progression::FoldLow,
            _=>Progression::FoldHigh,
        },
        _=>{}
    }
}
// Audio is already OFF the DAW audio thread. This function does not open any
// file, create an engine or duplicate DSP formulae; Stream handles all spectral work.
#[no_mangle]
pub extern "C" fn fw_process(handle:i32,input:u32,output:u32,frames:i32,
                              events:u32,count:i32)->i32{
    if handle!=HANDLE||input!=fw_input_offset()||output!=fw_output_offset()||
       events!=fw_event_offset()||frames<0||frames>MAX_FRAMES as i32||
       count<0||count>MAX_EVENTS as i32{return -1;}
    let f=frames as usize;
    let e=count as usize;
    unsafe{
        if STREAM.is_none()||SETTINGS.is_none()||EXTRA.is_none()||CHANNELS==0{return -1;}
        let channel_count=CHANNELS;
        let mut last=0;
        for i in 0..e {
            let event=EVENTS[i];
            if !valid_event(event,SAMPLE_RATE)||event.offset as usize >= f.max(1)||
               (i>0&&event.offset<last){return -2;}
            last=event.offset;
        }
        let engine=STREAM.as_mut().unwrap();
        let settings=SETTINGS.as_mut().unwrap();
        let extra=EXTRA.as_mut().unwrap();
        if f==0 {
            if e>0 {
                let mut next=*settings;
                let mut following=*extra;
                let mut extraChanged=false;
                for i in 0..e{
                    modify(&mut next,EVENTS[i]);
                    extraChanged|=modify_extra(&mut following,EVENTS[i]);
                }
                // Preserve valid previous DSP on impossible L/H crossings.
                // Engine change and outside policy are committed together
                // with same-frame settings, not partially on failure.
                let programChanged=following.engine_choice!=extra.engine_choice ||
                    following.outside_policy!=extra.outside_policy;
                let ok=if programChanged {
                    engine.configure_extended(next,following.outside_policy,
                        following.engine_choice,1.,0.,350.,0).is_ok()
                }else{
                    engine.configure(next,following.outside_policy).is_ok()
                };
                if ok {
                    *settings=next;
                    if extraChanged || programChanged {
                        if apply_extra(engine,following,SAMPLE_RATE).is_err(){return -3;}
                        *extra=following;
                    }
                }else if extraChanged && !programChanged {
                    // A valid effect control remains independently applicable.
                    if apply_extra(engine,following,SAMPLE_RATE).is_err(){return -3;}
                    *extra=following;
                }
            }
            return 0;
        }
        let mut pos=0usize;
        let mut ei=0usize;
        while pos<f{
            if ei<e&&(EVENTS[ei].offset as usize)==pos{
                let mut next=*settings;
                let mut following=*extra;
                let mut extraChanged=false;
                while ei<e&&(EVENTS[ei].offset as usize)==pos{
                    modify(&mut next,EVENTS[ei]);
                    extraChanged|=modify_extra(&mut following,EVENTS[ei]);
                    ei+=1;
                }
                // Preserve valid previous DSP on impossible L/H crossings.
                // Engine change and outside policy are committed together
                // with same-frame settings, not partially on failure.
                let programChanged=following.engine_choice!=extra.engine_choice ||
                    following.outside_policy!=extra.outside_policy;
                let ok=if programChanged {
                    engine.configure_extended(next,following.outside_policy,
                        following.engine_choice,1.,0.,350.,0).is_ok()
                }else{
                    engine.configure(next,following.outside_policy).is_ok()
                };
                if ok {
                    *settings=next;
                    if extraChanged || programChanged {
                        if apply_extra(engine,following,SAMPLE_RATE).is_err(){return -3;}
                        *extra=following;
                    }
                }else if extraChanged && !programChanged {
                    // A valid effect control remains independently applicable.
                    if apply_extra(engine,following,SAMPLE_RATE).is_err(){return -3;}
                    *extra=following;
                }
            }
            let end=if ei<e{EVENTS[ei].offset as usize}else{f};
            if end<=pos{return -4;}
            let len=end-pos;
            for c in 0..channel_count{
                for i in 0..len{SEG_IN[c*len+i]=INPUT[c*f+pos+i];}
            }
            if engine.process(&SEG_IN[..channel_count*len],
                              &mut SEG_OUT[..channel_count*len],len).is_err(){
                return -5;
            }
            for c in 0..channel_count{
                for i in 0..len{OUTPUT[c*f+pos+i]=SEG_OUT[c*len+i];}
            }
            pos=end;
        }
    }
    0
}
