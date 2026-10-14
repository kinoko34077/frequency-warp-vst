//! V1 ABI around the existing frequency_warp_core::Stream, not a DSP fork.
//! One Stream per Wasmi instance. Preparation/destruction allocate off audio RT.
use frequency_warp_core::{Stream,Settings,Progression};
use std::ptr::{addr_of,addr_of_mut};
const FRAMES:usize=2048;
const SAMPLES:usize=FRAMES*2;
const EVENTS_MAX:usize=128;
const HANDLE:u32=1;
#[repr(C)]
#[derive(Clone,Copy)]
pub struct Event {pub id:u32,pub offset:u32,pub value:f64}
static mut INPUT:[f32;SAMPLES]=[0.;SAMPLES];
static mut OUTPUT:[f32;SAMPLES]=[0.;SAMPLES];
static mut TMP_IN:[f32;SAMPLES]=[0.;SAMPLES];
static mut TMP_OUT:[f32;SAMPLES]=[0.;SAMPLES];
static mut EVENTS:[Event;EVENTS_MAX]=[Event{id:2,offset:0,value:20.};EVENTS_MAX];
struct ModuleState {stream:Stream,settings:Settings,channels:usize,rate:f64}
static mut STATE:Option<ModuleState>=None;
#[no_mangle]pub extern "C" fn fw_abi_major()->u32 {1}
#[no_mangle]pub extern "C" fn fw_input_offset()->u32 {addr_of!(INPUT) as usize as u32}
#[no_mangle]pub extern "C" fn fw_output_offset()->u32 {addr_of_mut!(OUTPUT) as usize as u32}
#[no_mangle]pub extern "C" fn fw_event_offset()->u32 {addr_of_mut!(EVENTS) as usize as u32}
#[no_mangle]pub extern "C" fn fw_event_capacity()->u32 {EVENTS_MAX as u32}
#[no_mangle]pub extern "C" fn fw_event_stride()->u32 {16}
#[no_mangle]pub extern "C" fn fw_create(rate:f64,channels:u32,max_block:u32)->u32 {
    if !rate.is_finite()||!(8000.0..=384000.0).contains(&rate)||
       !(1..=2).contains(&channels)||max_block==0||max_block as usize>FRAMES{return 0;}
    unsafe {
        if STATE.is_some(){return 0;}
        let settings=Settings{low:20.,high:16000_f64.min(rate*0.45),
            curvature:1.,invert:0.,mode:Progression::Blend,quality:0};
        match Stream::new(rate,channels as usize,settings,0) {
            Ok(stream)=>{STATE=Some(ModuleState{stream,settings,rate,channels:channels as usize});HANDLE}
            Err(_)=>0
        }
    }
}
#[no_mangle]pub extern "C" fn fw_get_latency_frames(handle:u32)->u32 {
    if handle!=HANDLE{return u32::MAX;}
    unsafe {STATE.as_ref().map(|s|s.stream.latency() as u32).unwrap_or(u32::MAX)}
}
#[no_mangle]pub extern "C" fn fw_reset(handle:u32)->i32 {
    if handle!=HANDLE{return -1;}
    unsafe {if let Some(s)=STATE.as_mut(){s.stream.reset();0}else{-1}}
}
#[no_mangle]pub extern "C" fn fw_destroy(handle:u32){
    if handle==HANDLE{unsafe{STATE=None;}}
}
fn apply(s:&mut ModuleState,events:&[Event])->Result<(),()> {
    let mut candidate=s.settings;
    for e in events {
        if !e.value.is_finite(){return Err(());}
        match e.id {
            2 if (0.001..=20000.).contains(&e.value)=>candidate.low=e.value,
            3 if (0.001..=20000.).contains(&e.value)=>candidate.high=e.value,
            4 if (0.0..=1.0).contains(&e.value)=>candidate.invert=e.value,
            5 if (0.0..=1.0).contains(&e.value)=>candidate.curvature=e.value,
            _=>return Err(())
        }
    }
    if candidate.low>=candidate.high||candidate.high>=s.rate*0.5{return Err(());}
    s.stream.configure(candidate,0).map_err(|_|())?;
    s.settings=candidate;
    Ok(())
}
unsafe fn segment(s:&mut ModuleState,start:usize,len:usize,frames:usize)->Result<(),()> {
    if len==0{return Ok(());}
    let src=std::slice::from_raw_parts(addr_of!(INPUT) as *const f32,SAMPLES);
    let input=std::slice::from_raw_parts_mut(addr_of_mut!(TMP_IN) as *mut f32,SAMPLES);
    for ch in 0..s.channels {
        input[ch*len..ch*len+len].copy_from_slice(&src[ch*frames+start..ch*frames+start+len]);
    }
    let processed=std::slice::from_raw_parts_mut(addr_of_mut!(TMP_OUT) as *mut f32,SAMPLES);
    s.stream.process(&input[..s.channels*len],&mut processed[..s.channels*len],len)
        .map_err(|_|())?;
    let dst=std::slice::from_raw_parts_mut(addr_of_mut!(OUTPUT) as *mut f32,SAMPLES);
    for ch in 0..s.channels {
        dst[ch*frames+start..ch*frames+start+len]
           .copy_from_slice(&processed[ch*len..ch*len+len]);
    }
    Ok(())
}
#[no_mangle]
pub extern "C" fn fw_process(handle:u32,input:u32,output:u32,frames:u32,
                              event:u32,count:u32)->i32 {
    if handle!=HANDLE||input!=fw_input_offset()||output!=fw_output_offset()||
       event!=fw_event_offset()||frames as usize>FRAMES||count as usize>EVENTS_MAX{return -1;}
    unsafe {
        let Some(state)=STATE.as_mut() else {return -1;};
        let events=std::slice::from_raw_parts(addr_of!(EVENTS) as *const Event,count as usize);
        let mut prev=0;
        for (i,e) in events.iter().enumerate() {
            if !e.value.is_finite()||(i>0&&e.offset<prev)||
               (frames==0&&e.offset!=0)||(frames>0&&e.offset>=frames) {return -2;}
            prev=e.offset;
        }
        if frames==0{return if apply(state,events).is_ok(){0}else{-2};}
        let mut start=0usize;
        let mut i=0usize;
        while i<events.len(){
            let at=events[i].offset as usize;
            if segment(state,start,at-start,frames as usize).is_err(){return -3;}
            start=at;let first=i;
            while i<events.len()&&events[i].offset as usize==at{i+=1;}
            if apply(state,&events[first..i]).is_err(){return -2;}
        }
        if segment(state,start,frames as usize-start,frames as usize).is_err(){return -3;}
    }
    0
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn shared_stream_metadata(){
        assert_eq!(fw_abi_major(),1);
        assert_eq!(fw_event_stride(),16);
        assert_eq!(fw_create(48000.,2,128),1);
        assert_eq!(fw_get_latency_frames(HANDLE),1023);
        assert_eq!(fw_reset(HANDLE),0);
        fw_destroy(HANDLE);
    }
}
