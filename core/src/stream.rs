//! AudioWorklet/VST-ready *streaming* prototype on the same Rust DSP
//! definitions. No whole-track render; 128-frame calls have persistent state.
//! This retains experimental R2.1 peak-tracking limitations and N-1 latency.

use super::{fft,fold_frequency,map_frequency,quality,Complex,Progression,Settings,Track,PI,TAU};

pub struct Stream {
    sample_rate:f64,
    channels:usize,
    n:usize,
    hop:usize,
    max_peaks:usize,
    floor:f64,
    settings:Settings,
    outside:u32,
    engine:u32, // 0 peak oscillator, 1 FFT bin relocation, 2 Ring Mod, 3 harmonic pitch->shift
    pitch_ratio:f64,
    shift_hz:f64,
    carrier_hz:f64,
    ring_phase:f64,
    zero_mode:u32, // 0=reflect,1=kill,2=fade
    received:u64,
    input:Vec<Vec<f64>>,
    output:Vec<Vec<f64>>,
    weights:Vec<f64>,
    window_sq:Vec<f64>,
    spectrum:Vec<Vec<Complex>>,
    previous:Vec<Vec<Complex>>,
    mag:Vec<f64>,
    candidates:Vec<usize>,
    peaks:Vec<usize>,
    tracks:Vec<Track>,
    next_tracks:Vec<Track>,
    used:Vec<bool>,
    complement:Vec<Complex>,
    relocated:Vec<Complex>,
}

