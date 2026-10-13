"""R2.1 STFT candidate tests, including documented failure modes.

Deliberately do NOT assert perceptual fidelity or a correct output for noise.
Run with: python -m unittest discover -s tests -v
"""
import unittest

import numpy as np

from research.fixtures import corpus, render
from research.reference import map_frequency
from research.stft_candidate import stft_peak_warp


def analytic_signal(x):
    count = len(x)
    positive = np.zeros(count)
    positive[0] = 1
    positive[1:(count + 1)//2] = 2
    if count % 2 == 0:
        positive[count//2] = 1
    return np.fft.ifft(np.fft.fft(x) * positive)


class STFTCandidateTests(unittest.TestCase):
    sample_rate = 12000
    n = 6000

    def process(self, signal, **kwargs):
        settings = dict(low_hz=20, high_hz=5000, n_fft=1024, hop=128)
        settings.update(kwargs)
        return stft_peak_warp(signal, self.sample_rate, **settings)

    def test_stereo_tone_frequency_amplitude_and_phase_offset(self):
        t = np.arange(self.n) / self.sample_rate
        dry = np.column_stack((
            .7 * np.cos(2*np.pi*900*t),
            .52 * np.cos(2*np.pi*900*t + .5),
        ))
        processed, diagnostics = self.process(dry, curvature=1, invert=1)
        spectrum = np.fft.rfft(processed, axis=0)
        peak = int(np.argmax(np.abs(spectrum[:, 0])))
        self.assertAlmostEqual(peak * self.sample_rate/self.n, 4120, delta=2)
        spatial = spectrum[peak, 1] / spectrum[peak, 0]
        self.assertAlmostEqual(abs(spatial), .52/.7, delta=.01)
        self.assertAlmostEqual(np.angle(spatial), .5, delta=.03)
        self.assertGreater(np.std(processed[:, 0]) / np.std(dry[:, 0]), .94)
        self.assertGreater(diagnostics["relinked_peaks"], 0)

    def test_glide_mapped_frequency_trajectory(self):
        t = np.arange(self.n) / self.sample_rate
        dry = np.cos(2*np.pi*(900*t + 400*t*t))  # 900 -> 1300Hz / 0.5s
        processed, _ = self.process(dry, curvature=1, invert=1)
        instantaneous = np.diff(
            np.unwrap(np.angle(analytic_signal(processed)))
        ) * self.sample_rate / (2*np.pi)
        centers = (np.arange(len(instantaneous))+.5)/self.sample_rate
        valid = (centers > .15) & (centers < .35)
        oracle_path = 5020 - (900 + 800*centers)
        error = abs(instantaneous[valid] - oracle_path[valid])
        self.assertLess(np.median(error), 10)
        self.assertLess(np.quantile(error, .95), 22)
        self.assertGreater(
            np.sqrt(np.mean(processed**2)) / np.sqrt(np.mean(dry**2)), .8
        )

    def test_mid_fold_tone_not_constant_blend_collapse(self):
        t = np.arange(self.n) / self.sample_rate
        processed, _ = self.process(
            np.cos(2*np.pi*1000*t), curvature=1, invert=.5, mode="fold"
        )
        peak_hz = np.argmax(abs(np.fft.rfft(processed))) * self.sample_rate/self.n
        target = float(map_frequency(1000, 20, 5000, 1, .5))
        self.assertAlmostEqual(peak_hz, target, delta=3)

    def test_two_independent_partials_remain_audible(self):
        t = np.arange(self.n) / self.sample_rate
        x = .7*np.cos(2*np.pi*900*t) + .4*np.cos(2*np.pi*1700*t+.3)
        y, diagnostics = self.process(x, curvature=1, invert=1)
        spec = np.abs(np.fft.rfft(y))
        for frequency in (4120, 3320):
            self.assertGreater(spec[int(frequency*self.n/self.sample_rate)], 50)
        self.assertGreater(
            diagnostics["peak_count"], diagnostics["frames"]*1.5
        )

    def test_crossing_corpus_is_finite_but_not_oracle_claim(self):
        case = next(case for case in corpus() if case.name == "crossing_chirps")
        dry, oracle, _ = render(
            case, sample_rate=self.sample_rate, duration_s=.5,
            low_hz=20, high_hz=5000, curvature=.5, invert=.75,
        )
        actual, diagnostics = self.process(dry, curvature=.5, invert=.75)
        self.assertEqual(actual.shape, oracle.shape)
        self.assertTrue(np.all(np.isfinite(actual)))
        self.assertGreater(np.std(actual), .01)
        self.assertGreater(diagnostics["relinked_peaks"], 0)
        # This only establishes that the method runs; track swaps and collisions
        # remain a known unresolved quality problem.

    def test_noise_residual_loss_is_documented_failure(self):
        rng = np.random.default_rng(123)
        dry = rng.normal(0, .08, (self.n, 2))
        processed, diagnostics = self.process(dry, curvature=1, invert=1)
        self.assertTrue(np.all(np.isfinite(processed)))
        ratio = np.sqrt(np.mean(processed**2) / np.mean(dry**2))
        self.assertLess(ratio, .7)  # Deliberate FAILURE EVIDENCE, not success
        self.assertGreater(diagnostics["peak_count"], 0)

    def test_silence_invalid_domain_and_quality_parameters(self):
        dry = np.zeros(self.n)
        processed, _ = self.process(dry, curvature=.5, invert=.6)
        self.assertEqual(np.max(abs(processed)), 0)
        for kwargs in (
            {"high_hz": 6000}, {"invert": 1.1}, {"n_fft": 1025},
            {"hop": 1024}, {"mode": "unknown"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.process(dry, **kwargs)


if __name__ == "__main__":
    unittest.main()
