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
static mut CHANNELS:usize=0;

fn defaults(rate:f64)->Settings {
    Settings{low:20.,high:16000_f64.min(rate*0.45),curvature:1.,
             invert:0.,mode:Progression::Blend,quality:0}
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
            STREAM=Some(engine);SETTINGS=Some(settings);
            CHANNELS=channels as usize;
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
    if handle==HANDLE{unsafe{STREAM=None;SETTINGS=None;CHANNELS=0;}}
}
fn valid_event(event:Event)->bool{
    event.value.is_finite()&&match event.id{
        2|3=>event.value>=0.001&&event.value<=20000.,
        4|5=>event.value>=0.&&event.value<=1.,
        _=>false,
    }
}
fn modify(settings:&mut Settings,event:Event) {
    match event.id{
        2=>settings.low=event.value,
        3=>settings.high=event.value,
        4=>settings.invert=event.value,
        5=>settings.curvature=event.value,
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
        if STREAM.is_none()||SETTINGS.is_none()||CHANNELS==0{return -1;}
        let channel_count=CHANNELS;
        let mut last=0;
        for i in 0..e {
            let event=EVENTS[i];
            if !valid_event(event)||event.offset as usize >= f.max(1)||
               (i>0&&event.offset<last){return -2;}
            last=event.offset;
        }
        let engine=STREAM.as_mut().unwrap();
        let settings=SETTINGS.as_mut().unwrap();
        if f==0 {
            if e>0 {
                let mut next=*settings;
                for i in 0..e{modify(&mut next,EVENTS[i]);}
                // Physical host parameters can individually be in-range but
                // jointly impossible (L>=H or H>=host Nyquist). These are
                // ordinary DAW automation crossings, NOT a WASM runtime trap.
                // Keep the last verified working settings until the next
                // valid same-sample combination is received. The host sends
                // full L/H snapshot on every new PCM packet for recovery.
                if engine.configure(next,OUTSIDE_PASS).is_ok(){
                    *settings=next;
                }
            }
            return 0;
        }
        let mut pos=0usize;
        let mut ei=0usize;
        while pos<f{
            if ei<e&&(EVENTS[ei].offset as usize)==pos{
                let mut next=*settings;
                while ei<e&&(EVENTS[ei].offset as usize)==pos{
                    modify(&mut next,EVENTS[ei]);ei+=1;
                }
                // Physical host parameters can individually be in-range but
                // jointly impossible (L>=H or H>=host Nyquist). These are
                // ordinary DAW automation crossings, NOT a WASM runtime trap.
                // Keep the last verified working settings until the next
                // valid same-sample combination is received. The host sends
                // full L/H snapshot on every new PCM packet for recovery.
                if engine.configure(next,OUTSIDE_PASS).is_ok(){
                    *settings=next;
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
