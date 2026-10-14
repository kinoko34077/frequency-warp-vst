//! Portable R2.1 offline research engine.
//! Exactly one processing implementation feeds native staticlib/C ABI and wasm.
//! Not a realtime-safe VST processor: allocates, requires complete input buffers.
//! No product behavior for out-of-band energy, DC, Nyquist, or untracked residuals.

use std::f64::consts::PI;

mod stream;
pub use stream::Stream; // One canonical native/WASM spectral streaming processor.
mod reflection;

const TAU: f64 = PI * 2.0;

#[derive(Clone, Copy, Debug)]
pub enum Progression { FoldHigh, Blend, FoldLow, Reciprocal }

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub low: f64,
    pub high: f64,
    pub curvature: f64,
    pub invert: f64,
    pub mode: Progression,
    pub quality: u32,
}

#[derive(Clone, Copy)]
struct Complex { r: f64, i: f64 }
impl Complex {
    const ZERO: Self = Self {r: 0.0, i: 0.0};
    fn magnitude(self) -> f64 { self.r.hypot(self.i) }
    fn angle(self) -> f64 { self.i.atan2(self.r) }
}

#[derive(Clone, Copy, Debug)]
pub struct Quality { pub n: usize, pub hop: usize, pub max_peaks: usize, pub floor: f64 }
pub fn quality(index: u32) -> Option<Quality> {
    match index {
        0 => Some(Quality {n: 1024, hop: 256, max_peaks: 6, floor: 0.09}),
        1 => Some(Quality {n: 2048, hop: 256, max_peaks: 10, floor: 0.045}),
        2 => Some(Quality {n: 4096, hop: 512, max_peaks: 18, floor: 0.025}),
        _ => None
    }
}

fn coordinate(f: f64, low: f64, p: f64) -> f64 {
    let log = (f / low).ln();
    if p == 0.0 { log } else { (p * log).exp_m1() / p }
}
fn inverse_coordinate(u: f64, low: f64, p: f64) -> f64 {
    low * (if p == 0.0 {u} else {(p * u).ln_1p() / p}).exp()
}

/// Shift a positive source frequency by a constant amount in the chosen
/// frequency coordinate. At p=0 this is multiplication by exp(shift);
/// at p=1 this is addition of shift*reference Hz. Intermediate p is
/// the identical log/expm1 coordinate family used by nonlinear warp.
/// Signed extension below zero is a mathematical convention: the audio
/// engine must still apply Reflect/Kill/Fade at the target-0 boundary.
/// An explicitly pivoted / sloped frequency-axis map.
/// pivot stays fixed when shift=0 and slope varies. slope=1 preserves the
/// previous pitch (p=0) / Hz translation (p=1) semantics.
/// Warning: slope != 1 changes harmonic spacing (a spectral tilt), not
/// a uniform pitch shift even on a log scale.
pub fn translate_frequency_affine(f:f64,pivot:f64,p:f64,shift:f64,slope:f64)->f64{
    if !f.is_finite()||f<=0.0||!pivot.is_finite()||pivot<=0.0||
       !p.is_finite()||!(0.0..=1.0).contains(&p)||
       !shift.is_finite()||shift.abs()>4.0||!slope.is_finite()||
       !(-4.0..=4.0).contains(&slope){return f64::NAN;}
    if slope==1.0&&shift==0.0{return f;}
    // C_p(pivot; pivot) = 0: the anchor's displacement is exactly shift.
    let u=slope*coordinate(f,pivot,p)+shift;
    if p==0.0{return pivot*u.exp();}
    let v=1.0+p*u;
    if v>=0.0{pivot*v.powf(1.0/p)}
    else{-pivot*(-v).powf(1.0/p)}
}
pub fn translate_frequency(f:f64,reference:f64,p:f64,shift:f64)->f64{
    translate_frequency_affine(f,reference,p,shift,1.0)
}
#[no_mangle]
pub extern "C" fn warp_translate_frequency(f:f64,reference:f64,p:f64,shift:f64)->f64{
    translate_frequency(f,reference,p,shift)
}
#[no_mangle]
pub extern "C" fn warp_translate_frequency_affine(
    f:f64,pivot:f64,p:f64,shift:f64,slope:f64)->f64{
    translate_frequency_affine(f,pivot,p,shift,slope)
}

