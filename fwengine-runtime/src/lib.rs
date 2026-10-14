//! Offline native .fwengine executor. Not real-time safe; see Issue #83.
use anyhow::{bail, ensure, Context, Result};
use fwengine_package::{verify_package, Manifest};
use wasmi::{Config, Engine, Instance, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder, TypedFunc};

const FUEL_PREP: u64=15_000_000;
const FUEL_BLOCK: u64=10_000_000;
#[repr(C)]
#[derive(Clone,Copy)]
pub struct ParamEvent {pub id:u32,pub offset:u32,pub value:f64}
type ProcessFn=TypedFunc<(i32,i32,i32,i32,i32,i32),i32>;
pub struct Runtime {
    pub manifest:Manifest,
    store:Store<StoreLimits>,memory:Memory,run:ProcessFn,handle:i32,
    channels:usize,max_frames:usize,input:usize,output:usize,event:usize,
    capacity:usize,faulted:bool,
}
fn section(start:usize,size:usize,limit:usize,align:usize)->Result<(usize,usize)>{
    ensure!(start>0&&start%align==0,"invalid ABI offset");
    let end=start.checked_add(size).context("ABI offset overflow")?;
    ensure!(end<=limit,"WASM ABI offset beyond memory");
    Ok((start,end))
}
fn apart(a:(usize,usize),b:(usize,usize))->bool{a.1<=b.0||b.1<=a.0}
fn compile(engine:&Engine,bytes:&[u8])->Result<Module>{
    let module=Module::new(engine,bytes).context("invalid WASM")?;
    ensure!(module.imports().next().is_none(),"WASM imports forbidden");
    Ok(module)
}
fn config_engine()->Engine{
    let mut c=Config::default();
    c.consume_fuel(true).allow_start_fn(false);
    Engine::new(&c)
}
fn getter(i:&Instance,s:&mut Store<StoreLimits>,name:&str)->Result<i32>{
    Ok(i.get_typed_func::<(),i32>(&*s,name)?.call(s,())?)
}
impl Runtime{
    pub fn prepare(package:&[u8],rate:f64,channels:usize,max_frames:usize)->Result<Self>{
        let p=verify_package(package).map_err(|e|anyhow::anyhow!("{e}"))?;
        ensure!(rate.is_finite()&&(8000.0..=384000.0).contains(&rate),"module sample rate unsupported");
        ensure!(p.manifest.supported_channels.contains(&(channels as u32)),"module channel count unsupported");
        ensure!(max_frames>0&&max_frames<=p.manifest.max_frames as usize,"module frame cap exceeded");
        ensure!(p.manifest.nominal_latency_frames<=4095,"module exceeds fixed PDC");
        let eng=config_engine();
        let code=compile(&eng,&p.wasm)?;
        let limits=StoreLimitsBuilder::new().memory_size(p.manifest.max_memory_bytes as usize)
            .memories(1).instances(1).tables(1).build();
        let mut store=Store::new(&eng,limits);
        store.limiter(|x|x);
        store.set_fuel(FUEL_PREP)?;
        let inst=Linker::<StoreLimits>::new(&eng).instantiate_and_start(&mut store,&code)?;
        let memory=inst.get_memory(&store,"memory").context("missing WASM memory")?;
        ensure!(getter(&inst,&mut store,"fw_abi_major")?==1,"WASM ABI mismatch");
        let handle=inst.get_typed_func::<(f64,i32,i32),i32>(&store,"fw_create")?
            .call(&mut store,(rate,channels as i32,max_frames as i32))?;
        ensure!(handle>0,"fw_create refused host settings");
        let latency=inst.get_typed_func::<i32,i32>(&store,"fw_get_latency_frames")?
            .call(&mut store,handle)?;
        ensure!(latency>=0&&latency as u32==p.manifest.nominal_latency_frames,"manifest latency mismatch");
        let input=getter(&inst,&mut store,"fw_input_offset")? as u32 as usize;
        let output=getter(&inst,&mut store,"fw_output_offset")? as u32 as usize;
        let event=getter(&inst,&mut store,"fw_event_offset")? as u32 as usize;
        let capacity=getter(&inst,&mut store,"fw_event_capacity")?;
        ensure!((1..=8192).contains(&capacity),"bad event capacity");
        ensure!(getter(&inst,&mut store,"fw_event_stride")?==16,"bad event stride");
        let length=memory.data_size(&store);
        ensure!(length<=p.manifest.max_memory_bytes as usize,"WASM memory budget exceeded");
        let a=section(input,channels*max_frames*4,length,4)?;
        let b=section(output,channels*max_frames*4,length,4)?;
        let c=section(event,capacity as usize*16,length,8)?;
        ensure!(apart(a,b)&&apart(a,c)&&apart(b,c),"ABI buffer overlap");
        let run=inst.get_typed_func::<(i32,i32,i32,i32,i32,i32),i32>(&store,"fw_process")?;
        let _=inst.get_typed_func::<i32,i32>(&store,"fw_reset")?;
        let _=inst.get_typed_func::<i32,()>(&store,"fw_destroy")?;
        Ok(Self{manifest:p.manifest,store,memory,run,handle,channels,max_frames,
            input,output,event,capacity:capacity as usize,faulted:false})
    }
    pub fn faulted(&self)->bool{self.faulted}
    /// Test/offline convenience function. Allocates a Vec; not for audio callbacks.
    pub fn process(&mut self,pcm:&[f32],frames:usize,events:&[ParamEvent])->Result<Vec<f32>>{
        let mut output=vec![0.0;pcm.len()];
        self.process_into(pcm,&mut output,frames,events)?;
        Ok(output)
    }
    /// Caller-owned buffers, no host Vec or lock on the successful process path.
    /// RT acceptance additionally requires proving interpreter internals and latency.
    pub fn process_into(&mut self,pcm:&[f32],output:&mut[f32],frames:usize,events:&[ParamEvent])->Result<()>{
        ensure!(output.len()==pcm.len(),"output shape mismatch");
        ensure!(!self.faulted,"disabled WASM instance");
        ensure!(frames<=self.max_frames&&pcm.len()==self.channels*frames,"invalid PCM shape");
        ensure!(events.len()<=self.capacity,"event capacity exceeded");
        let mut last=0;
        for (i,e) in events.iter().enumerate(){
            // S4a binds ONLY the stable physical host IDs 2..5 to the
            // actual shared Stream; all other IDs remain unbound until S4b.
            // The demo Gain fixture retains its separate ID64 contract.
            let allowed=if self.manifest.engine_id=="org.kinotch.stream" {
                match e.id {
                    2|3 => e.value.is_finite()&&(0.001..=20000.0).contains(&e.value),
                    4|5 => e.value.is_finite()&&(0.0..=1.0).contains(&e.value),
                    _=>false
                }
            }else{e.id==64&&e.value.is_finite()&&(0.0..=4.0).contains(&e.value)};
            ensure!(allowed,"unbound or out-of-range canonical host parameter");
            ensure!(e.offset as usize<=if frames==0{0}else{frames-1},"event outside block");
            ensure!(i==0||e.offset>=last,"unsorted automation");
            last=e.offset;
        }
        let limit=self.memory.data_size(&self.store);
        ensure!(limit<=self.manifest.max_memory_bytes as usize,"memory grew over limit");
        let a=section(self.input,pcm.len()*4,limit,4)?;
        let b=section(self.output,pcm.len()*4,limit,4)?;
        let c=section(self.event,events.len()*16,limit,8)?;
        ensure!(apart(a,b)&&apart(a,c)&&apart(b,c),"dynamic memory overlap");
        {
            let mem=self.memory.data_mut(&mut self.store);
            for (i,s) in pcm.iter().enumerate(){
                ensure!(s.is_finite(),"nonfinite input");
                mem[self.input+4*i..self.input+4*i+4].copy_from_slice(&s.to_le_bytes());
            }
            for (i,e) in events.iter().enumerate(){
                let off=self.event+16*i;
                mem[off..off+4].copy_from_slice(&e.id.to_le_bytes());
                mem[off+4..off+8].copy_from_slice(&e.offset.to_le_bytes());
                mem[off+8..off+16].copy_from_slice(&e.value.to_le_bytes());
            }
        }
        self.store.set_fuel(FUEL_BLOCK)?;
        match self.run.call(&mut self.store,(self.handle,self.input as i32,
                self.output as i32,frames as i32,self.event as i32,events.len() as i32)){
            Ok(0)=>{},
            Ok(status)=>{self.faulted=true;bail!("WASM failure status {status}")},
            Err(err)=>{self.faulted=true;bail!("WASM trapped or fuel exhausted: {err}")},
        }
        let limit=self.memory.data_size(&self.store);
        if limit>self.manifest.max_memory_bytes as usize{
            self.faulted=true;bail!("WASM memory limit violated");
        }
        section(self.output,pcm.len()*4,limit,4)?;
        let mem=self.memory.data(&self.store);
        for (i,out) in output.iter_mut().enumerate(){
            let pos=self.output+4*i;
            let v=f32::from_le_bytes(mem[pos..pos+4].try_into()?);
            if !v.is_finite(){self.faulted=true;bail!("nonfinite WASM output")}
            *out=v;
        }
        Ok(())
    }
}

pub mod ffi;
#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn rejects_untrusted_import(){
        let eng=config_engine();
        let bytes=wat::parse_str("(module (import \"host\" \"clock\" (func)))").unwrap();
        assert!(compile(&eng,&bytes).is_err());
    }
    #[test] fn loop_is_fuel_bounded(){
        let eng=config_engine();
        let bytes=wat::parse_str("(module (func (export \"forever\") (loop (br 0))))").unwrap();
        let code=compile(&eng,&bytes).unwrap();
        let mut store=Store::new(&eng,());
        store.set_fuel(1000).unwrap();
        let inst=Linker::<()>::new(&eng).instantiate_and_start(&mut store,&code).unwrap();
        assert!(inst.get_typed_func::<(),()>(&store,"forever").unwrap()
            .call(&mut store,()).is_err());
    }
    #[test] fn memory_bounds(){assert!(section(0,4,100,4).is_err());
        assert!(section(96,8,100,4).is_err());
        assert!(!apart((4,12),(8,16)));}
}
