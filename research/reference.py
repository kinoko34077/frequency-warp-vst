"""Offline mathematical/DSP reference, not a realtime VST3 processor.

Only defined for validated in-band positive frequency components. Boundary
handling beyond [low_hz, high_hz], DC/negative targets, Nyquist alias prevention,
and live parameter changes are NOT implemented by this prototype.
"""

from __future__ import annotations

import numpy as np


def _validate_band(low_hz: float, high_hz: float) -> tuple[float, float]:
    low, high = float(low_hz), float(high_hz)
    if not (np.isfinite(low) and np.isfinite(high) and 0.0 < low < high):
        raise ValueError("require finite 0 < low_hz < high_hz")
    return low, high


def _validate_unit(name: str, value: float) -> float:
    result = float(value)
    if not (np.isfinite(result) and 0.0 <= result <= 1.0):
        raise ValueError(f"{name} must be finite and in [0, 1]")
    return result


def _coordinate(f: np.ndarray, low: float, p: float) -> np.ndarray:
    logarithm = np.log(f / low)
    return logarithm if p == 0.0 else np.expm1(p * logarithm) / p


def _inverse_coordinate(u: np.ndarray, low: float, p: float) -> np.ndarray:
    return low * np.exp(u if p == 0.0 else np.log1p(p * u) / p)


def map_frequency(
    frequency_hz: np.ndarray | float,
    low_hz: float,
    high_hz: float,
    curvature: float = 1.0,
    invert: float = 1.0,
    mode: str = "fold",
) -> np.ndarray:
    """Map frequencies to the in-band axis; no out-of-band extrapolation.

    curvature=0: logarithmic/inverse reflection; curvature=1: linear reflection.
    invert=0: identity; invert=1: exact endpoint-exchanging reflection.
    The intermediate 'fold' mapping is continuous but NOT one-to-one.
    'blend' linearly interpolates frequencies and can collapse the full band
    to one point at curvature=1, invert=0.5.
    """
    low, high = _validate_band(low_hz, high_hz)
    p = _validate_unit("curvature", curvature)
    a = _validate_unit("invert", invert)
    f = np.asarray(frequency_hz, dtype=np.float64)
    if np.any(~np.isfinite(f)) or np.any((f < low) | (f > high)):
        raise ValueError("frequency_hz must be finite and inside [low_hz, high_hz]")
    if mode not in ("fold", "blend"):
        raise ValueError("mode must be 'fold' or 'blend'")

    if a == 0.0:
        return f.copy()
    x = _coordinate(f, low, p)
    d = _coordinate(np.asarray(high), low, p)
    if mode == "fold":
        position = np.mod(x + a * d, 2.0 * d)
        mapped = d - np.abs(position - d)
        return np.clip(_inverse_coordinate(mapped, low, p), low, high)

    reflected = _inverse_coordinate(d - x, low, p)
    return (1.0 - a) * f + a * reflected


def analytic_signal(audio: np.ndarray) -> np.ndarray:
    """FFT-domain analytic signal, with time on axis 0.

    Noncausal and uses a periodic-record assumption. Not a streaming Hilbert
    transformer, and its ends are susceptible to spectral leakage.
    """
    samples = np.asarray(audio, dtype=np.float64)
    if samples.ndim not in (1, 2) or samples.shape[0] < 2:
        raise ValueError("audio must have at least two samples, shape (time[, channels])")
    n = samples.shape[0]
    mask = np.zeros(n, dtype=np.float64)
    mask[0] = 1.0
    if n % 2 == 0:
        mask[n // 2] = 1.0
        mask[1 : n // 2] = 2.0
    else:
        mask[1 : (n + 1) // 2] = 2.0
    spectrum = np.fft.fft(samples, axis=0)
    shape = (n,) + (1,) * (samples.ndim - 1)
    return np.fft.ifft(spectrum * mask.reshape(shape), axis=0)


def linear_direct_transform(
    audio: np.ndarray, sample_rate: float, *, shift_hz: float | None = None,
    reflection_sum_hz: float | None = None,
) -> np.ndarray:
    """Reference constant shift OR linear reflection of analytic signal.

    reflection_sum_hz = L + H, gives f_out = reflection_sum_hz - f_in
    for positive in-band components; no protection against invalid outputs,
    DC crossings, or Nyquist folding. Not suitable as a realtime plugin.
    Stereo uses a shared oscillator but independently conjugates each channel;
    relative complex phase reverses sign (stereo image preservation unproven).
    """
    if (shift_hz is None) == (reflection_sum_hz is None):
        raise ValueError("specify exactly one of shift_hz or reflection_sum_hz")
    fs = float(sample_rate)
    if not np.isfinite(fs) or fs <= 0:
        raise ValueError("sample_rate must be positive and finite")
    oscillator_hz = float(shift_hz if shift_hz is not None else reflection_sum_hz)
    if not np.isfinite(oscillator_hz):
        raise ValueError("oscillator frequency must be finite")
    analytic = analytic_signal(audio)
    if reflection_sum_hz is not None:
        analytic = np.conj(analytic)
    n = analytic.shape[0]
    # The phase accumulator in a future realtime version must preserve state.
    phase = (2.0 * np.pi * oscillator_hz / fs) * np.arange(n)
    carrier = np.exp(1j * np.remainder(phase, 2.0 * np.pi))
    carrier = carrier.reshape((n,) + (1,) * (analytic.ndim - 1))
    return np.real(analytic * carrier)


def mix_wet(dry: np.ndarray, processed: np.ndarray, wet: float) -> np.ndarray:
    """Offline aligned-sample reference; no realtime latency compensation."""
    w = _validate_unit("wet", wet)
    original = np.asarray(dry, dtype=np.float64)
    treated = np.asarray(processed, dtype=np.float64)
    if original.shape != treated.shape:
        raise ValueError("dry and processed must have identical shapes")
    return (1.0 - w) * original + w * treated
