"""Versioned synthetic corpus with *known partial sources* for R2 DSP comparisons.

These are signal-model oracles, not unique 'correct answers' for arbitrary audio.
No fixture imposes a policy on frequencies outside the selected [L, H] band.
"""

from dataclasses import dataclass

import numpy as np

from research.reference import map_frequency


@dataclass(frozen=True)
class Voice:
    f_start: float
    f_end: float
    gain_left: float = .7
    gain_right: float = .7
    phase_left: float = 0.0
    phase_right: float = 0.0
    onset_seconds: float = 0.0
    attack_seconds: float = 0.0
    decay_seconds: float | None = None


@dataclass(frozen=True)
class Case:
    name: str
    voices: tuple[Voice, ...]
    broadband_noise: bool = False


def corpus() -> tuple[Case, ...]:
    """Immutable fixture manifest; signal generation is deterministic."""
    return (
        Case("steady_tone", (Voice(900, 900, phase_right=.5, gain_right=.52),)),
        Case("linear_glide", (Voice(900, 1700, phase_right=.3, gain_right=.57),)),
        Case("crossing_chirps", (
            Voice(700, 2100, .45, .38, .1, -.25),
            Voice(2100, 700, .4, .53, -.3, .15),
        )),
        Case("harmonic_stack", tuple(
            Voice(f, f, .5 / harmonic, .45 / harmonic, .07 * harmonic, -.11 * harmonic)
            for harmonic, f in enumerate((400, 800, 1200, 1600), 1)
        )),
        Case("gated_burst", (
            Voice(1200, 1200, onset_seconds=.35, attack_seconds=.002, decay_seconds=.11,
                  gain_right=.55, phase_right=.4),
        )),
        Case("wideband_noise", (), broadband_noise=True),
    )


def frequency_path(voice: Voice, seconds: np.ndarray, duration_s: float) -> np.ndarray:
    """Instantaneous positive partial frequency, including pre-onset values."""
    return voice.f_start + (voice.f_end - voice.f_start) * seconds / duration_s


def _phase(frequency_hz: np.ndarray, sample_rate: float) -> np.ndarray:
    """Trapezoidal integral with phase[0] = 0, deterministic for linear chirps."""
    if frequency_hz.ndim != 1:
        raise ValueError("frequency must be a single voice 1D track")
    increments = (frequency_hz[1:] + frequency_hz[:-1]) * (np.pi / sample_rate)
    return np.concatenate(([0.0], np.cumsum(increments)))


def _envelope(voice: Voice, t: np.ndarray) -> np.ndarray:
    elapsed = t - voice.onset_seconds
    if voice.attack_seconds > 0:
        attack = np.clip(elapsed / voice.attack_seconds, 0.0, 1.0)
    else:
        attack = (elapsed >= 0).astype(np.float64)
    if voice.decay_seconds is None:
        return attack
    return attack * np.exp(-np.maximum(elapsed, 0) / voice.decay_seconds)


def render(
    case: Case, sample_rate: int = 48_000, duration_s: float = 1.0,
    *, low_hz: float = 20.0, high_hz: float = 8_000.0,
    curvature: float = 1.0, invert: float = 0.0, mode: str = "fold",
    seed: int = 20261013,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    """Return (dry stereo, known-partial processed oracle or None, input IF tracks).

    An oracle uses known independent partial tracks integrated under the target
    map while preserving each partial's explicit channel level and phase offset.
    The phase offset is *not* a physical interchannel time-delay model.
    Broadband noise has no oracle output since noise's component assignment is
    underdetermined; a later experiment must evaluate residual handling.
    """
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("sample_rate must be a positive int")
    if not np.isfinite(duration_s) or duration_s <= 0:
        raise ValueError("duration_s must be positive")
    length = int(round(sample_rate * duration_s))
    if length < 2:
        raise ValueError("need at least two samples")
    t = np.arange(length, dtype=np.float64) / sample_rate
    dry = np.zeros((length, 2), dtype=np.float64)
    expected = None if case.broadband_noise else np.zeros_like(dry)
    paths = []
    for voice in case.voices:
        f = frequency_path(voice, t, duration_s)
        f_target = map_frequency(f, low_hz, high_hz, curvature, invert, mode)
        input_phi = _phase(f, sample_rate)
        output_phi = _phase(f_target, sample_rate)
        envelope = _envelope(voice, t)
        gains = ((voice.gain_left, voice.phase_left), (voice.gain_right, voice.phase_right))
        for c, (gain, offset) in enumerate(gains):
            dry[:, c] += gain * envelope * np.cos(input_phi + offset)
            if expected is not None:
                expected[:, c] += gain * envelope * np.cos(output_phi + offset)
        paths.append(f)
    if case.broadband_noise:
        rng = np.random.default_rng(seed)
        n = rng.standard_normal((length, 2))
        dry += np.column_stack((n[:, 0], .65*n[:, 0] + .35*n[:, 1])) * .08
    return dry, expected, np.stack(paths) if paths else np.empty((0, length))