pub fn translate_frequency_controls(f:f64,pivot:f64,slope:f64,reference:f64,p:f64,shift:f64)->f64{
 if !f.is_finite()||!pivot.is_finite()||!(0.0..=20000.0).contains(&pivot)
 || !slope.is_finite()||!(-4.0..=4.0).contains(&slope)
 || !reference.is_finite()||reference<=0.0
 || !p.is_finite()||!(0.0..=1.0).contains(&p)
 || !shift.is_finite()||shift.abs()>4.0{return f64::NAN;}
 let stretched=pivot+slope*(f-pivot);
 if p==1.0{return stretched+shift*reference;}
 if stretched<=0.0{return stretched;}
 translate_frequency(stretched,reference,p,shift)
}
#[no_mangle]
pub extern "C" fn warp_translate_frequency_controls(f:f64,pivot:f64,slope:f64,reference:f64,p:f64,shift:f64)->f64{
 translate_frequency_controls(f,pivot,slope,reference,p,shift)
}

pub fn translate_frequency_anchored(f:f64,anchor:f64,pivot:f64,slope:f64,reference:f64,p:f64,shift:f64)->f64{
    if !f.is_finite()||!anchor.is_finite()||!pivot.is_finite()
       ||!(0.0..=20000.0).contains(&pivot)||!slope.is_finite()
       ||!(-4.0..=4.0).contains(&slope)||!reference.is_finite()
       ||reference<=0.0||!p.is_finite()||!(0.0..=1.0).contains(&p)
       ||!shift.is_finite()||shift.abs()>4.0{return f64::NAN;}
    let value=pivot+slope*(f-anchor);
    if p==1.0{return value+shift*reference;}
    if value<=0.0{return value;}
    translate_frequency(value,reference,p,shift)
}
#[no_mangle]
pub extern "C" fn warp_translate_frequency_anchored(f:f64,anchor:f64,pivot:f64,slope:f64,reference:f64,p:f64,shift:f64)->f64{
    translate_frequency_anchored(f,anchor,pivot,slope,reference,p,shift)
}

/// Research mapping is *only* defined for positive frequencies in [L,H].
pub fn map_frequency(f: f64, s: Settings) -> Result<f64, &'static str> {
    if !s.low.is_finite() || !s.high.is_finite() || s.low <= 0.0 || s.high <= s.low
        || !(0.0..=1.0).contains(&s.curvature) || !(0.0..=1.0).contains(&s.invert)
        || !f.is_finite() || f < s.low || f > s.high {
        return Err("invalid frequency or mapping domain");
    }
    if s.invert == 0.0 { return Ok(f); }
    let x = coordinate(f, s.low, s.curvature);
    let d = coordinate(s.high, s.low, s.curvature);
    let result = match s.mode {
        Progression::Blend => (1.0 - s.invert) * f +
            s.invert * inverse_coordinate(d - x, s.low, s.curvature),
        // Multiplicative interpolation between the source and full
        // coordinate inversion. For p=0, I(f)=LH/f; at a=.5 every
        // source converges on sqrt(LH), unlike translated Fold L/H.
        // Endpoints are the SAME identity/full inversion as old modes.
        Progression::Reciprocal => {
            let inverted=inverse_coordinate(d-x,s.low,s.curvature);
            ((1.0-s.invert)*f.ln()+s.invert*inverted.ln()).exp()
        },
        Progression::FoldHigh | Progression::FoldLow => {
            let offset = if matches!(s.mode, Progression::FoldLow) { -s.invert } else { s.invert };
            let v = (x + offset * d).rem_euclid(2.0 * d);
            inverse_coordinate(d - (v - d).abs(), s.low, s.curvature).clamp(s.low, s.high)
        }
    };
    Ok(result)
}

