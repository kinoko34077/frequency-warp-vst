//! S3a native sandboxed WASM execution candidate.
//! Preparation, ZIP validation, code compilation, VM creation and new-instance
//! state setup MUST occur off the audio thread. Caller-owned buffers, no
//! allocations by this adapter in process(); external VM allocation and
//! worst-case CPU budgets require S3b profiling before RT integration.
//! No VST3 host calls or filesystem reads take place inside process().

use fwengine_package::{verify_package, Manifest};
use wasmi::{
    CompilationMode, Config, Engine, Linker, Memory, Module, Store,
    StoreLimits, StoreLimitsBuilder, TypedFunc,
};
use std::ops::Range;

const PREPARE_FUEL: u64 = 50_000_000;
const PROCESS_FUEL: u64 = 50_000_000;
const MAX_EVENT_CAPACITY: usize = 4096;

#[derive(Clone, Copy, Debug)]
pub struct Event {
    pub param_id: u32,
    pub sample_offset: u32,
    pub canonical_value: f64,
}

pub struct PreparedEngine {
    pub manifest: Manifest,
    store: Store<StoreLimits>,
    memory: Memory,
    process: TypedFunc<(i32,i32,i32,i32,i32,i32),i32>,
    reset: TypedFunc<i32,i32>,
    handle: i32,
    channels: usize,
    max_frames: usize,
    input: Range<usize>,
    output: Range<usize>,
    events: Range<usize>,
    event_capacity: usize,
    initial_memory_bytes: usize,
    process_fuel: u64,
    faulted: bool,
}
fn vm_error(e: impl std::fmt::Display) -> String { format!("WASM: {e}") }
fn bounded_region(offset: i32, size: usize, total: usize) -> Result<Range<usize>,String> {
    if offset <= 0 {return Err("negative or zero WASM offset".into());}
    let start=offset as usize;
    let end=start.checked_add(size).ok_or("offset overflow")?;
    if end>total{return Err("WASM memory range exceeds allocated memory".into());}
    Ok(start..end)
}
fn disjoint(a:&Range<usize>,b:&Range<usize>) -> bool {
    a.end<=b.start||b.end<=a.start
}
impl PreparedEngine {
    /// Verify the complete S1 .fwengine ZIP, then compile/instantiate with
    /// no imports and fixed fuel/memory/ABI on a non-realtime worker.
    pub fn prepare(bytes:&[u8], rate:f64, channels:u32, max_frames:u32) -> Result<Self,String> {
        let pack=verify_package(bytes).map_err(|e|e.to_string())?;
        let manifest=pack.manifest;
        if !rate.is_finite()||rate<=0.0
            || !manifest.supported_channels.contains(&channels)
            || max_frames==0||max_frames>manifest.max_frames {
            return Err("engine sample-rate/channels/block incompatible".into());
        }
        let mut cfg=Config::default();
        cfg.consume_fuel(true);
        cfg.allow_start_fn(false);
        cfg.compilation_mode(CompilationMode::Eager);
        let engine=Engine::new(&cfg);
        let module=Module::new(&engine, &pack.wasm).map_err(vm_error)?;
        if module.imports().next().is_some() {
            return Err("host imports are not permitted".into());
        }
        let limits=StoreLimitsBuilder::new()
            .memory_size(manifest.max_memory_bytes as usize)
            .memories(1).tables(2).instances(1).build();
        let mut store=Store::new(&engine,limits);
        store.limiter(|state|state);
        store.set_fuel(PREPARE_FUEL).map_err(vm_error)?;
        let linker=Linker::<StoreLimits>::new(&engine);
        let instance=linker.instantiate_and_start(&mut store,&module).map_err(vm_error)?;
        let get_u32=|name:&str, store:&mut Store<StoreLimits>|
            -> Result<i32,String> {
            let func=instance.get_typed_func::<(),i32>(&*store,name).map_err(vm_error)?;
            func.call(store,()).map_err(vm_error)
        };
        if get_u32("fw_abi_major",&mut store)?!=1 {
            return Err("unsupported wasm ABI major".into());
        }
        let memory=instance.get_memory(&store,"memory")
            .ok_or("WASM must export linear memory")?;
        let create=instance.get_typed_func::<(f64,i32,i32),i32>(&store,"fw_create")
            .map_err(vm_error)?;
        let get_latency=instance.get_typed_func::<i32,i32>(&store,"fw_get_latency_frames")
            .map_err(vm_error)?;
        let process=instance.get_typed_func::<(i32,i32,i32,i32,i32,i32),i32>(&store,"fw_process")
            .map_err(vm_error)?;
        let reset=instance.get_typed_func::<i32,i32>(&store,"fw_reset")
            .map_err(vm_error)?;
        let _:TypedFunc<i32,()>=instance.get_typed_func::<i32,()>(&store,"fw_destroy")
            .map_err(vm_error)?;
        let handle=create.call(&mut store,(rate,channels as i32,max_frames as i32))
            .map_err(vm_error)?;
        if handle<=0{return Err("fw_create returned an invalid handle".into());}
        let latency=get_latency.call(&mut store,handle).map_err(vm_error)?;
        if latency<0||latency as u32 !=manifest.nominal_latency_frames {
            return Err("WASM latency differs from checked manifest".into());
        }
        let input_offset=get_u32("fw_input_offset",&mut store)?;
        let output_offset=get_u32("fw_output_offset",&mut store)?;
        let event_offset=get_u32("fw_event_offset",&mut store)?;
        let event_capacity=get_u32("fw_event_capacity",&mut store)?;
        let event_stride=get_u32("fw_event_stride",&mut store)?;
        if event_stride!=16||event_capacity<=0||
            event_capacity as usize>MAX_EVENT_CAPACITY {
            return Err("unsupported parameter event layout/capacity".into());
        }
        if input_offset%4!=0||output_offset%4!=0||event_offset%8!=0 {
            return Err("WASM memory alignment invalid".into());
        }
        let memory_bytes=memory.data_size(&store);
        if memory_bytes>manifest.max_memory_bytes as usize {
            return Err("WASM memory larger than manifest limit".into());
        }
        let pcm_bytes=(channels as usize)*(max_frames as usize)*4;
        let input=bounded_region(input_offset,pcm_bytes,memory_bytes)?;
        let output=bounded_region(output_offset,pcm_bytes,memory_bytes)?;
        let events=bounded_region(event_offset,event_capacity as usize *16,memory_bytes)?;
        if !disjoint(&input,&output)||!disjoint(&input,&events)||
           !disjoint(&output,&events) {
            return Err("WASM input/output/events memory alias".into());
        }
        Ok(Self{
            manifest,store,memory,process,reset,handle,
            channels:channels as usize,max_frames:max_frames as usize,
            input,output,events,event_capacity:event_capacity as usize,
            initial_memory_bytes:memory_bytes,process_fuel:PROCESS_FUEL,
            faulted:false,
        })
    }
    pub fn channels(&self)->usize{self.channels}
    pub fn is_faulted(&self)->bool{self.faulted}
    /// Override exclusively off-RT; nonzero finite fuel stops infinite loops.
    pub fn set_fuel_limit(&mut self, fuel:u64) {self.process_fuel=fuel.max(1);}
    pub fn reset(&mut self)->Result<(),&'static str> {
        if self.faulted{return Err("faulted engine must be recreated off RT");}
        self.store.set_fuel(PREPARE_FUEL).map_err(|_|"fuel reset")?;
        if self.reset.call(&mut self.store,self.handle).map_err(|_|"reset trap")?!=0 {
            self.faulted=true;return Err("engine reset failed");
        }
        Ok(())
    }
    /// Planar contiguous PCM (channels*actual frames) and bounded events.
    /// Output remains unchanged on any engine failure.
    pub fn process(&mut self, input:&[f32],output:&mut[f32],
                   frames:usize,events:&[Event]) ->Result<(),&'static str> {
        if self.faulted{return Err("engine previously trapped");}
        if frames>self.max_frames||input.len()!=self.channels*frames
           ||output.len()!=input.len()||events.len()>self.event_capacity {
            return Err("PCM/event block exceeds prepared bounds");
        }
        if input.iter().any(|x|!x.is_finite()){return Err("non-finite input");}
        let mut previous=0;
        for e in events {
            if !e.canonical_value.is_finite() ||
                (frames==0 && e.sample_offset!=0) ||
                (frames>0 && e.sample_offset as usize>=frames) ||
                e.sample_offset<previous||e.param_id>=128 {
                return Err("invalid parameter event");
            }
            previous=e.sample_offset;
        }
        {
            let data=self.memory.data_mut(&mut self.store);
            if data.len()!=self.initial_memory_bytes {
                self.faulted=true;return Err("unexpected WASM memory growth");
            }
            for (i,&value) in input.iter().enumerate() {
                let at=self.input.start+i*4;
                data[at..at+4].copy_from_slice(&value.to_le_bytes());
            }
            for (i,e) in events.iter().enumerate() {
                let at=self.events.start+i*16;
                data[at..at+4].copy_from_slice(&e.param_id.to_le_bytes());
                data[at+4..at+8].copy_from_slice(&e.sample_offset.to_le_bytes());
                data[at+8..at+16].copy_from_slice(&e.canonical_value.to_le_bytes());
            }
        }
        if self.store.set_fuel(self.process_fuel).is_err() {
            self.faulted=true;return Err("WASM fuel control failed");
        }
        let result=self.process.call(&mut self.store,
            (self.handle,self.input.start as i32,self.output.start as i32,
             frames as i32,self.events.start as i32,events.len() as i32));
        if result.is_err() {
            self.faulted=true;return Err("WASM trap or fuel budget exceeded");
        }
        if result!=Ok(0) {
            self.faulted=true;return Err("WASM process returned nonzero status");
        }
        let data=self.memory.data(&self.store);
        if data.len()!=self.initial_memory_bytes {
            self.faulted=true;return Err("WASM grew memory during processing");
        }
        // Two-phase commit: a bad sample must never leak partially to the host.
        for i in 0..output.len() {
            let at=self.output.start+i*4;
            let x=f32::from_le_bytes(data[at..at+4].try_into().unwrap());
            if !x.is_finite() {
                self.faulted=true;return Err("non-finite WASM output");
            }
        }
        for (i,out) in output.iter_mut().enumerate() {
            let at=self.output.start+i*4;
            *out=f32::from_le_bytes(data[at..at+4].try_into().unwrap());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn ranges() {
        assert_eq!(bounded_region(16,8,24).unwrap(),16..24);
        assert!(bounded_region(-1,4,100).is_err());
        assert!(bounded_region(20,8,24).is_err());
        assert!(disjoint(&(0..4),&(4..12)));
        assert!(!disjoint(&(0..5),&(4..12)));
    }
}
