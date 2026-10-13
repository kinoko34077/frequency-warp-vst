"""Reproducible R2.1 candidate-only corpus evaluation.

Usage: python -m research.evaluate_stft
Reports all six R2.0 fixtures with unaligned oracle errors; broadband noise
intentionally has NO mathematical waveform oracle.
"""
from __future__ import annotations

import json
import platform
import time

import numpy as np

from research.fixtures import corpus, render
from research.stft_candidate import stft_peak_warp


def _rms(samples):
    return float(np.sqrt(np.mean(np.asarray(samples)**2)))


def evaluate():
    sample_rate = 12_000
    duration = .5
    low, high = 20., 5000.
    curvature, invert, mode = .5, .75, "fold"
    n_fft, hop = 1024, 128
    result = {
        "status": "R2.1 research candidate, NOT engine acceptance",
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "platform": platform.platform(),
        },
        "sample_rate": sample_rate,
        "duration_s": duration,
        "low_hz": low,
        "high_hz": high,
        "curvature": curvature,
        "invert": invert,
        "mode": mode,
        "n_fft": n_fft,
        "hop": hop,
        "nominal_lookahead_samples": n_fft//2,
        "measured_host_latency": None,
        "peak_memory_bytes": None,
        "cases": [],
    }

    for case in corpus():
        dry, oracle, _ = render(
            case, sample_rate=sample_rate, duration_s=duration,
            low_hz=low, high_hz=high, curvature=curvature,
            invert=invert, mode=mode
        )
        start = time.perf_counter()
        processed, diagnostics = stft_peak_warp(
            dry, sample_rate, low_hz=low, high_hz=high,
            curvature=curvature, invert=invert, mode=mode,
            n_fft=n_fft, hop=hop
        )
        elapsed = time.perf_counter() - start
        case_report = {
            "case": case.name,
            "elapsed_seconds": elapsed,
            "wall_time_over_duration": elapsed/duration,
            "rms_gain_relative_dry": _rms(processed)/max(_rms(dry), 1e-12),
            "output_lr_correlation": (
                float(np.corrcoef(processed.T)[0, 1])
                if np.std(processed[:, 0]) > 0 and np.std(processed[:, 1]) > 0
                else None
            ),
            "diagnostics": diagnostics,
            "oracle_available": oracle is not None,
            "oracle_relative_rmse_no_alignment": (
                _rms(processed-oracle)/max(_rms(oracle), 1e-12)
                if oracle is not None else None
            ),
        }
        result["cases"].append(case_report)

    return result


if __name__ == "__main__":
    print(json.dumps(evaluate(), indent=2, ensure_ascii=False))