/// Input-domain break location where the finite-range Fold changes direction.
/// FoldHigh: S_p^-1((1-a)*D); FoldLow: S_p^-1(a*D).
/// Blend has no fold point (None), and the two endpoints are valid at a=0 or a=1.
pub fn fold_frequency(s:Settings)->Option<f64>{
    if !s.low.is_finite() || !s.high.is_finite() || s.low<=0.0 || s.high<=s.low
       || !(0.0..=1.0).contains(&s.curvature) || !(0.0..=1.0).contains(&s.invert) {return None;}
    let x=coordinate(s.high,s.low,s.curvature);
    let location=match s.mode{
        Progression::FoldHigh=>(1.0-s.invert)*x,
        Progression::FoldLow=>s.invert*x,
        Progression::Blend | Progression::Reciprocal=>return None,
    };
    Some(inverse_coordinate(location,s.low,s.curvature).clamp(s.low,s.high))
}
#[no_mangle]
pub extern "C" fn warp_fold_frequency(low:f64,high:f64,p:f64,invert:f64,mode:u32)->f64{
    let s=Settings{low,high,curvature:p,invert,
        mode:match mode{1=>Progression::Blend,2=>Progression::FoldLow,3=>Progression::Reciprocal,_=>Progression::FoldHigh},
        quality:0};
    fold_frequency(s).unwrap_or(f64::NAN)
}
/// Input reference for the invert slider: Fold kink for two Fold modes;
/// coordinate inversion fixed point C^-1(D/2) for reciprocal interpolation.
/// Linear Blend has no unique fold/fixed marker within the slider's meaning.
#[no_mangle]
pub extern "C" fn warp_invert_reference_frequency(low:f64,high:f64,p:f64,a:f64,mode:u32)->f64{
    if !(low>0.0&&high>low&&p.is_finite()&&(0.0..=1.0).contains(&p)
        &&a.is_finite()&&(0.0..=1.0).contains(&a)){return f64::NAN;}
    if mode==3{
        let d=coordinate(high,low,p);
        return inverse_coordinate(d*0.5,low,p);
    }
    warp_fold_frequency(low,high,p,a,mode)
}


/// In-place radix-2 DFT over complex samples.
fn fft(samples: &mut [Complex], inverse: bool) {
    let n = samples.len();
    debug_assert!(n.is_power_of_two());
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while (j & bit) != 0 { j ^= bit; bit >>= 1; }
        j ^= bit;
        if i < j { samples.swap(i, j); }
    }
    let mut len = 2;
    while len <= n {
        let theta = if inverse {TAU / len as f64} else {-TAU / len as f64};
        let rot = Complex{r:theta.cos(), i:theta.sin()};
        for base in (0..n).step_by(len) {
            let mut w = Complex{r:1.0,i:0.0};
            for pos in 0..len / 2 {
                let a = base + pos;
                let b = a + len / 2;
                let t = Complex{
                    r: w.r * samples[b].r - w.i * samples[b].i,
                    i: w.r * samples[b].i + w.i * samples[b].r,
                };
                let u = samples[a];
                samples[a] = Complex{r:u.r + t.r,i:u.i + t.i};
                samples[b] = Complex{r:u.r - t.r,i:u.i - t.i};
                w = Complex{
                    r: w.r * rot.r - w.i * rot.i,
                    i: w.r * rot.i + w.i * rot.r
                };
            }
        }
        len *= 2;
    }
    if inverse {
        for z in samples { z.r /= n as f64; z.i /= n as f64; }
    }
}

#[derive(Clone, Copy)]
struct Track {frequency:f64, difference:f64, phase_shift:f64}

pub struct ResultAudio { pub channels: Vec<Vec<f32>>, pub frames: usize, pub peaks: usize }

/// Offline whole-buffer processing, not realtime safe.
/// Channels must have matching sample counts and source rate.
pub fn process(source: &[Vec<f32>], sample_rate: f64, s: Settings) -> Result<ResultAudio, &'static str> {
    process_with_outside(source, sample_rate, s, 0)
}

