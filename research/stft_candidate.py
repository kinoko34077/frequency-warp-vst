"""R2.1 offline STFT instantaneous-frequency / phase-continuous warp candidate.

Research reference ONLY, not a realtime VST3 processor. The method extracts
strong narrowband in-range peaks, preserving a common stereo phase rotation,
then uses local analytic-partial modulation with a phase accumulator. Noise,
untracked peaks, DC, Nyquist and outside-band components have NO product policy.
"""
from __future__ import annotations

import numpy as np

from research.reference import _validate_band, _validate_unit, map_frequency


def _wrap(angle):
    return (angle + np.pi) % (2.0 * np.pi) - np.pi


def stft_peak_warp(
    audio, sample_rate, *, low_hz=20.0, high_hz=8000.0,
    curvature=1.0, invert=1.0, mode="fold", n_fft=2048, hop=256,
    peak_floor=0.035, max_peaks=24,
):
    """Return (processed audio, diagnostics) for a narrowband STFT candidate.

    Windows are centered (nominal lookahead n_fft/2 samples). Each selected
    source peak uses wrapped phase-difference instantaneous-frequency
    estimation and one matched predecessor per frame. Bin-neighborhood IFFT
    recovers a windowed analytic partial, which is locally modulated by
    the required frequency DIFFERENCE, with continuous phase and approximate
    local frequency slope. A shared modulation preserves the input L/R
    spectral phase difference of each extracted component.

    This is *not* a complete residual/noise/speech/spatial engine. Dropping
    components outside the research band is a controlled experimental
    limitation, not an adopted product out-of-band behavior.
    """
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim not in (1, 2) or not np.all(np.isfinite(data)):
        raise ValueError("audio must be finite, shape (time[,channels])")
    if not isinstance(n_fft, int) or n_fft < 64 or n_fft % 2:
        raise ValueError("n_fft must be even and at least 64")
    if not isinstance(hop, int) or hop < 1 or hop > n_fft // 2:
        raise ValueError("hop must lie in [1, n_fft/2]")
    if data.shape[0] < n_fft:
        raise ValueError("input must have at least n_fft samples")
    if not np.isfinite(sample_rate) or sample_rate <= 0:
        raise ValueError("sample_rate must be positive and finite")
    low, high = _validate_band(low_hz, high_hz)
    _validate_unit("curvature", curvature)
    _validate_unit("invert", invert)
    if high >= sample_rate / 2:
        raise ValueError("high_hz must be below Nyquist")
    if mode not in ("fold", "blend"):
        raise ValueError("mode must be fold or blend")
    if not 0 < peak_floor < 1 or max_peaks < 1:
        raise ValueError("invalid peak selection")

    mono = data.ndim == 1
    samples = data[:, None] if mono else data
    length, channels = samples.shape
    pad_left = n_fft // 2
    pad_right = n_fft // 2 + (-length) % hop
    padded = np.pad(samples, ((pad_left, pad_right), (0, 0)))
    window = np.hanning(n_fft + 1)[:-1]  # periodic Hann
    out = np.zeros_like(padded)
    weights = np.zeros((len(padded), 1), dtype=np.float64)
    previous = None
    tracks = []
    hop_seconds = hop / sample_rate
    bin_width = sample_rate / n_fft
    local_t = (np.arange(n_fft) - n_fft / 2) / sample_rate
    diagnostics = {
        "frames": 0, "peak_count": 0, "relinked_peaks": 0,
        "skipped_peaks": 0,
    }

    for start in range(0, len(padded) - n_fft + 1, hop):
        spectrum = np.fft.rfft(
            padded[start:start + n_fft] * window[:, None], axis=0
        )
        magnitude = np.sqrt(np.sum(abs(spectrum) ** 2, axis=1))
        peaks = np.flatnonzero(
            (magnitude[1:-1] >= magnitude[:-2]) &
            (magnitude[1:-1] > magnitude[2:])
        ) + 1
        peaks = peaks[
            magnitude[peaks] >= max(np.max(magnitude) * peak_floor, 1e-10)
        ]
        peaks = sorted(sorted(peaks, key=lambda k: -magnitude[k])[:max_peaks])
        frame_out = np.zeros((n_fft, channels), dtype=np.float64)
        new_tracks = []
        used_previous = set()

        for j, k in enumerate(peaks):
            # Channel 0 remains the phase reference except at negligible level.
            ch = 0 if abs(spectrum[k, 0]) > 1e-11 else int(
                np.argmax(abs(spectrum[k]))
            )
            phase_in = float(np.angle(spectrum[k, ch]))
            if previous is None or abs(previous[k, ch]) < 1e-8:
                log_mag = np.log(np.maximum(magnitude[k-1:k+2], 1e-12))
                denominator = log_mag[0] - 2*log_mag[1] + log_mag[2]
                fraction = (
                    float(np.clip(
                        .5 * (log_mag[0] - log_mag[2]) / denominator,
                        -.5, .5
                    )) if abs(denominator) > 1e-10 else 0.0
                )
                frequency = (k + fraction) * bin_width
            else:
                residual = _wrap(
                    phase_in - np.angle(previous[k, ch]) -
                    2*np.pi*k*hop/n_fft
                )
                frequency = k*bin_width + residual / (2*np.pi*hop_seconds)

            if not np.isfinite(frequency) or not low <= frequency <= high:
                diagnostics["skipped_peaks"] += 1
                continue
            target = float(map_frequency(
                frequency, low, high, curvature, invert, mode
            ))
            if not 0 < target < sample_rate / 2:
                diagnostics["skipped_peaks"] += 1
                continue

            candidates = [
                (abs(frequency - old["frequency"]), i, old)
                for i, old in enumerate(tracks) if i not in used_previous
            ]
            nearest = min(candidates, key=lambda entry: entry[0]) if candidates else None
            difference = target - frequency
            if nearest and nearest[0] < max(3*bin_width, .05*frequency):
                _, predecessor, previous_track = nearest
                used_previous.add(predecessor)
                phase_shift = (
                    previous_track["phase_shift"] +
                    np.pi * (previous_track["difference"] + difference) * hop_seconds
                )
                slope = (
                    difference - previous_track["difference"]
                ) / hop_seconds
                diagnostics["relinked_peaks"] += 1
            else:
                phase_shift = 0.0
                slope = 0.0

            new_tracks.append({
                "frequency": frequency, "difference": difference,
                "phase_shift": phase_shift,
            })
            left = max(
                k - 3, 1 if j == 0 else (peaks[j - 1] + k) // 2 + 1
            )
            right = min(
                k + 4, len(magnitude) - 1 if j == len(peaks) - 1
                else (peaks[j + 1] + k) // 2 + 1
            )
            if left >= right:
                continue
            positive_only = np.zeros_like(spectrum)
            positive_only[left:right] = 2.0 * spectrum[left:right]
            partial = np.fft.ifft(positive_only, n=n_fft, axis=0)
            carrier = np.exp(1j * (
                2*np.pi*difference*local_t +
                np.pi*slope*local_t**2 + phase_shift
            ))
            frame_out += np.real(partial * carrier[:, None])

        out[start:start+n_fft] += frame_out * window[:, None]
        weights[start:start+n_fft] += window[:, None] ** 2
        previous = spectrum
        tracks = new_tracks
        diagnostics["frames"] += 1
        diagnostics["peak_count"] += len(new_tracks)

    aligned = out[pad_left:pad_left+length] / np.maximum(
        weights[pad_left:pad_left+length], 1e-9
    )
    return (aligned[:, 0] if mono else aligned), diagnostics
