//! AudioWorklet/VST-ready *streaming* prototype on the same Rust DSP
//! definitions. No whole-track render; 128-frame calls have persistent state.
//! This retains experimental R2.1 peak-tracking limitations and N-1 latency.

use super::reflection;
use super::{fft,fold_frequency,map_frequency,translate_frequency_affine,translate_frequency_controls,translate_frequency_anchored,quality,Complex,Progression,Settings,Track,PI,TAU};

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
    ring_enabled:bool,
    axis_shift:f64,
    axis_reference:f64,
    axis_pivot:f64,
    axis_slope:f64,
    rational_enabled:bool,
    crusher_bits:u32,
    crusher_hold:u32,
    crusher_counter:u64,
    crusher_value:Vec<f32>,
    a_min_hz:f64,
    a_peak_band_bins:usize,
    a_quality_percent:u32,
    a_reverb_amount:f32,
    a_reverb_delays:Vec<Vec<Vec<f32>>>,
    a_reverb_pos:[usize;3],
    zero_mode:u32, // legacy: 0=reflect,1=kill,2=near-zero fade; 3=variable reflection
    zero_reflect_gain:f64, // 0..1 uniform synthesis amount for negative-target reflections
    zero_reflect_decay:f64, // 0..1 distance-dependent attenuation; normalized at axis_reference Hz
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
    synthesized_peak_mask:Vec<bool>,
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
            ring_enabled:engine==2,axis_shift:0.0,
            axis_reference:350.0,axis_pivot:350.0,axis_slope:1.0,rational_enabled:engine==3,crusher_bits:0,crusher_hold:1,crusher_counter:0,
            crusher_value:vec![0.0;channels],
            a_min_hz:20.0,a_peak_band_bins:1,a_quality_percent:0,a_reverb_amount:0.0,
            a_reverb_delays:(0..channels).map(|_|[0.029,0.041,0.061].iter()
                .map(|sec|vec![0.0;(sample_rate*sec).round().max(1.0) as usize])
                .collect()).collect(),
            a_reverb_pos:[0;3],zero_mode,zero_reflect_gain:1.0,zero_reflect_decay:0.0,received:0,
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
            peaks:Vec::with_capacity(q.max_peaks*4),
            tracks:Vec::with_capacity(q.max_peaks*4),
            next_tracks:Vec::with_capacity(q.max_peaks*4),
            used:vec![false;q.max_peaks*4],
            complement:vec![Complex::ZERO;q.n],
            relocated:vec![Complex::ZERO;q.n],
            synthesized_peak_mask:vec![false;q.n/2+1],
        })
    }
    pub fn latency(&self)->usize{self.n-1} // all engines now use the shared warp stage
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
    pub fn set_transform(&mut self,shift:f64,reference:f64,ring_enabled:u32,
        rational_enabled:u32)->Result<(),&'static str>{
        if !shift.is_finite()||shift.abs()>4.0||!reference.is_finite()
           ||!(1.0..=20000.0).contains(&reference)||ring_enabled>1||rational_enabled>1{
            return Err("invalid axis shift / effect parameters");
        }
        self.axis_shift=shift;
        self.axis_reference=reference;
        self.ring_enabled=ring_enabled!=0;
        self.rational_enabled=rational_enabled!=0;
        Ok(())
    }
    pub fn set_geometry(&mut self,pivot:f64,slope:f64)->Result<(),&'static str>{
        if !pivot.is_finite()||!(0.0..=20000.0).contains(&pivot)||
           !slope.is_finite()||!(0.1..=4.0).contains(&slope) {
            return Err("invalid frequency pivot/slope");
        }
        self.axis_pivot=pivot;self.axis_slope=slope;Ok(())
    }
    pub fn set_a_options(&mut self,min_hz:f64,reverb:f64)->Result<(),&'static str>{
        if !min_hz.is_finite()||!(20.0..=20000.0).contains(&min_hz)
           || !reverb.is_finite()||!(0.0..=1.0).contains(&reverb){
            return Err("invalid A options");
        }
        self.a_min_hz=min_hz;
        if reverb==0.0 && self.a_reverb_amount>0.0{
            for channel in &mut self.a_reverb_delays{
                for delay in channel{delay.fill(0.0);}
            }
            self.a_reverb_pos=[0;3];
        }
        self.a_reverb_amount=reverb as f32;Ok(())
    }
    /// Minimum frequency-bin spacing of separately tracked peaks in engine A.
    /// 1 retains the original local-maximum selector. Wider neighborhoods
    /// reject nearby spurious peaks but may also suppress close partials.
    pub fn set_a_peak_band(&mut self,bins:u32)->Result<(),&'static str>{
        if !(1..=8).contains(&bins){return Err("invalid A peak band");}
        self.a_peak_band_bins=bins as usize;
        Ok(())
    }
    /// Engine A fine-grained fidelity-vs-CPU experiment, independently of
    /// the peak-neighbourhood width. The maximum working vector capacities
    /// are reserved at construction (not the audio callback). The selection
    /// budget and relative threshold change while playback continues.
    /// This does not promise full-band residual or transparent output.
    pub fn set_a_quality(&mut self,percent:u32)->Result<(),&'static str>{
        if percent>100{return Err("invalid A quality");}
        let base=quality(self.settings.quality).ok_or("invalid quality profile")?;
        self.a_quality_percent=percent;
        self.max_peaks=base.max_peaks+(base.max_peaks*3*percent as usize/100);
        self.floor=base.floor*(1.0-0.9*(percent as f64/100.0));
        Ok(())
    }
    /// Negative-target reflection amplitude in [0,1]. 0 eliminates the
    /// crossed-zero component, 1 reflects at original magnitude. Intermediate
    /// values attenuate only the reflected component. The legacy 0/1/2
    /// zero-mode behavior is untouched until this setter is called.
    pub fn set_zero_reflect_gain(&mut self,gain:f64)->Result<(),&'static str>{
        if !gain.is_finite()||!(0.0..=1.0).contains(&gain){
            return Err("invalid negative-target reflection gain");
        }
        self.zero_reflect_gain=gain;
        self.zero_mode=3;
        Ok(())
    }
    /// Frequency-dependent reflection falloff, independent of synthesis gain.
    /// At D=0 there is no falloff; at D=.5 the reflected amplitude
    /// halves for each axisReference-Hz of distance below zero. At D=1
    /// all strictly negative targets are removed, no audio-thread alloc.
    pub fn set_zero_reflect_decay(&mut self,decay:f64)->Result<(),&'static str>{
        if !decay.is_finite()||!(0.0..=1.0).contains(&decay){
            return Err("invalid reflected frequency falloff");
        }
        self.zero_reflect_decay=decay;
        self.zero_mode=3;
        Ok(())
    }
    pub fn set_crusher(&mut self,bits:u32,hold:u32)->Result<(),&'static str>{
        // hold=0 represents an actual 0 Hz update rate: quantise/hold
        // only the first sample after reset; no divide-by-zero.
        // A finite hold is an integer sample interval, not an
        // arbitrary-integer or non-realizable float sampling rate.
        if (bits!=0 && !(2..=16).contains(&bits)) || hold>1_000_000_000 {
            return Err("invalid bit-crusher settings");
        }
        self.crusher_bits=bits;self.crusher_hold=hold;Ok(())
    }
    fn post_process(&mut self,output:&mut[f32],frames:usize){
        // All engines share source L/H, Invert and Curvature mapping first.
        // Ring mode post-multiplies the *warped* signal and yields both
        // sum/difference sidebands; pitch+Hz creates one translated series.
        let levels=(1u32<<self.crusher_bits.saturating_sub(1)) as f32;
        let feedback=[0.48f32,0.55,0.61];
        for i in 0..frames{
             for c in 0..self.channels{
                let idx=c*frames+i;
                let mut sample=output[idx];
                if self.engine==0 && self.a_reverb_amount>0.0{
                    let mut tail=0.0;
                    for j in 0..3{
                        let pos=self.a_reverb_pos[j];
                        let delay=&mut self.a_reverb_delays[c][j];
                        let prev=delay[pos];
                        delay[pos]=sample+prev*feedback[j];
                        tail+=prev;
                    }
                    sample=sample*(1.0-self.a_reverb_amount)
                        +tail/3.0*self.a_reverb_amount;
                }
                 output[idx]=if self.crusher_bits==0{sample}else{
                    if (self.crusher_hold==0 && self.crusher_counter==0) ||
                        (self.crusher_hold>0 &&
                         self.crusher_counter%(self.crusher_hold as u64)==0) {
                        self.crusher_value[c]=
                            (sample.clamp(-1.0,1.0)*levels).round()/levels;
                    }
                    self.crusher_value[c]
                };
            }
            self.crusher_counter+=1;
            if self.engine==0 && self.a_reverb_amount>0.0{
                for j in 0..3{
                    self.a_reverb_pos[j]=(self.a_reverb_pos[j]+1)%
                        self.a_reverb_delays[0][j].len();
                }
            }
        }
    }
    pub fn reset(&mut self){
        self.received=0;
        self.crusher_counter=0;
        self.crusher_value.fill(0.0);self.a_reverb_pos=[0;3];
        for channel in &mut self.a_reverb_delays{
            for delay in channel{delay.fill(0.0);}
        }
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
        self.post_process(output,frames);
        Ok(())
    }
    // Apply Ring Mod to ONLY mapped [L,H] components before mixing the
    // separately reconstructed out-of-band Pass signal. Each overlapping
    // analysis window uses the same absolute source-frame phase.
    fn ring_at(&self,frame:usize)->f64{
        if !self.ring_enabled{return 1.0;}
        let carrier=if self.carrier_hz==-1.0{
            fold_frequency(self.settings).unwrap_or(0.0)
        }else{self.carrier_hz};
        (TAU*((frame as f64*carrier/self.sample_rate).rem_euclid(1.0))).cos()
    }
    fn process_frame(&mut self,start:usize){
        let half=self.n/2;
        let step=self.sample_rate/self.n as f64;
        let source_anchor=self.source_pivot_anchor();
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
                    if f<self.settings.low||f>self.settings.high{continue;}
                    // The same off-bin sinusoid appears in several Hann FFT
                    // bins. Mapping each of those bins independently can
                    // collapse k,k+1 into one destination and their differing
                    // phase rotations then beat at the FFT-bin spacing:
                    // an artificial tremolo under non-unit warp slopes.
                    //
                    // Locally phase-lock the ±2-bin peak neighbourhood by
                    // giving its lobes the SAME integer-bin DISPLACEMENT,
                    // instead of assigning each lobe an independent target.
                    // Stereo peak strength is shared across channels, and no
                    // audio-thread heap buffer or unrelated processing path
                    // is introduced.
                    let mut anchor=k;
                    let first=k.saturating_sub(2).max(1);
                    let last=(k+2).min(half-1);
                    for neighbor in first..=last{
                        let near_f=neighbor as f64*step;
                        if near_f<self.settings.low||near_f>self.settings.high{continue;}
                        if self.mag[neighbor]>self.mag[anchor]{
                            anchor=neighbor;
                        }
                    }
                    if anchor!=k && self.mag[anchor]<self.mag[k]*1.1{
                        anchor=k;
                    }
                    let anchor_f=anchor as f64*step;
                    let target=if anchor_f>=self.settings.low&&anchor_f<=self.settings.high {
                        let base=map_frequency(anchor_f,self.settings).unwrap_or(anchor_f);
                        let old=if self.rational_enabled {
                            self.pitch_ratio*base+self.shift_hz
                        }else{base};
                        if old<=0.0 {old}else{
                            translate_frequency_anchored(old,source_anchor,
                                self.axis_pivot,self.axis_slope,
                                self.axis_reference,self.settings.curvature,self.axis_shift)
                        }
                    }else{continue}; // Outside Pass is mixed AFTER in-band Ring Mod.
                    // Exact same signed/DC policy used by the peak-resynthesis
                    // engine. Previously FFT-bin mode *always killed* negative
                    // targets (and clamped pre-shift negatives to 1e-7).
                    let (target,_gain)=match self.resolve_zero(target,step){
                        Some(v)=>v,None=>continue
                    };
                    if target>=self.sample_rate*0.5 {continue;}
                    // Preserve the source-window lobe's local spectral
                    // offset around its dominant peak. The peak's mapped
                    // bin is the anchor; every nearby lobe shares a constant
                    // integer shift, including phase rotation.
                    let target_anchor=((target/step).round() as isize).max(1);
                    let delta=target_anchor-anchor as isize;
                    let destination=k as isize+delta;
                    if destination<=0||destination>=half as isize{continue;}
                    let dest=destination as usize;
                    // FFT coefficients use local window time. A frequency
                    // shift by dest-k bins requires compensating its phase
                    // advance at the ABSOLUTE start of each analysis window.
                    // Otherwise overlapping frames cancel, especially at
                    // hop N/8 where a 3-bin shift can almost vanish.
                    // This fixes *integer-bin temporal coherence* only:
                    // noninteger quantization, merged-bin cancellation,
                    // transient smearing and formants remain open research.
                    let phase=TAU*(dest as f64-k as f64)
                        *(start%self.n) as f64/self.n as f64;
                    let (sin,cos)=phase.sin_cos();
                    let source=self.spectrum[c][k];
                    self.relocated[dest].r+=(source.r*cos-source.i*sin)*_gain;
                    self.relocated[dest].i+=(source.r*sin+source.i*cos)*_gain;
                }
                fft(&mut self.relocated,true);
                for i in 0..self.n {
                    let slot=(start+i)%(self.n*2);
                    let ring=self.ring_at(start+i);
                    self.output[c][slot]+=2.0*self.relocated[i].r*
                        self.window_sq[i].sqrt()*ring;
                }
                // Add untouched spectral complement only after Ring Mod,
                // matching engine A and the independent L/H Pass policy.
                if self.outside==1{
                    self.complement.fill(Complex::ZERO);
                    for k in 0..=half{
                        let freq=k as f64*step;
                        if freq<self.settings.low||freq>self.settings.high{
                            self.complement[k]=self.spectrum[c][k];
                            if k>0&&k<half{
                                self.complement[self.n-k]=self.spectrum[c][self.n-k];
                            }
                        }
                    }
                    fft(&mut self.complement,true);
                    for i in 0..self.n{
                        let slot=(start+i)%(self.n*2);
                        self.output[c][slot]+=self.complement[i].r*self.window_sq[i].sqrt();
                    }
                }
            }
            for i in 0..self.n {let slot=(start+i)%(self.n*2);self.weights[slot]+=self.window_sq[i];}
            std::mem::swap(&mut self.previous,&mut self.spectrum);
            return;
        }
        let threshold=(greatest*self.floor).max(1e-10);
        self.candidates.clear();
        for k in 2..half-1{
            if k<self.a_peak_band_bins || k+self.a_peak_band_bins>=half {continue;}
            // One stronger local maximum inside each adjustable FFT-bin band.
            // No FFT extra allocation or copy on the audio render thread.
            if self.mag[k]>=threshold && (1..=self.a_peak_band_bins).all(|d|
                self.mag[k]>=self.mag[k-d] && self.mag[k]>self.mag[k+d]) {
                self.candidates.push(k);
            }
        }
        self.candidates.sort_unstable_by(|a,b|self.mag[*b].total_cmp(&self.mag[*a]));
        self.peaks.clear();
        for &k in self.candidates.iter().take(self.max_peaks){self.peaks.push(k);}
        self.peaks.sort_unstable();
        self.synthesized_peak_mask.fill(false);
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
            if !frequency.is_finite() ||frequency<self.settings.low.max(self.a_min_hz)||frequency>self.settings.high{continue;}
            // Transform semantics are orthogonal to the resynthesis engine:
            // g(f) -> optional Issue #24 rational lattice -> axis-translation.
            let mapped=match map_frequency(frequency,self.settings){Ok(f)=>f,Err(_)=>continue};
            let staged=if self.rational_enabled {
                self.pitch_ratio*mapped+self.shift_hz
            }else{mapped};
            let target=if staged<=0.0 {staged}else {
                translate_frequency_anchored(staged,source_anchor,
                    self.axis_pivot,self.axis_slope,
                    self.axis_reference,self.settings.curvature,self.axis_shift)
            };
            let (target,fade_gain)=match self.resolve_zero(target,step){
                Some(v)=>v,None=>continue
            };
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
            // Hann analysis spreads a locally sinusoidal partial into
            // neighbouring bins. Exclude those bins from the residual to
            // avoid double-counting the tracked oscillator and its lobes.
            for skip in k.saturating_sub(1)..=(k+1).min(half){
                self.synthesized_peak_mask[skip]=true;
            }

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
                    let ring=self.ring_at(start+i);
                    self.output[c][slot]+=amplitude*cr*self.window_sq[i]*ring;
                    let new_r=cr*rot_r-ci*rot_i;
                    ci=cr*rot_i+ci*rot_r;cr=new_r;
                }
            }
        }
        // Experimental PARTIAL + RESIDUAL path. Reconstruct *only* in-band
        // bins not assigned to a synthesized peak, using the SAME frequency
        // mapping and absolute-frame phase correction as engine B. The
        // residual is NOT simply unprocessed Dry: translated/warped bins
        // follow the same target curve, avoiding a parallel old-frequency
        // ghost. This is a bounded experiment, not an accepted R2.2 engine:
        // the peak mask remains approximate and transients/formants are
        // not specially modelled.
        if self.a_quality_percent>0 {
            let residual_gain=self.a_quality_percent as f64/100.0;
            for c in 0..self.channels {
                self.relocated.fill(Complex::ZERO);
                for k in 1..half {
                    if self.synthesized_peak_mask[k]{continue;}
                    let f=k as f64*step;
                    if f<self.settings.low.max(self.a_min_hz)||f>self.settings.high{continue;}
                    let base=match map_frequency(f,self.settings){
                        Ok(value)=>value,Err(_)=>continue
                    };
                    let staged=if self.rational_enabled{
                        self.pitch_ratio*base+self.shift_hz
                    }else{base};
                    let target=if staged<=0.0{staged}else{
                        translate_frequency_anchored(staged,source_anchor,
                            self.axis_pivot,self.axis_slope,self.axis_reference,
                            self.settings.curvature,self.axis_shift)
                    };
                    let (target,fade_gain)=match self.resolve_zero(target,step){
                        Some(v)=>v,None=>continue
                    };
                    if target>=self.sample_rate/2.0{continue;}
                    let dest=((target/step).round() as usize).max(1);
                    if dest>=half{continue;}
                    let phase=TAU*(dest as f64-k as f64)
                        *(start%self.n) as f64/self.n as f64;
                    let (sin,cos)=phase.sin_cos();
                    let z=self.spectrum[c][k];
                    let gain=fade_gain*residual_gain;
                    self.relocated[dest].r+=(z.r*cos-z.i*sin)*gain;
                    self.relocated[dest].i+=(z.r*sin+z.i*cos)*gain;
                }
                fft(&mut self.relocated,true);
                for i in 0..self.n{
                    let slot=(start+i)%(self.n*2);
                    let ring=self.ring_at(start+i);
                    self.output[c][slot]+=2.0*self.relocated[i].r*
                        self.window_sq[i].sqrt()*ring;
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
    fn source_pivot_anchor(&self)->f64{
        let pivot=self.axis_pivot;
        let base=if pivot>=self.settings.low && pivot<=self.settings.high{
            map_frequency(pivot,self.settings).unwrap_or(pivot)
        }else{pivot};
        // Fix the pivot through the nonlinear warp, not through optional
        // rational pitch/Hz placement. Those shifts must remain audible.
        base
    }
    fn resolve_zero(&self,target:f64,step:f64)->Option<(f64,f64)>{
        if !target.is_finite(){return None;}
        let (frequency,gain)=if target<0.0 {
            match self.zero_mode {
                0=>(-target,1.0), // Reflect
                1=>return None, // Kill
                3=>{
                    let gain=zero_reflection_amplitude(-target,self.zero_reflect_gain,
                        self.zero_reflect_decay,self.axis_reference);
                    if gain<=0.0{return None;}
                    (-target,gain)
                },
                _=>{
                    let negative=-target;
                    if negative>=step{return None;}
                    (negative,(1.0-negative/step).clamp(0.0,1.0))
                }
            }
        }else{(target,1.0)};
        if frequency<=0.0||frequency>=self.sample_rate*0.5 {None}
        else{Some((frequency,gain))}
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
    match mode{1=>Progression::Blend,2=>Progression::FoldLow,3=>Progression::Reciprocal,_=>Progression::FoldHigh}
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

// The same amplitude law is used by native synthesis and exported to the
// browser mapping graph; visual opacity is not an independently guessed law.
fn zero_reflection_amplitude(distance:f64,synthesis:f64,decay:f64,reference:f64)->f64{
    if !distance.is_finite()||distance<0.0 || !synthesis.is_finite() ||
       !(0.0..=1.0).contains(&synthesis) || !decay.is_finite() ||
       !(0.0..=1.0).contains(&decay) || !reference.is_finite() ||
       reference<=0.0 {return f64::NAN;}
    if synthesis==0.0 {return 0.0;}
    if decay==1.0 {return if distance==0.0{synthesis}else{0.0};}
    synthesis*(1.0-decay).powf(distance/reference)
}
#[no_mangle]
pub extern "C" fn warp_zero_reflection_amplitude(distance:f64,synthesis:f64,decay:f64,reference:f64)->f64{
    zero_reflection_amplitude(distance,synthesis,decay,reference)
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_zero_reflect_decay(ptr:*mut Stream,decay:f64)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_zero_reflect_decay(decay){Ok(())=>0,Err(_)=>-2}
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_zero_reflect_gain(ptr:*mut Stream,gain:f64)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_zero_reflect_gain(gain){Ok(())=>0,Err(_)=>-2}
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_crusher(ptr:*mut Stream,bits:u32,hold:u32)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_crusher(bits,hold){Ok(())=>0,Err(_)=>-2}
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_transform(ptr:*mut Stream,shift:f64,
    reference:f64,ring:u32,rational:u32)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_transform(shift,reference,ring,rational){
        Ok(())=>0,Err(_)=>-2
    }
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_a_options(ptr:*mut Stream,min_hz:f64,reverb:f64)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_a_options(min_hz,reverb){Ok(())=>0,Err(_)=>-2}
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_a_band(ptr:*mut Stream,bins:u32)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_a_peak_band(bins){Ok(())=>0,Err(_)=>-2}
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_a_quality(ptr:*mut Stream,percent:u32)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_a_quality(percent){Ok(())=>0,Err(_)=>-2}
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_set_geometry(ptr:*mut Stream,pivot:f64,slope:f64)->i32{
    if ptr.is_null(){return -1;}
    match (&mut *ptr).set_geometry(pivot,slope){Ok(())=>0,Err(_)=>-2}
}

/// Render a whole file through the *identical* persistent DSP stream used
/// by the Web AudioWorklet and future native host: optional WAV export adapter.
/// Input and output are non-overlapping planar contiguous f32 buffers.
/// Offline allocations are permitted here, but NOT in the realtime process.
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_a_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
    a_min_hz:f64,a_reverb:f64,
)->i32{
    warp_stream_render_f32_a_band_ext(input,output,frames,channels,rate,
        low,high,p,amount,mode,quality_id,outside,engine,pitch_ratio,shift_hz,
        carrier_hz,zero_mode,hop_div,crusher_bits,crusher_hold,axis_shift,
        axis_reference,ring,rational,axis_pivot,axis_slope,a_min_hz,a_reverb,1)
}
/// Extended offline render using the same adjustable A-peak selection as live.
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_a_band_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
    a_min_hz:f64,a_reverb:f64,a_peak_band_bins:u32,
)->i32{
    warp_stream_render_f32_a_quality_ext(input,output,frames,channels,rate,
        low,high,p,amount,mode,quality_id,outside,engine,pitch_ratio,shift_hz,
        carrier_hz,zero_mode,hop_div,crusher_bits,crusher_hold,axis_shift,
        axis_reference,ring,rational,axis_pivot,axis_slope,
        a_min_hz,a_reverb,a_peak_band_bins,0)
}
/// Adjustable engine-A fidelity budget for the SAME native/WASM offline stream.
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_a_quality_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
    a_min_hz:f64,a_reverb:f64,a_peak_band_bins:u32,a_quality_percent:u32,
)->i32{
    render_zero_gain_internal(input,output,frames,channels,rate,low,high,p,amount,mode,quality_id,
        outside,engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div,
        crusher_bits,crusher_hold,axis_shift,axis_reference,ring,rational,
        axis_pivot,axis_slope,a_min_hz,a_reverb,a_peak_band_bins,a_quality_percent,None,None)
}

/// Unified native/WASM offline export with controllable negative-target
/// reflection. Legacy callers stay on the prior ABI and zero policy.
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_zero_gain_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
    a_min_hz:f64,a_reverb:f64,a_peak_band_bins:u32,a_quality_percent:u32,zero_reflect_gain:f64,
)->i32{
    if !zero_reflect_gain.is_finite() || !(0.0..=1.0).contains(&zero_reflect_gain){return -2;}
    render_zero_gain_internal(input,output,frames,channels,rate,low,high,p,amount,mode,quality_id,
        outside,engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div,
        crusher_bits,crusher_hold,axis_shift,axis_reference,ring,rational,
        axis_pivot,axis_slope,a_min_hz,a_reverb,a_peak_band_bins,a_quality_percent,Some(zero_reflect_gain),None)
}

/// Reflection synthesis amount and frequency-distance decay for WAV export.
/// Existing ABI remains callable through zero_gain_ext and legacy quality_ext.
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_zero_controls_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
    a_min_hz:f64,a_reverb:f64,a_peak_band_bins:u32,a_quality_percent:u32,zero_reflect_gain:f64,zero_reflect_decay:f64,
)->i32{
    if !zero_reflect_gain.is_finite()||!(0.0..=1.0).contains(&zero_reflect_gain)||
       !zero_reflect_decay.is_finite()||!(0.0..=1.0).contains(&zero_reflect_decay){return -2;}
    render_zero_gain_internal(input,output,frames,channels,rate,low,high,p,amount,mode,quality_id,
        outside,engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div,
        crusher_bits,crusher_hold,axis_shift,axis_reference,ring,rational,
        axis_pivot,axis_slope,a_min_hz,a_reverb,a_peak_band_bins,a_quality_percent,
        Some(zero_reflect_gain),Some(zero_reflect_decay))
}