/// Outside band 0=Kill (research previous behavior); 1=Pass unaffected spectral material.
/// Outside-band Pass uses the complement of the STFT input spectrum. It is not
/// a separate raw Dry overlay (which would duplicate the transformed band).
pub fn process_with_outside(source: &[Vec<f32>], sample_rate: f64, s: Settings, outside: u32) -> Result<ResultAudio, &'static str> {
    if outside > 1 { return Err("invalid outside band mode"); }
    if source.is_empty() || source.len() > 2 ||
        !sample_rate.is_finite() || sample_rate <= 0.0 ||
        !s.high.is_finite() || s.high >= sample_rate/2.0 ||
        source[0].is_empty() || source.iter().any(|c| c.len()!=source[0].len() || c.iter().any(|x| !x.is_finite())) {
        return Err("invalid audio buffer or sample rate");
    }
    let q = quality(s.quality).ok_or("unknown quality tier")?;
    if source[0].len() < q.n || source[0].len() > (sample_rate * 180.0) as usize {
        return Err("audio length outside research bounds");
    }
    map_frequency(s.low, s)?;
    let length=source[0].len();
    let channel_count=source.len();
    let left=q.n/2;
    let extra=(q.hop - length % q.hop) % q.hop;
    let total=length + q.n + extra;
    let mut signal=vec![vec![0.0f64;total];channel_count];
    for c in 0..channel_count {
        for i in 0..length {signal[c][i+left]=source[c][i] as f64;}
    }
    let mut output=vec![vec![0.0f64;total];channel_count];
    let mut weights=vec![0.0f64;total];
    let window:Vec<f64>=(0..q.n)
        .map(|i| 0.5-0.5*(TAU * i as f64 / q.n as f64).cos()).collect();
    let local:Vec<f64>=(0..q.n)
        .map(|i| (i as f64 - q.n as f64/2.0)/sample_rate).collect();
    let bin_width=sample_rate/q.n as f64;
    let hop_seconds=q.hop as f64/sample_rate;
    let half=q.n/2;
    let mut previous:Option<Vec<Vec<Complex>>>=None;
    let mut tracks:Vec<Track>=Vec::new();
    let mut nframes=0usize;
    let mut npeak=0usize;

    for start in (0..=total-q.n).step_by(q.hop) {
        let mut spectra=vec![vec![Complex::ZERO;q.n];channel_count];
        for c in 0..channel_count {
            for i in 0..q.n {
                spectra[c][i].r=signal[c][start+i] * window[i];
            }
            fft(&mut spectra[c],false);
        }
        let mut magnitude=vec![0.0;half+1];
        let mut highest: f64=0.0;
        for k in 1..half {
            let squared=(0..channel_count).map(|c| {
                let z=spectra[c][k]; z.r*z.r + z.i*z.i
            }).sum::<f64>();
            magnitude[k]=squared.sqrt();
            highest=highest.max(magnitude[k]);
        }
        let threshold=(highest*q.floor).max(1e-10);
        let mut peaks:Vec<usize>=(2..half-1)
            .filter(|&k| magnitude[k]>=threshold &&
                magnitude[k]>=magnitude[k-1] && magnitude[k]>magnitude[k+1]).collect();
        peaks.sort_by(|&a,&b| magnitude[b].total_cmp(&magnitude[a]));
        peaks.truncate(q.max_peaks);
        peaks.sort_unstable();

        let mut frame_output=vec![vec![0.0f64;q.n];channel_count];
        let mut new_tracks=Vec::new();
        let mut used=vec![false;tracks.len()];
        for (j,&k) in peaks.iter().enumerate() {
            let ch= if spectra[0][k].magnitude()>1e-10 {0} else {channel_count-1};
            let phase=spectra[ch][k].angle();
            let frequency=if let Some(ref prev)=previous {
                if prev[ch][k].magnitude()>=1e-8 {
                    let delta=(phase-prev[ch][k].angle()-TAU*k as f64*q.hop as f64/q.n as f64
                        + PI).rem_euclid(TAU)-PI;
                    k as f64 * bin_width + delta/(TAU*hop_seconds)
                } else {
                    interpolated_frequency(k,&magnitude,bin_width)
                }
            } else {
                interpolated_frequency(k,&magnitude,bin_width)
            };
            if !frequency.is_finite() || frequency < s.low || frequency > s.high {continue;}
            let target=map_frequency(frequency,s)?;
            if target <= 0.0 || target >= sample_rate/2.0 {continue;}
            let difference=target-frequency;
            let mut best=(f64::INFINITY, None);
            for (index,old) in tracks.iter().enumerate() {
                let distance=(frequency-old.frequency).abs();
                if !used[index] && distance<best.0 {best=(distance,Some(index));}
            }
            let mut phase_shift=0.0;
            let mut slope=0.0;
            if let Some(index)=best.1 {
                if best.0<(3.0*bin_width).max(0.05*frequency) {
                    used[index]=true;
                    let old=tracks[index];
                    phase_shift=old.phase_shift + PI*(old.difference+difference)*hop_seconds;
                    slope=(difference-old.difference)/hop_seconds;
                }
            }
            new_tracks.push(Track{frequency,difference,phase_shift});
            let left_bin=(k.saturating_sub(3)).max(
                if j==0 {1} else {(peaks[j-1]+k)/2+1});
            let right_bin=(k+4).min(
                if j+1==peaks.len() {half} else {(peaks[j+1]+k)/2+1});
            if left_bin>=right_bin {continue;}
            let carriers:Vec<(f64,f64)>=local.iter().map(|&t| {
                let angle=TAU*difference*t+PI*slope*t*t+phase_shift;
                (angle.cos(),angle.sin())
            }).collect();
            for c in 0..channel_count {
                let mut partial=vec![Complex::ZERO;q.n];
                for k in left_bin..right_bin {
                    partial[k]=Complex{r:2.0*spectra[c][k].r,i:2.0*spectra[c][k].i};
                }
                fft(&mut partial,true);
                for i in 0..q.n {
                    frame_output[c][i]+=partial[i].r*carriers[i].0-partial[i].i*carriers[i].1;
                }
            }
        }
        // Optional out-of-band passthrough: complementary input spectrum.
        // Reconstruct real IFFT using symmetric bins. Bins within the mapped
        // band are never also passed through, avoiding large duplicated energy.
        if outside == 1 {
            for c in 0..channel_count {
                let mut complement = vec![Complex::ZERO; q.n];
                for k in 0..=half {
                    let frequency = k as f64 * bin_width;
                    if frequency < s.low || frequency > s.high {
                        complement[k] = spectra[c][k];
                        if k > 0 && k < half { complement[q.n-k] = spectra[c][q.n-k]; }
                    }
                }
                fft(&mut complement, true);
                for i in 0..q.n { frame_output[c][i] += complement[i].r; }
            }
        }
        for i in 0..q.n {
            let place=start+i; let w=window[i];
            weights[place]+=w*w;
            for c in 0..channel_count {output[c][place]+=frame_output[c][i]*w;}
        }
        npeak+=new_tracks.len();
        tracks=new_tracks;
        previous=Some(spectra);
        nframes+=1;
    }
    let result=(0..channel_count).map(|c| {
        (0..length).map(|i| {
            let j=i+left;
            if weights[j]>1e-9 {(output[c][j]/weights[j]) as f32} else {0.0}
        }).collect::<Vec<f32>>()
    }).collect();
    Ok(ResultAudio{channels:result,frames:nframes,peaks:npeak})
}
fn interpolated_frequency(k:usize,magnitude:&[f64],bin_width:f64)->f64 {
    let l=magnitude[k-1].max(1e-12).ln();
    let m=magnitude[k].max(1e-12).ln();
    let r=magnitude[k+1].max(1e-12).ln();
    let d=l-2.0*m+r;
    let fraction=if d.abs()>1e-10 {(0.5*(l-r)/d).clamp(-0.5,0.5)} else {0.0};
    (k as f64+fraction)*bin_width
}