impl Stream {
    pub fn new(sample_rate:f64, channels:usize, settings:Settings, outside:u32)->Result<Self,&'static str>{
        Self::new_extended(sample_rate,channels,settings,outside,0,1.0,0.0,350.0,0,4)
    }
    pub fn new_extended(sample_rate:f64,channels:usize,settings:Settings,outside:u32,
        engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,zero_mode:u32,hop_div:u32)
        ->Result<Self,&'static str>{
        if engine>3||zero_mode>2||![4,8].contains(&hop_div)||
           !pitch_ratio.is_finite()||pitch_ratio<=0.0||pitch_ratio>4.0||
           !shift_hz.is_finite()||shift_hz.abs()>20000.0||
           !carrier_hz.is_finite()||carrier_hz< -1.0||carrier_hz>20000.0 {
            return Err("invalid streaming engine settings");
        }
        if !sample_rate.is_finite()||sample_rate<=0.0||!(1..=2).contains(&channels)
           ||settings.high>=sample_rate*0.5||outside>1 {return Err("invalid stream config");}
        map_frequency(settings.low,settings)?;
        let q=quality(settings.quality).ok_or("invalid streaming quality")?;
        let hop=q.n / hop_div as usize;
        // Per-block processing has no persistent large file buffer.
        Ok(Self{
            sample_rate,channels,n:q.n,hop,max_peaks:q.max_peaks,
            floor:q.floor,settings,outside,engine,pitch_ratio,shift_hz,carrier_hz,
            ring_phase:0.0,zero_mode,received:0,
            input:vec![vec![0.0;q.n];channels],
            output:vec![vec![0.0;q.n*2];channels],
            weights:vec![0.0;q.n*2],
            window_sq:(0..q.n).map(|i|{
                let w=0.5-0.5*(TAU*i as f64/q.n as f64).cos();w*w
            }).collect(),
            spectrum:vec![vec![Complex::ZERO;q.n];channels],
            previous:vec![vec![Complex::ZERO;q.n];channels],
            mag:vec![0.0;q.n/2+1],
            candidates:Vec::with_capacity(q.n/2),
            peaks:Vec::with_capacity(q.max_peaks),
            tracks:Vec::with_capacity(q.max_peaks),
            next_tracks:Vec::with_capacity(q.max_peaks),
            used:vec![false;q.max_peaks],
            complement:vec![Complex::ZERO;q.n],
            relocated:vec![Complex::ZERO;q.n],
        })
    }
    pub fn latency(&self)->usize{if self.engine==2 {0} else {self.n-1}}
    pub fn configure(&mut self,settings:Settings,outside:u32)->Result<(),&'static str>{
        if settings.quality!=self.settings.quality{
            return Err("quality change requires stream rebuild");
        }
        if outside>1||settings.high>=self.sample_rate*0.5{return Err("invalid stream configuration");}
        map_frequency(settings.low,settings)?;
        self.settings=settings;
        self.outside=outside;
        Ok(())
    }
    pub fn configure_extended(&mut self,settings:Settings,outside:u32,engine:u32,
        pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,zero_mode:u32)->Result<(),&'static str>{
        if engine>3||zero_mode>2||!pitch_ratio.is_finite()||pitch_ratio<=0.0||pitch_ratio>4.0||
           !shift_hz.is_finite()||shift_hz.abs()>20000.0||
           !carrier_hz.is_finite()||carrier_hz< -1.0||carrier_hz>20000.0{return Err("invalid engine parameters");}
        self.configure(settings,outside)?;
        if self.engine!=engine {self.reset();}
        self.engine=engine;self.pitch_ratio=pitch_ratio;self.shift_hz=shift_hz;
        self.carrier_hz=carrier_hz;self.zero_mode=zero_mode;
        Ok(())
    }
    pub fn reset(&mut self){
        self.received=0;
        self.ring_phase=0.0;
        for x in &mut self.input{x.fill(0.0);}
        for x in &mut self.output{x.fill(0.0);}
        for x in &mut self.spectrum{x.fill(Complex::ZERO);}
        for x in &mut self.previous{x.fill(Complex::ZERO);}
        self.weights.fill(0.0);
        self.tracks.clear();self.next_tracks.clear();
    }
    pub fn process(&mut self,input:&[f32],output:&mut [f32],frames:usize)->Result<(),&'static str>{
        if frames==0||frames>2048||input.len()!=frames*self.channels||output.len()!=input.len(){
            return Err("invalid streaming planar block");
        }
        // Engine 2 is a true sample-by-sample ring modulator, without FFT lookahead.
        if self.engine==2 {
            // -1 is a stable ABI sentinel: link Ring carrier to the Rust
            // mapping's *input-domain* Fold kink. A Blend has no kink; fail
            // closed by using 0 Hz rather than manufacturing a midpoint.
            let carrier=if self.carrier_hz==-1.0 {
                fold_frequency(self.settings).unwrap_or(0.0)
            }else{self.carrier_hz};
            let inc=TAU*carrier/self.sample_rate;
            for i in 0..frames {
                let carrier=self.ring_phase.cos() as f32;
                for c in 0..self.channels {output[c*frames+i]=input[c*frames+i]*carrier;}
                self.ring_phase=(self.ring_phase+inc).rem_euclid(TAU);
            }
            self.received+=frames as u64;
            return Ok(());
        }
        // Input and output layout: [channel0 frames][channel1 frames].
        for i in 0..frames {
            let t=self.received as usize;
            let write=t%self.n;
            for c in 0..self.channels {self.input[c][write]=input[c*frames+i] as f64;}
            if t+1>=self.n && ((t+1-self.n)%self.hop==0){
                self.process_frame(t+1-self.n);
            }
            if t+1>=self.n{
                let pos=t+1-self.n;
                let slot=pos%(self.n*2);
                let w=self.weights[slot];
                for c in 0..self.channels{
                    output[c*frames+i]=if w>1e-9 {(self.output[c][slot]/w) as f32} else {0.0};
                    self.output[c][slot]=0.0;
                }
                self.weights[slot]=0.0;
            }else{
                for c in 0..self.channels{output[c*frames+i]=0.0;}
            }
            self.received+=1;
        }
        Ok(())
    }
    fn process_frame(&mut self,start:usize){
        let half=self.n/2;
        let step=self.sample_rate/self.n as f64;
        for c in 0..self.channels{
            for i in 0..self.n{
                let ring=(start+i)%self.n;
                self.spectrum[c][i]=Complex{
                    r:self.input[c][ring]*self.window_sq[i].sqrt(),i:0.0
                };
            }
            fft(&mut self.spectrum[c],false);
        }
        let mut greatest=0.0f64;
        for k in 1..half{
            let mut m=0.0;
            for c in 0..self.channels{
                let z=self.spectrum[c][k];
                m+=z.r*z.r+z.i*z.i;
            }
            self.mag[k]=m.sqrt();
            greatest=greatest.max(self.mag[k]);
        }
        if self.engine==1 {
            // FFT-bin spectral relocation. Distinct from partial/oscillator synthesis:
            // bin grid quantization and imperfect phase continuity are known limits.
            for c in 0..self.channels {
                self.relocated.fill(Complex::ZERO);
                for k in 1..half {
                    let f=k as f64*step;
                    let target=if f>=self.settings.low&&f<=self.settings.high {
                        map_frequency(f,self.settings).unwrap_or(f)
                    }else if self.outside==1 {f} else {continue};
                    if target<=0.0||target>=self.sample_rate*0.5 {continue;}
                    let dest=(target/step).round() as usize;
                    if dest==0||dest>=half {continue;}
                    self.relocated[dest].r+=self.spectrum[c][k].r;
                    self.relocated[dest].i+=self.spectrum[c][k].i;
                }
                fft(&mut self.relocated,true);
                for i in 0..self.n {
                    let slot=(start+i)%(self.n*2);
                    self.output[c][slot]+=2.0*self.relocated[i].r*self.window_sq[i].sqrt();
                }
            }
            for i in 0..self.n {let slot=(start+i)%(self.n*2);self.weights[slot]+=self.window_sq[i];}
            std::mem::swap(&mut self.previous,&mut self.spectrum);
            return;
        }
        let threshold=(greatest*self.floor).max(1e-10);
        self.candidates.clear();
        for k in 2..half-1{
            if self.mag[k]>=threshold&&self.mag[k]>=self.mag[k-1]&&self.mag[k]>self.mag[k+1]{
                self.candidates.push(k);
            }
        }
        self.candidates.sort_unstable_by(|a,b|self.mag[*b].total_cmp(&self.mag[*a]));
        self.peaks.clear();
        for &k in self.candidates.iter().take(self.max_peaks){self.peaks.push(k);}
        self.peaks.sort_unstable();
        self.used.fill(false);
        self.next_tracks.clear();

        for &k in &self.peaks{
            let ref_ch=if self.spectrum[0][k].magnitude()>1e-10{0}else{self.channels-1};
            let phase=self.spectrum[ref_ch][k].angle();
            let magnitude=self.mag[k];
            let frequency=if self.received>=self.n as u64{
                let prev=self.previous[ref_ch][k];
                if prev.magnitude()>1e-8{
                    let delta=(phase-prev.angle()-TAU*k as f64*self.hop as f64/self.n as f64+PI)
                        .rem_euclid(TAU)-PI;
                    k as f64*step+delta/(TAU*self.hop as f64/self.sample_rate)
                }else{self.interpolate(k,step)}
            }else{
                self.interpolate(k,step)
            };
            if !frequency.is_finite() ||frequency<self.settings.low||frequency>self.settings.high{continue;}
            let target=if self.engine==3 {
                // #16 ideal harmonic spacing model: Pitch first, then constant Hz shift.
                // Negative target handled by explicit 0Hz policy below.
                self.pitch_ratio*frequency+self.shift_hz
            }else{
                match map_frequency(frequency,self.settings){Ok(f)=>f,Err(_)=>continue}
            };
            let (target,fade_gain)=if target<0.0 {
                match self.zero_mode {
                    0=>(target.abs(),1.0), // Reflect about 0Hz
                    1=>continue, // Kill negative output
                    _=>{
                        // One FFT-bin-wide experimental fade beyond the 0Hz
                        // crossing. The old implementation mapped to 0Hz and
                        // immediately discarded the sample, making Fade = Kill.
                        let negative=target.abs();
                        if negative>=step {continue;}
                        (negative, (1.0-negative/step).clamp(0.0,1.0))
                    }
                }
            }else{(target,1.0)};
            if !(target>0.0&&target<self.sample_rate/2.0){continue;}
            let diff=target-frequency;
            let mut closest=None;
            let mut dist=f64::INFINITY;
            for (j,old) in self.tracks.iter().enumerate(){
                let d=(old.frequency-frequency).abs();
                if !self.used[j]&&d<dist {dist=d;closest=Some(j);}
            }
            let mut shift=0.0;
            if let Some(j)=closest{
                if dist<(3.0*step).max(0.05*frequency){
                    self.used[j]=true;
                    let old=self.tracks[j];
                    shift=old.phase_shift+PI*(old.difference+diff)*self.hop as f64/self.sample_rate;
                }
            }
            self.next_tracks.push(Track{frequency,difference:diff,phase_shift:shift});

            // At window centre, FFT-bin phase and carrier phase share a
            // common origin. Shared shift preserves L/R phase differences.
            let omega=TAU*target/self.sample_rate;
            let rot_r=omega.cos();let rot_i=omega.sin();
            for c in 0..self.channels{
                let z=self.spectrum[c][k];
                let amplitude=4.0*z.magnitude()/self.n as f64*fade_gain;
                if amplitude<1e-9{continue;}
                let centre_phase=z.angle()+PI*k as f64+shift;
                let start_phase=centre_phase-omega*(self.n as f64/2.0);
                let mut cr=start_phase.cos();
                let mut ci=start_phase.sin();
                for i in 0..self.n{
                    let slot=(start+i)%(self.n*2);
                    self.output[c][slot]+=amplitude*cr*self.window_sq[i];
                    let new_r=cr*rot_r-ci*rot_i;
                    ci=cr*rot_i+ci*rot_r;cr=new_r;
                }
            }
        }
        // Reconstruct out-of-range bins, never duplicate entire dry signal.
        if self.outside==1{
            for c in 0..self.channels{
                self.complement.fill(Complex::ZERO);
                for k in 0..=half{
                    let freq=k as f64*step;
                    if freq<self.settings.low || freq>self.settings.high{
                        self.complement[k]=self.spectrum[c][k];
                        if k>0&&k<half{
                            self.complement[self.n-k]=self.spectrum[c][self.n-k];
                        }
                    }
                }
                fft(&mut self.complement,true);
                for i in 0..self.n{
                    let slot=(start+i)%(self.n*2);
                    // FFT inverse already has analysis Hann. Synthesis Hann
                    // is the second factor needed for overlap-add.
                    self.output[c][slot]+=self.complement[i].r*self.window_sq[i].sqrt();
                }
            }
        }
        for i in 0..self.n{
            let slot=(start+i)%(self.n*2);
            self.weights[slot]+=self.window_sq[i];
        }
        std::mem::swap(&mut self.tracks,&mut self.next_tracks);
        std::mem::swap(&mut self.previous,&mut self.spectrum);
    }
    fn interpolate(&self,k:usize,step:f64)->f64{
        let l=self.mag[k-1].max(1e-12).ln();
        let m=self.mag[k].max(1e-12).ln();
        let r=self.mag[k+1].max(1e-12).ln();
        let d=l-2.0*m+r;
        let fraction=if d.abs()>1e-10{(0.5*(l-r)/d).clamp(-0.5,0.5)}else{0.0};
        (k as f64+fraction)*step
    }
}