unsafe fn render_zero_gain_internal(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
    a_min_hz:f64,a_reverb:f64,a_peak_band_bins:u32,a_quality_percent:u32,zero_reflect_gain:Option<f64>,zero_reflect_decay:Option<f64>,
)->i32{
    if input.is_null()||output.is_null()||frames==0||!(1..=2).contains(&channels)
       ||(frames as usize).saturating_mul(channels as usize)>40_000_000{return -1;}
    let settings=params(low,high,p,amount,mode,quality_id);
    let mut st=match Stream::new_extended(rate,channels as usize,settings,outside,
        engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div) {
        Ok(st)=>st,Err(_)=>return -2
    };
    if st.set_crusher(crusher_bits,crusher_hold).is_err()||
       st.set_transform(axis_shift,axis_reference,ring,rational).is_err()||
       st.set_geometry(axis_pivot,axis_slope).is_err()||
       st.set_a_options(a_min_hz,a_reverb).is_err()||
       st.set_a_peak_band(a_peak_band_bins).is_err()||
       st.set_a_quality(a_quality_percent).is_err()||
       // Internal optional gain: no gain keeps the exact legacy 0/1/2
       // policy; Some(0..1) activates variable-amplitude reflection.
       zero_reflect_gain.is_some_and(|gain|
           st.set_zero_reflect_gain(gain).is_err())||
       zero_reflect_decay.is_some_and(|decay|
           st.set_zero_reflect_decay(decay).is_err()){return -2;}
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

#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_geometry_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,axis_pivot:f64,axis_slope:f64,
)->i32{
    warp_stream_render_f32_a_ext(input,output,frames,channels,rate,
        low,high,p,amount,mode,quality_id,outside,engine,pitch_ratio,
        shift_hz,carrier_hz,zero_mode,hop_div,crusher_bits,crusher_hold,
        axis_shift,axis_reference,ring,rational,axis_pivot,axis_slope,20.0,0.0)
}
#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_axis_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
    axis_shift:f64,axis_reference:f64,ring:u32,rational:u32,
)->i32{
    warp_stream_render_f32_geometry_ext(input,output,frames,channels,rate,
        low,high,p,amount,mode,quality_id,outside,engine,pitch_ratio,
        shift_hz,carrier_hz,zero_mode,hop_div,crusher_bits,crusher_hold,
        axis_shift,axis_reference,ring,rational,axis_reference,1.0)
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_fx_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,crusher_bits:u32,crusher_hold:u32,
)->i32{
    warp_stream_render_f32_axis_ext(input,output,frames,channels,rate,
       low,high,p,amount,mode,quality_id,outside,engine,pitch_ratio,
       shift_hz,carrier_hz,zero_mode,hop_div,crusher_bits,crusher_hold,
       0.0,350.0,if engine==2 {1}else{0},if engine==3 {1}else{0})
}