/// This native C ABI is also exported by wasm32, keeping one actual algorithm.
/// Planar contiguous channels: [all left samples][all right samples].
#[no_mangle]
pub extern "C" fn warp_map_frequency(f:f64,low:f64,high:f64,p:f64,amount:f64,mode:u32)->f64 {
    map_frequency(f,Settings{low,high,curvature:p,invert:amount,
        mode:match mode {1=>Progression::Blend,2=>Progression::FoldLow,3=>Progression::Reciprocal,_=>Progression::FoldHigh},quality:1})
        .unwrap_or(f64::NAN)
}
#[no_mangle]
pub extern "C" fn warp_alloc_f32(count:u32)->*mut f32 {
    if count==0 || count>40_000_000 {return std::ptr::null_mut();}
    let mut mem=Vec::<f32>::with_capacity(count as usize);
    let ptr=mem.as_mut_ptr();
    std::mem::forget(mem);
    ptr
}
/// # Safety
/// The allocation pointer/count must originate from warp_alloc_f32 exactly once.
#[no_mangle]
pub unsafe extern "C" fn warp_free_f32(ptr:*mut f32,count:u32) {
    if !ptr.is_null() && count>0 {
        let _=Vec::<f32>::from_raw_parts(ptr,0,count as usize);
    }
}
/// Return 0 on success; negative on invalid buffers/parameters or research bounds.
/// # Safety
/// Input and output must be non-overlapping valid count*frames f32 arrays.
#[no_mangle]
pub unsafe extern "C" fn warp_process_f32(
    input:*const f32, output:*mut f32, frames:u32, channels:u32,
    sample_rate:f64, low:f64, high:f64, curvature:f64,
    invert:f64, mode:u32, quality_index:u32,
)->i32 {
    warp_process_f32_ex(input,output,frames,channels,sample_rate,low,high,curvature,invert,mode,quality_index,0)
}