fn mode_from_number(mode:u32)->Progression{
    match mode{1=>Progression::Blend,2=>Progression::FoldLow,_=>Progression::FoldHigh}
}
fn params(low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32)->Settings{
    Settings{low,high,curvature:p,invert:amount,mode:mode_from_number(mode),quality:quality_id}
}
#[no_mangle]
pub extern "C" fn warp_stream_create(
    sample_rate:f64,channels:u32,low:f64,high:f64,p:f64,
    amount:f64,mode:u32,quality_id:u32,outside:u32
)->*mut Stream{
    match Stream::new(sample_rate,channels as usize,params(low,high,p,amount,mode,quality_id),outside){
        Ok(stream)=>Box::into_raw(Box::new(stream)),
        Err(_)=>std::ptr::null_mut()
    }
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_free(ptr:*mut Stream){
    if !ptr.is_null(){drop(Box::from_raw(ptr));}
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_reset(ptr:*mut Stream)->i32{
    if ptr.is_null(){return -1;}(&mut *ptr).reset();0
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_latency(ptr:*const Stream)->u32{
    if ptr.is_null(){0}else{(&*ptr).latency() as u32}
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_set(
    ptr:*mut Stream,low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,outside:u32
)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).configure(params(low,high,p,amount,mode,quality_id),outside){
        Ok(_)=>0,Err(_)=>-2
    }
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_process(
    ptr:*mut Stream,src:*const f32,dst:*mut f32,frames:u32
)->i32{
    if ptr.is_null()||src.is_null()||dst.is_null()||frames==0||frames>2048{return -1;}
    let stream=&mut *ptr;
    let n=frames as usize*stream.channels;
    let inp=std::slice::from_raw_parts(src,n);
    let out=std::slice::from_raw_parts_mut(dst,n);
    match stream.process(inp,out,frames as usize){Ok(_)=>0,Err(_)=>-2}
}


/* Extended native/WASM streaming ABI: old entry points remain binary compatible.
 * engine: 0=tracked STFT,1=FFT-bin relocation,2=Ring Mod,3=Pitch->Frequency Shift.
 * quality 0=1024,1=2048,2=4096; hop_div 4 or 8.
 * F, n/m are host-side parameter math only; shiftHz is passed explicitly.
 */
#[no_mangle]
pub extern "C" fn warp_stream_create_ext(
    rate:f64,channels:u32,low:f64,high:f64,p:f64,amount:f64,mode:u32,
    quality_id:u32,outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,
    carrier_hz:f64,zero_mode:u32,hop_div:u32
)->*mut Stream{
    match Stream::new_extended(rate,channels as usize,params(low,high,p,amount,mode,quality_id),
        outside,engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div){
        Ok(st)=>Box::into_raw(Box::new(st)),Err(_)=>std::ptr::null_mut()
    }
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_ext(
    ptr:*mut Stream,low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,zero_mode:u32
)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).configure_extended(params(low,high,p,amount,mode,quality_id),outside,
        engine,pitch_ratio,shift_hz,carrier_hz,zero_mode){Ok(_)=>0,Err(_)=>-2}
}

/// Render a whole file through the *identical* persistent DSP stream used
/// by the Web AudioWorklet and future native host: optional WAV export adapter.
/// Input and output are non-overlapping planar contiguous f32 buffers.
/// Offline allocations are permitted here, but NOT in the realtime process.
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,
)->i32{
    if input.is_null()||output.is_null()||frames==0||!(1..=2).contains(&channels)
       ||(frames as usize).saturating_mul(channels as usize)>40_000_000{return -1;}
    let settings=params(low,high,p,amount,mode,quality_id);
    let mut st=match Stream::new_extended(rate,channels as usize,settings,outside,
        engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div) {
        Ok(st)=>st,Err(_)=>return -2
    };
    let total=frames as usize;
    let channel_count=channels as usize;
    let source=std::slice::from_raw_parts(input,total*channel_count);
    let dest=std::slice::from_raw_parts_mut(output,total*channel_count);
    let latency=st.latency();
    let chunk=128;
    let mut work_in=vec![0.0f32;chunk*channel_count];
    let mut work_out=vec![0.0f32;chunk*channel_count];
    // The stream's latency is compensated for exported WAV: the first
    // latency samples are dropped; zero input flushes remaining output.
    let mut t=0usize;
    while t<total+latency{
        let length=(total+latency-t).min(chunk);
        work_in.fill(0.0);
        work_out.fill(0.0);
        for c in 0..channel_count{
            for j in 0..length{
                let index=t+j;
                if index<total {work_in[c*length+j]=source[c*total+index];}
            }
        }
        if st.process(&work_in[..length*channel_count],
            &mut work_out[..length*channel_count],length).is_err(){return -3;}
        for c in 0..channel_count{
            for j in 0..length{
                let render=t+j;
                if render>=latency&&render-latency<total {
                    dest[c*total+render-latency]=work_out[c*length+j];
                }
            }
        }
        t+=length;
    }
    0
}

#[cfg(test)]
mod tests{
    use super::*;
    fn settings()->Settings{
        Settings{low:20.0,high:3000.0,curvature:1.0,invert:1.0,
            mode:Progression::FoldHigh,quality:0}
    }
    #[test]
    fn continuous_blocks_shift_tone_with_bounded_latency(){
        let fs=8192.0;
        let mut st=Stream::new(fs,1,settings(),0).unwrap();
        let mut rendered=Vec::new();
        for block in 0..65{
            let input:(Vec<f32>)=(0..128).map(|j|{
                let i=block*128+j;
                (0.6*(TAU*500.0*i as f64/fs).cos()) as f32
            }).collect();
            let mut output=vec![0.0;128];
            st.process(&input,&mut output,128).unwrap();
            rendered.extend(output);
        }
        assert!(rendered.iter().all(|x|x.is_finite()));
        assert_eq!(st.latency(),1023);
        let offset=2048;
        let portion=&rendered[offset..offset+4096];
        // Compare direct projection at expected and source frequencies.
        let magnitude=|hz:f64|{
            let mut re=0.0;let mut im=0.0;
            for (i,&x) in portion.iter().enumerate(){
                let angle=TAU*hz*i as f64/fs;
                re+=x as f64*angle.cos();im-=x as f64*angle.sin();
            }
            (re*re+im*im).sqrt()
        };
        let warped=magnitude(2520.0);
        let original=magnitude(500.0);
        assert!(warped>original*4.0,"peak shift missing: warped={warped}, original={original}");
        assert!(warped>150.0,"unexpectedly low shifted energy {warped}");
    }
    #[test]
    fn ring_is_samplewise_true_modulation_and_has_zero_fft_latency(){
        let mut st=Stream::new_extended(8192.0,1,settings(),1,2,1.0,0.0,300.0,0,4).unwrap();
        let inp:Vec<f32>=(0..128).map(|i|(TAU*500.0*i as f64/8192.0).cos() as f32).collect();
        let mut out=vec![0.0;128];
        st.process(&inp,&mut out,128).unwrap();
        assert_eq!(st.latency(),0);
        assert!((out[0]-1.0).abs()<1e-5);
        assert!((out[1]-(TAU*500.0/8192.0).cos() as f32*(TAU*300.0/8192.0).cos() as f32).abs()<1e-5);
        st.configure_extended(settings(),1,2,1.0,0.0,600.0,0).unwrap();
    }
    #[test]
    fn linked_ring_carrier_uses_core_fold_point_and_tracks_live_settings(){
        let mut st=Stream::new_extended(8192.0,1,
            Settings{low:100.0,high:1000.0,curvature:1.0,invert:0.25,
                mode:Progression::FoldHigh,quality:0},
            1,2,1.0,0.0,-1.0,0,4).unwrap();
        let source=vec![1.0;128];let mut dst=vec![0.0;128];
        st.process(&source,&mut dst,128).unwrap();
        assert!((dst[1]-(TAU*775.0/8192.0).cos() as f32).abs()<1e-4);
        let changed=Settings{low:100.0,high:1000.0,curvature:1.0,invert:0.25,
            mode:Progression::FoldLow,quality:0};
        st.configure_extended(changed,1,2,1.0,0.0,-1.0,0).unwrap();
        assert_eq!(st.carrier_hz,-1.0);
        st.reset();st.process(&source,&mut dst,128).unwrap();
        assert!((dst[1]-(TAU*325.0/8192.0).cos() as f32).abs()<1e-4);
    }
    #[test]
    fn alternate_spectral_and_harmonic_engines_stream(){
        for engine in [1u32,3u32]{
            let mut st=Stream::new_extended(8192.0,1,settings(),1,engine,1.0,-75.0,300.0,0,8).unwrap();
            let mut out=vec![0.0;128];
            for block in 0..65{
                let input=(0..128).map(|j|(0.5*(TAU*500.0*(block*128+j) as f64/8192.0).cos()) as f32).collect::<Vec<_>>();
                st.process(&input,&mut out,128).unwrap();
                assert!(out.iter().all(|x|x.is_finite()));
            }
        }
    }
    #[test]
    fn offline_export_and_live_stream_share_same_ring_dsp_and_no_extra_silence(){
        let rate=8192.0;let frames=4096usize;
        let input=(0..frames).map(|i|(TAU*400.0*i as f64/rate).cos() as f32).collect::<Vec<_>>();
        let mut output=vec![0.0f32;frames];
        let status=unsafe{warp_stream_render_f32_ext(input.as_ptr(),output.as_mut_ptr(),
            frames as u32,1,rate,20.0,3000.0,1.0,1.0,0,0,1,
            2,1.0,0.0,0.0,0,4)};
        assert_eq!(status,0);
        assert!(output.iter().zip(&input).map(|(a,b)|(a-b).abs()).sum::<f32>()/(frames as f32)<1e-5);
    }
    #[test]
    fn stream_parameter_changes_and_reset(){
        let mut st=Stream::new(48000.0,2,settings(),1).unwrap();
        let inp=vec![0.2;256];let mut out=vec![0.0;256];
        st.process(&inp,&mut out,128).unwrap();
        st.configure(Settings{invert:0.4,mode:Progression::FoldLow,..settings()},0).unwrap();
        st.process(&inp,&mut out,128).unwrap();
        st.reset();
        assert_eq!(st.received,0);
        assert!(st.tracks.is_empty());
    }
}
