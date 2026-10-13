/**
 * Browser-only R2.1 research port. Offline and deliberately incomplete.
 * FFT-bin complex interpolation is NOT used: narrowband analytic partials
 * are extracted and rotated by integrated instantaneous-frequency deltas.
 * No product policy is assigned to DC, Nyquist, out-of-band or residual noise.
 */
const TWO_PI = 2 * Math.PI;
const wrapPhase = x => ((x + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;

export function fft(real, imag, inverse = false) {
  const n = real.length;
  if (n !== imag.length || !Number.isInteger(Math.log2(n))) {
    throw new RangeError("FFT requires equal-length power-of-two arrays");
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const a = (inverse ? 1 : -1) * TWO_PI / length;
    const wr0 = Math.cos(a), wi0 = Math.sin(a);
    for (let base = 0; base < n; base += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const s = base + j, t = s + length / 2;
        const tr = wr * real[t] - wi * imag[t];
        const ti = wr * imag[t] + wi * real[t];
        real[t] = real[s] - tr; imag[t] = imag[s] - ti;
        real[s] += tr; imag[s] += ti;
        const w = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0; wr = w;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n; imag[i] /= n;
    }
  }
  return { real, imag };
}

const check01 = (x, name) => {
  if (!Number.isFinite(x) || x < 0 || x > 1) {
    throw new RangeError(name + " must be in [0, 1]");
  }
};
const coordinate = (f, low, p) =>
  p === 0 ? Math.log(f / low) : Math.expm1(p * Math.log(f / low)) / p;
const inverseCoordinate = (x, low, p) =>
  low * Math.exp(p === 0 ? x : Math.log1p(p * x) / p);

export function mapFrequency(f, low, high, p, amount, mode = "fold") {
  if (!(low > 0 && high > low && Number.isFinite(high))) throw new RangeError("Invalid band");
  check01(p, "Curvature");
  check01(amount, "Invert");
  if (!(Number.isFinite(f) && f >= low && f <= high)) throw new RangeError("Outside research band");
  if (!["fold", "blend"].includes(mode)) throw new RangeError("Unsupported mode");
  if (amount === 0) return f;
  const x = coordinate(f, low, p), d = coordinate(high, low, p);
  if (mode === "blend") {
    return (1 - amount) * f + amount * inverseCoordinate(d - x, low, p);
  }
  const z = x + amount * d;
  const mod = ((z % (2 * d)) + (2 * d)) % (2 * d);
  return Math.min(high, Math.max(low, inverseCoordinate(d - Math.abs(mod - d), low, p)));
}

export function mixWet(dry, wetAudio, wet) {
  check01(wet, "Wet");
  if (dry.length !== wetAudio.length) throw new RangeError("Length mismatch");
  const out = new Float32Array(dry.length);
  for (let i = 0; i < out.length; i++) out[i] = (1 - wet) * dry[i] + wet * wetAudio[i];
  return out;
}

export const QUALITY = Object.freeze({
  eco: { fftSize: 1024, hop: 256, peaks: 6, floor: 0.09 },
  standard: { fftSize: 2048, hop: 256, peaks: 10, floor: 0.045 },
  high: { fftSize: 4096, hop: 512, peaks: 18, floor: 0.025 }
});

/**
 * @param {Float32Array[]} channels PCM channel arrays (1/2 channels).
 * @param {number} sampleRate source sample rate; resampling not performed.
 * @param {object} settings - bounds must be strictly inside Nyquist.
 * @param {(ratio:number)=>void} onProgress optional Worker callback.
 * @returns {{channels:Float32Array[],diagnostics:object}}
 */
export function warpOffline(channels, sampleRate, settings, onProgress = () => {}) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 ||
      !channels.every(c => c instanceof Float32Array && c.length === channels[0].length)) {
    throw new TypeError("Expected one or two equal-length Float32Array channels");
  }
  const samples = channels[0].length;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("Invalid sample rate");
  const {low, high, curvature, invert, mode = "fold",
    fftSize: n, hop, peaks: maxPeaks, floor: peakFloor} = settings;
  if (!(low > 0 && high > low && high < sampleRate / 2)) throw new RangeError("Bounds must be inside Nyquist");
  if (!Number.isInteger(n) || n < 128 || (n & (n - 1))) throw new RangeError("FFT size must be power of two");
  if (!Number.isInteger(hop) || hop < 1 || hop > n / 2) throw new RangeError("Invalid hop");
  if (!Number.isInteger(maxPeaks) || maxPeaks < 1 || !(peakFloor > 0 && peakFloor < 1))
    throw new RangeError("Invalid peak configuration");
  check01(curvature, "Curvature"); check01(invert, "Invert");
  if (mode !== "fold" && mode !== "blend") throw new RangeError("Invalid mode");
  if (samples < n) throw new RangeError("Audio too short for this quality mode");

  const count = channels.length;
  const half = n >>> 1, padding = half;
  const extra = (hop - samples % hop) % hop;
  const total = samples + n + extra;
  const frameCount = Math.floor((total - n) / hop) + 1;
  const output = Array.from({length: count}, () => new Float64Array(total));
  const padded = channels.map(input => {
    const copy = new Float64Array(total);
    copy.set(input, padding);
    return copy;
  });
  const weights = new Float64Array(total);
  const window = Float64Array.from({length: n}, (_, i) => .5 - .5 * Math.cos(TWO_PI * i / n));
  const localTime = Float64Array.from({length: n}, (_, i) => (i - n / 2) / sampleRate);
  const binWidth = sampleRate / n;
  const hopTime = hop / sampleRate;
  let previous = null, tracks = [];
  const counters = {frames: frameCount, peaks: 0, linked: 0, skipped: 0, nominalLookahead: n / 2};

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    const spectrum = padded.map(input => {
      const real = new Float64Array(n), imag = new Float64Array(n);
      for (let i = 0; i < n; i++) real[i] = input[start + i] * window[i];
      fft(real, imag);
      return {real, imag};
    });
    const mag = new Float64Array(half + 1);
    let greatest = 0;
    for (let k = 1; k < half; k++) {
      let m2 = 0;
      for (const {real, imag} of spectrum) m2 += real[k]**2 + imag[k]**2;
      mag[k] = Math.sqrt(m2);
      greatest = Math.max(greatest, mag[k]);
    }
    const peakCandidates = [];
    const threshold = Math.max(1e-10, greatest * peakFloor);
    for (let k = 2; k < half - 1; k++) {
      if (mag[k] >= threshold && mag[k] >= mag[k-1] && mag[k] > mag[k+1]) {
        peakCandidates.push(k);
      }
    }
    peakCandidates.sort((a,b) => mag[b] - mag[a]);
    const peaks = peakCandidates.slice(0, maxPeaks).sort((a,b) => a-b);
    const frameOutput = Array.from({length: count}, () => new Float64Array(n));
    const newTracks = [];
    const used = new Set();

    for (let j = 0; j < peaks.length; j++) {
      const k = peaks[j];
      const ch = Math.hypot(spectrum[0].real[k], spectrum[0].imag[k]) > 1e-10 ?
        0 : count > 1 ? 1 : 0;
      const phase = Math.atan2(spectrum[ch].imag[k], spectrum[ch].real[k]);
      let freq;
      if (!previous || Math.hypot(previous[ch].real[k],previous[ch].imag[k]) < 1e-8) {
        const l = Math.log(Math.max(1e-12,mag[k-1])), m = Math.log(Math.max(1e-12,mag[k])),
          r = Math.log(Math.max(1e-12,mag[k+1]));
        const denom = l-2*m+r;
        const frac = Math.abs(denom) > 1e-10 ? Math.max(-.5,Math.min(.5,.5*(l-r)/denom)) : 0;
        freq = (k+frac)*binWidth;
      } else {
        const oldPhase = Math.atan2(previous[ch].imag[k],previous[ch].real[k]);
        freq = k*binWidth + wrapPhase(phase - oldPhase - TWO_PI*k*hop/n)/(TWO_PI*hopTime);
      }
      if (!(freq >= low && freq <= high && Number.isFinite(freq))) {
        counters.skipped++; continue;
      }
      const target = mapFrequency(freq,low,high,curvature,invert,mode);
      if (!(target > 0 && target < sampleRate/2)) {
        counters.skipped++; continue;
      }
      const difference = target - freq;
      let matched = -1, best = Infinity;
      for (let t = 0; t < tracks.length; t++) {
        const dist = Math.abs(freq-tracks[t].frequency);
        if (!used.has(t) && dist < best) {matched=t;best=dist;}
      }
      let phaseShift=0, slope=0;
      if (matched >= 0 && best < Math.max(3*binWidth,0.05*freq)) {
        used.add(matched);
        const old = tracks[matched];
        phaseShift=old.phaseShift + Math.PI*(old.difference+difference)*hopTime;
        slope=(difference-old.difference)/hopTime;
        counters.linked++;
      }
      newTracks.push({frequency:freq,difference,phaseShift});

      const left = Math.max(k-3, j===0 ? 1 : Math.floor((peaks[j-1]+k)/2)+1);
      const right = Math.min(k+4, j===peaks.length-1 ? half : Math.floor((peaks[j+1]+k)/2)+1);
      if (left>=right) continue;

      const carriersRe = new Float64Array(n), carriersIm = new Float64Array(n);
      for(let i=0;i<n;i++) {
        const phaseAtTime=TWO_PI*difference*localTime[i] +
          Math.PI*slope*localTime[i]*localTime[i] + phaseShift;
        carriersRe[i]=Math.cos(phaseAtTime);
        carriersIm[i]=Math.sin(phaseAtTime);
      }
      for(let c=0;c<count;c++) {
        const pr = new Float64Array(n), pi = new Float64Array(n);
        for(let bin=left;bin<right;bin++) {
          pr[bin]=2*spectrum[c].real[bin];
          pi[bin]=2*spectrum[c].imag[bin];
        }
        fft(pr,pi,true);
        const accum=frameOutput[c];
        for(let i=0;i<n;i++) {
          accum[i] += (pr[i]*carriersRe[i]-pi[i]*carriersIm[i]);
        }
      }
    }

    for(let i=0;i<n;i++) {
      const place=start+i, w=window[i];
      weights[place] += w*w;
      for(let c=0;c<count;c++) output[c][place] += frameOutput[c][i]*w;
    }
    counters.peaks += newTracks.length;
    tracks=newTracks;
    previous=spectrum;
    if (frame % 12 === 0 || frame===frameCount-1) onProgress((frame+1)/frameCount);
  }

  const result=output.map(channel => {
    const array=new Float32Array(samples);
    for(let i=0;i<samples;i++) {
      const w=weights[i+padding];
      array[i]=w>1e-9 ? channel[i+padding]/w : 0;
    }
    return array;
  });
  counters.durationSeconds=samples/sampleRate;
  return {channels:result, diagnostics:counters};
}