/// Same native/wasm DSP core with selectable outside-band handling.
/// # Safety
/// Inputs and outputs must be non-overlapping valid planar f32 buffers.
#[no_mangle]
pub unsafe extern "C" fn warp_process_f32_ex(
    input:*const f32, output:*mut f32, frames:u32, channels:u32,
    sample_rate:f64, low:f64, high:f64, curvature:f64,
    invert:f64, mode:u32, quality_index:u32, outside:u32,
)->i32 {
    if input.is_null() || output.is_null() || frames==0 || !(1..=2).contains(&channels)
       || (frames as usize).saturating_mul(channels as usize)>40_000_000 { return -1; }
    let len=frames as usize;
    let input=std::slice::from_raw_parts(input,len*channels as usize);
    let channels_in=(0..channels as usize).map(|c| {
        input[c*len..(c+1)*len].to_vec()
    }).collect::<Vec<_>>();
    let settings=Settings{low,high,curvature,invert,
        mode:match mode {1=>Progression::Blend,2=>Progression::FoldLow,3=>Progression::Reciprocal,_=>Progression::FoldHigh},
        quality:quality_index};
    match process_with_outside(&channels_in,sample_rate,settings,outside) {
        Err(_)=>-2,
        Ok(rendered)=>{
            let dest=std::slice::from_raw_parts_mut(output,len*channels as usize);
            for (c,part) in rendered.channels.iter().enumerate() {
                dest[c*len..(c+1)*len].copy_from_slice(part);
            }
            0
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config()->Settings {
        Settings{low:20.0,high:3000.0,curvature:1.0,invert:1.0,
            mode:Progression::FoldHigh,quality:0}
    }
    fn tone(freq:f64,phase:f64,gain:f64,n:usize)->Vec<f32>{
        (0..n).map(|i| (gain*(TAU*freq*i as f64/8192.0+phase).cos()) as f32).collect()
    }
    #[test]
    fn exact_curve() {
        let s=config();
        assert!((map_frequency(500.0,s).unwrap()-2520.0).abs()<1e-9);
        for p in [0.0,0.00001,0.5,1.0] {
            let settings=Settings{curvature:p,..s};
            let g=map_frequency(700.0,settings).unwrap();
            assert!((map_frequency(g,settings).unwrap()-700.0).abs()<1e-7);
        }
    }
    #[test]
    fn tone_and_stereo_survive() {
        let channels=vec![tone(500.0,0.0,0.7,4096),tone(500.0,0.5,0.52,4096)];
        let result=process(&channels,8192.0,config()).unwrap();
        assert_eq!(result.channels.len(),2);
        let channel=&result.channels[0];
        let rms=(channel.iter().map(|&x| (x as f64)*(x as f64)).sum::<f64>()/channel.len() as f64).sqrt();
        assert!(rms>0.30,"output rms {rms}");
        let mut spectrum=channel.iter().map(|&x| Complex{r:x as f64,i:0.0}).collect::<Vec<_>>();
        fft(&mut spectrum,false);
        let peak=(1..2048).max_by(|&a,&b| spectrum[a].magnitude().total_cmp(&spectrum[b].magnitude())).unwrap();
        assert!((peak as i32-1260).abs()<3,"got {peak} instead of 1260 (2520 Hz)");
        let mut right=result.channels[1].iter().map(|&x|Complex{r:x as f64,i:0.0}).collect::<Vec<_>>();
        fft(&mut right,false);
        let a=spectrum[peak].angle();
        let b=right[peak].angle();
        let phase=(b-a+PI).rem_euclid(TAU)-PI;
        assert!((phase-0.5).abs()<0.12,"stereo phase mismatch: {phase}");
    }
    #[test]
    fn h_and_l_folds_have_same_endpoints_but_different_midpoint() {
        let s=config();
        let value=200.0;
        for mode in [Progression::FoldHigh, Progression::FoldLow, Progression::Blend, Progression::Reciprocal] {
            let initial=map_frequency(value,Settings{mode,invert:0.0,..s}).unwrap();
            let full=map_frequency(value,Settings{mode,invert:1.0,..s}).unwrap();
            assert!((initial-value).abs()<1e-7);
            assert!((full-(s.low+s.high-value)).abs()<1e-7);
        }
        let at_half=Settings{invert:0.5,..s};
        let hi=map_frequency(value,at_half).unwrap();
        let lo=map_frequency(value,Settings{mode:Progression::FoldLow,..at_half}).unwrap();
        assert!((hi-lo).abs()>100.0);
    }
    #[test]
    fn reciprocal_mapping_interpolates_geometrically_without_changing_full_inverse(){
        let low=100.0;let high=1600.0;
        for p in [0.0,0.25,0.5,1.0]{
            for f in [100.0,160.0,400.0,800.0,1600.0]{
                let s=Settings{low,high,curvature:p,invert:0.0,
                    mode:Progression::Reciprocal,quality:0};
                let initial=map_frequency(f,s).unwrap();
                let inverted=map_frequency(f,Settings{invert:1.0,..s}).unwrap();
                let midpoint=map_frequency(f,Settings{invert:0.5,..s}).unwrap();
                assert!((initial-f).abs()<1e-9);
                let old_full=map_frequency(f,Settings{mode:Progression::Blend,invert:1.0,..s}).unwrap();
                assert!((inverted-old_full).abs()<1e-6);
                assert!((midpoint-(f*inverted).sqrt()).abs()<1e-6);
            }
            let marker=warp_invert_reference_frequency(low,high,p,0.35,3);
            assert!(marker>low&&marker<high);
            assert!((map_frequency(marker,Settings{low,high,curvature:p,
                    invert:1.0,mode:Progression::Reciprocal,quality:0}).unwrap()-marker).abs()<1e-6);
            assert!(warp_invert_reference_frequency(low,high,p,0.35,1).is_nan());
        }
        assert!((warp_invert_reference_frequency(low,high,0.0,0.5,3)-400.0).abs()<1e-9);
    }
    #[test]
    fn outside_pass_preserves_a_high_outside_tone_while_kill_removes_it() {
        let original=vec![tone(3700.0,0.0,0.5,4096)];
        let no=process_with_outside(&original,8192.0,config(),0).unwrap();
        let yes=process_with_outside(&original,8192.0,config(),1).unwrap();
        let rms=|x:&Vec<f32>| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()/x.len() as f64).sqrt();
        assert!(rms(&no.channels[0]) < 0.06);
        assert!(rms(&yes.channels[0]) > 0.28);
    }
    #[test]
    fn fold_breakpoint_is_single_source_for_visual_and_ring_coupling(){
        let s=Settings{low:100.0,high:1000.0,curvature:1.0,invert:0.25,
            mode:Progression::FoldHigh,quality:0};
        let high_side=fold_frequency(s).unwrap();
        assert!((high_side-775.0).abs()<1e-9);
        let low_side=fold_frequency(Settings{mode:Progression::FoldLow,..s}).unwrap();
        assert!((low_side-325.0).abs()<1e-9);
        assert!(fold_frequency(Settings{mode:Progression::Blend,..s}).is_none());
        assert!((warp_fold_frequency(100.0,1000.0,1.0,0.25,0)-775.0).abs()<1e-9);
    }
    #[test]
    fn affine_axis_is_pivot_anchored_and_preserves_pitch_hz_extremes(){
        let pivot=500.0;
        for p in [0.0,0.25,0.5,1.0] {
            assert!((translate_frequency_affine(pivot,pivot,p,0.0,3.0)-pivot).abs()<1e-8);
            assert!((translate_frequency_affine(pivot,pivot,p,0.3,3.0)
                    -translate_frequency_affine(pivot,pivot,p,0.3,1.0)).abs()<1e-8);
        }
        assert!((warp_translate_frequency_affine(250.0,500.0,0.0,0.0,2.0)-125.0).abs()<1e-7);
        assert!((warp_translate_frequency_affine(750.0,500.0,1.0,0.0,2.0)-1000.0).abs()<1e-7);
        assert!((warp_translate_frequency_affine(500.0,500.0,0.0,(2.0f64).ln(),1.0)-1000.0).abs()<1e-7);
        assert!((warp_translate_frequency_affine(500.0,500.0,1.0,0.2,1.0)-600.0).abs()<1e-7);
        assert!(warp_translate_frequency_affine(500.0,0.0,0.0,0.0,1.0).is_nan());
    }
    #[test]
    fn unified_axis_translation_pitch_at_log_and_hz_at_linear(){
        let f=400.0;let reference=200.0;let shift=0.5;
        assert!((translate_frequency(f,reference,0.0,shift)-f*shift.exp()).abs()<1e-8);
        assert!((translate_frequency(f,reference,1.0,shift)-(f+100.0)).abs()<1e-8);
        assert!((translate_frequency(f,reference,0.5,0.0)-f).abs()<1e-8);
        let mid=translate_frequency(f,reference,0.5,shift);
        assert!(mid>f+100.0 && mid<f*shift.exp());
        assert!((warp_translate_frequency(f,reference,1.0,-2.5)+100.0).abs()<1e-8);
    }
    #[test]
    fn signed_physical_slope_zero_and_negative_preserve_anchor_and_old_identity() {
        for p in [0.0,0.5,1.0] {
            assert!((warp_translate_frequency_anchored(500.0,500.0,350.0,1.0,350.0,p,0.0)-350.0).abs()<1e-8);
            assert!((warp_translate_frequency_anchored(250.0,350.0,350.0,1.0,350.0,p,0.0)-250.0).abs()<1e-8);
            assert!((warp_translate_frequency_anchored(500.0,350.0,350.0,0.0,350.0,p,0.0)-350.0).abs()<1e-8);
            assert!((warp_translate_frequency_anchored(500.0,350.0,350.0,-1.0,350.0,p,0.0)-200.0).abs()<1e-8);
            assert!((warp_translate_frequency_anchored(750.0,350.0,350.0,-1.0,350.0,p,0.0)+50.0).abs()<1e-8);
        }
        assert!((warp_translate_frequency_controls(500.0,350.0,-1.0,350.0,1.0,0.0)-200.0).abs()<1e-8);
        assert!((warp_translate_frequency_controls(750.0,350.0,-1.0,350.0,1.0,0.0)+50.0).abs()<1e-8);
        assert!((warp_translate_frequency_controls(500.0,350.0,0.0,350.0,1.0,0.0)-350.0).abs()<1e-8);
        assert!(warp_translate_frequency_controls(500.0,350.0,-4.001,350.0,1.0,0.0).is_nan());
        assert!((warp_translate_frequency_affine(250.0,500.0,1.0,0.0,-1.0)-750.0).abs()<1e-8);
    }
    #[test]
    fn c_abi_works() {
        let input=tone(500.0,0.0,1.0,4096);
        let mut output=vec![0.0;input.len()];
        let status=unsafe{warp_process_f32(input.as_ptr(),output.as_mut_ptr(),
            input.len() as u32,1,8192.0,20.0,3000.0,1.0,1.0,0,0)};
        assert_eq!(status,0);
        assert!(output.iter().map(|x|x.abs()).fold(0.0f32,f32::max)>0.5);
    }
}