#[no_mangle]
pub unsafe extern "C" fn warp_stream_render_f32_ext(
    input:*const f32,output:*mut f32,frames:u32,channels:u32,rate:f64,
    low:f64,high:f64,p:f64,amount:f64,mode:u32,quality_id:u32,
    outside:u32,engine:u32,pitch_ratio:f64,shift_hz:f64,carrier_hz:f64,
    zero_mode:u32,hop_div:u32,
)->i32{
    warp_stream_render_f32_fx_ext(input,output,frames,channels,rate,low,high,p,amount,
        mode,quality_id,outside,engine,pitch_ratio,shift_hz,carrier_hz,zero_mode,hop_div,0,1)
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
        // Full inversion is now anchored around the chosen P=350Hz:
        // g(500)=2520, g(P)=2670, P+(g(500)-g(P))=200Hz.
        // The previous test's 2520Hz expected the old unanchored map.
        let warped=magnitude(200.0);
        let original=magnitude(500.0);
        assert!(warped>original*4.0,"peak shift missing: warped={warped}, original={original}");
        assert!(warped>150.0,"unexpectedly low shifted energy {warped}");
    }
    #[test]
    fn ring_postmodulation_has_stft_latency_and_warp_is_active(){
        let mut st=Stream::new_extended(8192.0,1,settings(),1,2,1.0,0.0,300.0,0,4).unwrap();
        let mut out=vec![0.0;128];
        for block in 0..45{
            let inp=(0..128).map(|i|(TAU*500.0*(block*128+i) as f64/8192.0).cos() as f32).collect::<Vec<_>>();
            st.process(&inp,&mut out,128).unwrap();
        }
        assert_eq!(st.latency(),1023);
        assert!(out.iter().any(|x|x.abs()>0.001));
        st.configure_extended(settings(),1,2,1.0,0.0,600.0,0).unwrap();
    }
    #[test]
    fn linked_ring_carrier_uses_shared_fold_and_responds_to_settings(){
        let a=Settings{low:100.0,high:1000.0,curvature:1.0,invert:0.25,
            mode:Progression::FoldHigh,quality:0};
        let mut st=Stream::new_extended(8192.0,1,a,1,2,1.0,0.0,-1.0,0,4).unwrap();
        assert!((fold_frequency(st.settings).unwrap()-775.0).abs()<1e-9);
        st.configure_extended(Settings{mode:Progression::FoldLow,..a},1,2,1.0,0.0,-1.0,0).unwrap();
        assert!((fold_frequency(st.settings).unwrap()-325.0).abs()<1e-9);
        assert_eq!(st.carrier_hz,-1.0);
    }
    #[test]
    fn synthesis_and_distance_reflection_are_independently_controlled(){
        let mut st=Stream::new_extended(8192.0,1,settings(),1,1,1.0,0.0,0.0,0,4).unwrap();
        st.set_transform(0.0,350.0,0,0).unwrap();
        st.set_zero_reflect_gain(0.8).unwrap();
        st.set_zero_reflect_decay(0.5).unwrap();
        assert_eq!(st.resolve_zero(-350.0,8.0),Some((350.0,0.4)));
        assert_eq!(st.resolve_zero(-700.0,8.0),Some((700.0,0.2)));
        assert_eq!(st.resolve_zero(400.0,8.0),Some((400.0,1.0)));
        assert!((zero_reflection_amplitude(175.0,0.8,0.5,350.0)-
            0.8*(0.5f64).sqrt()).abs()<1e-12);
        assert_eq!(zero_reflection_amplitude(700.0,0.8,0.0,350.0),0.8);
        assert_eq!(zero_reflection_amplitude(700.0,0.8,1.0,350.0),0.0);
        assert!(st.set_zero_reflect_decay(f64::NAN).is_err());
        assert!(st.set_zero_reflect_decay(-0.1).is_err());
        assert!(st.set_zero_reflect_decay(1.001).is_err());
        assert_eq!(st.zero_reflect_decay,0.5);
        let original=st.resolve_zero(-350.0,8.0);
        assert_eq!(warp_zero_reflection_amplitude(350.0,0.8,0.5,350.0),
            original.unwrap().1);
    }
    #[test]
    fn variable_negative_reflection_is_strictly_bounded_and_legacy_modes_unchanged(){
        let mut st=Stream::new_extended(8192.0,2,settings(),1,1,1.0,0.0,0.0,0,4).unwrap();
        assert_eq!(st.resolve_zero(-320.0,8.0),Some((320.0,1.0)));
        assert!(st.set_zero_reflect_gain(f64::NAN).is_err());
        assert!(st.set_zero_reflect_gain(-0.1).is_err());
        assert!(st.set_zero_reflect_gain(1.01).is_err());
        assert_eq!(st.zero_mode,0,"invalid gain must not change old policy");
        assert!(st.set_zero_reflect_gain(0.0).is_ok());
        assert_eq!(st.resolve_zero(-320.0,8.0),None);
        assert_eq!(st.resolve_zero(250.0,8.0),Some((250.0,1.0)),
            "positive targets must not be attenuated");
        for gain in [0.25,0.5,1.0]{
            st.set_zero_reflect_gain(gain).unwrap();
            assert_eq!(st.resolve_zero(-320.0,8.0),Some((320.0,gain)));
            assert_eq!(st.resolve_zero(250.0,8.0),Some((250.0,1.0)));
        }
        st.configure_extended(settings(),1,1,1.0,0.0,0.0,2).unwrap();
        assert!(st.resolve_zero(-320.0,8.0).is_none(),
            "legacy fade path remains different from the new gain mode");
        st.configure_extended(settings(),1,1,1.0,0.0,0.0,1).unwrap();
        assert_eq!(st.resolve_zero(-320.0,8.0),None);
        let ptr=Box::into_raw(Box::new(st));
        unsafe{
            assert_eq!(warp_stream_set_zero_reflect_gain(ptr,0.6),0);
            assert_eq!((*ptr).resolve_zero(-320.0,8.0),Some((320.0,0.6)));
            assert_eq!(warp_stream_set_zero_reflect_gain(ptr,2.0),-2);
            warp_stream_free(ptr);
        }
    }
    #[test]
    fn crusher_zero_hz_freezes_sample_and_large_intervals_without_division_by_zero(){
        let mut stream=Stream::new(8192.0,2,settings(),1).unwrap();
        assert!(stream.set_crusher(8,0).is_ok());
        let mut out=vec![0.0f32;256];
        for i in 0..128 {
            out[i]=if i==0{0.37}else{(i as f32/100.0).sin()};
            out[128+i]=if i==0{-0.27}else{(i as f32/53.0).cos()};
        }
        stream.post_process(&mut out,128);
        let q0=(0.37f32*128.0).round()/128.0;
        let q1=(-0.27f32*128.0).round()/128.0;
        for i in 0..128{
            assert_eq!(out[i],q0);assert_eq!(out[128+i],q1);
        }
        for v in &mut out {*v=0.8;}
        stream.post_process(&mut out,128);
        assert!(out[..128].iter().all(|x|*x==q0));
        assert!(out[128..].iter().all(|x|*x==q1));
        stream.reset();
        assert!(stream.set_crusher(8,500_000).is_ok());
        assert!(stream.set_crusher(8,1_000_000_001).is_err());
        let mut output=vec![0.21f32;2];
        stream.post_process(&mut output,1);
        assert!(output.iter().all(|x|*x!=0.0));
    }
    #[test]
    fn crusher_live_settings_and_sample_hold_are_effective(){
        let mut st=Stream::new_extended(8192.0,1,settings(),1,0,1.0,0.0,0.0,0,4).unwrap();
        assert!(st.set_crusher(1,1).is_err());
        assert!(st.set_crusher(8,4).is_ok());
        let mut out=vec![0.53,0.11,-0.31,0.99];
        st.post_process(&mut out,4);
        assert!((out[0]-out[1]).abs()<1e-7);
        assert!((out[0]-out[3]).abs()<1e-7);
        st.set_crusher(0,1).unwrap();
        st.reset();assert_eq!(st.crusher_counter,0);
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
        assert!(output.iter().all(|x|x.is_finite()));
        assert!(output.iter().any(|x|x.abs()>0.001));
    }
    #[test]
    fn common_transform_and_ring_are_independent_of_engine_selection(){
        let mut a=Stream::new_extended(8192.0,1,settings(),1,0,1.0,0.0,300.0,0,4).unwrap();
        a.set_transform(0.5,400.0,0,0).unwrap();
        let mapped=map_frequency(500.0,a.settings).unwrap();
        let shifted=translate_frequency_affine(mapped,400.0,1.0,0.5,1.0);
        assert!((shifted-(mapped+200.0)).abs()<1e-7);
        a.set_transform(0.0,400.0,1,0).unwrap();
        assert!(a.ring_enabled);
        a.set_transform(0.0,400.0,0,0).unwrap();
        assert!(!a.ring_enabled);
        assert!(a.set_transform(0.0,0.0,0,0).is_err());
    }
    #[test]
    fn a_minimum_frequency_and_reverb_are_independent_options(){
        let stg=Settings{low:20.0,high:3000.0,curvature:1.0,invert:0.0,
            mode:Progression::FoldHigh,quality:0};
        let mut a=Stream::new_extended(8192.0,1,stg,0,0,1.0,0.0,0.0,0,4).unwrap();
        let mut b=Stream::new_extended(8192.0,1,stg,0,1,1.0,0.0,0.0,0,4).unwrap();
        assert!(a.set_a_options(900.0,0.4).is_ok());
        assert_eq!(a.a_min_hz,900.0);
        assert!((a.a_reverb_amount-0.4).abs()<0.00001);
        assert!(a.set_a_options(2.0,1.0).is_err());
        b.set_a_options(900.0,1.0).unwrap();
        let mut aa=vec![0.0f32;128];aa[0]=0.7;
        let mut bb=aa.clone();
        a.post_process(&mut aa,128);
        b.post_process(&mut bb,128);
        assert!(aa[0]<bb[0]);
        a.reset();assert_eq!(a.a_reverb_pos,[0;3]);
        assert!(a.a_reverb_delays[0][0].iter().all(|v|*v==0.0));
    }
    #[test]
    fn a_peak_band_is_configurable_without_changing_engine_b(){
        let mut a=Stream::new(8192.0,1,settings(),1).unwrap();
        assert_eq!(a.a_peak_band_bins,1);
        assert!(a.set_a_peak_band(5).is_ok());
        assert_eq!(a.a_peak_band_bins,5);
        assert!(a.set_a_peak_band(0).is_err());
        assert!(a.set_a_peak_band(9).is_err());
        let ptr=Box::into_raw(Box::new(a));
        unsafe {assert_eq!(warp_stream_set_a_band(ptr,7),0);
            assert_eq!((*ptr).a_peak_band_bins,7);
            warp_stream_free(ptr);}
    }
    #[test]
    fn a_quality_budget_is_live_bounded_and_no_audio_callback_allocation_needed(){
        for quality_id in 0..=2 {
            let mut settings=settings();
            settings.quality=quality_id;
            let mut a=Stream::new(12000.0,1,settings,1).unwrap();
            let base=quality(quality_id).unwrap();
            assert_eq!(a.max_peaks,base.max_peaks);
            assert_eq!(a.floor,base.floor);
            assert_eq!(a.set_a_quality(101),Err("invalid A quality"));
            assert!(a.set_a_quality(100).is_ok());
            assert_eq!(a.max_peaks,base.max_peaks*4);
            assert!((a.floor-base.floor*0.1).abs()<1e-9);
            assert_eq!(a.used.len(),base.max_peaks*4);
            assert!(a.peaks.capacity()>=a.max_peaks);
            assert!(a.tracks.capacity()>=a.max_peaks);
            assert!(a.next_tracks.capacity()>=a.max_peaks);
            assert!(a.set_a_quality(0).is_ok());
            assert_eq!(a.max_peaks,base.max_peaks);
        }
    }
    #[test]
    fn physical_slope_zero_pivot_is_uniform_pitch_in_both_engines(){
        let settings=Settings{low:20.0,high:3000.0,curvature:1.0,
            invert:0.0,mode:Progression::FoldHigh,quality:0};
        for engine in [0,1]{
            let mut stream=Stream::new_extended(8192.0,1,settings,1,engine,
                1.0,0.0,0.0,0,4).unwrap();
            stream.set_geometry(0.0,2.0).unwrap();
            assert_eq!(stream.axis_pivot,0.0);
            assert!((translate_frequency_controls(500.0,stream.axis_pivot,
                stream.axis_slope,stream.axis_reference,1.0,0.0)-1000.0).abs()<1e-8);
        }
    }
    #[test]
    fn both_resynthesis_engines_respect_signed_zero_policy_and_pivot_slope(){
        let settings=Settings{low:20.0,high:3000.0,curvature:1.0,invert:0.0,
            mode:Progression::FoldHigh,quality:0};
        for engine in [0,1]{
            let mut stream=Stream::new_extended(8192.0,1,settings,0,engine,
                1.0,0.0,0.0,0,4).unwrap();
            stream.set_transform(-2.0,350.0,0,0).unwrap();
            stream.set_geometry(350.0,2.0).unwrap();
            assert_eq!(stream.resolve_zero(-200.0,8.0),Some((200.0,1.0)));
            stream.zero_mode=1;
            assert_eq!(stream.resolve_zero(-200.0,8.0),None);
            stream.zero_mode=2;
            assert!(stream.resolve_zero(-4.0,8.0).unwrap().1>0.0);
            assert_eq!(stream.resolve_zero(-20.0,8.0),None);
            let mut output=vec![0.0f32;128];
            for b in 0..70 {
                let input=(0..128).map(|j|((2.0*std::f64::consts::PI*500.0*(b*128+j) as f64/8192.0).cos()*0.5) as f32).collect::<Vec<_>>();
                stream.process(&input,&mut output,128).unwrap();
                assert!(output.iter().all(|x|x.is_finite()));
            }
        }
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
