"""Deterministic R0/R1 reference tests; run: python -m unittest discover -s tests -v"""

import unittest

import numpy as np

from research.reference import analytic_signal, linear_direct_transform, map_frequency, mix_wet


class MappingTests(unittest.TestCase):
    low, high = 20.0, 20_000.0

    def test_curvature_endpoints_and_inverse(self):
        frequency = np.linspace(self.low, self.high, 503)
        for p in (0.0, 1e-10, .01, .25, .5, .9, 1.0):
            reversed_ = map_frequency(frequency, self.low, self.high, p)
            self.assertLessEqual(abs(reversed_[0] - self.high), 1e-8)
            self.assertLessEqual(abs(reversed_[-1] - self.low), 1e-8)
            self.assertTrue(np.all(np.diff(reversed_) < 0))
            self.assertTrue(np.allclose(map_frequency(reversed_, self.low, self.high, p), frequency, atol=1e-7))

    def test_known_log_linear(self):
        values = np.array([20.0, 100.0, 1_000.0, 10_000.0, 20_000.0])
        np.testing.assert_allclose(map_frequency(values, 20, 20_000, 0), 400_000/values, rtol=1e-12)
        np.testing.assert_allclose(map_frequency(values, 20, 20_000, 1), 20020-values, rtol=1e-12)

    def test_fold_identity_reflection_and_range(self):
        freq = np.linspace(self.low, self.high, 777)
        for p in (0, .5, 1):
            np.testing.assert_allclose(map_frequency(freq, self.low, self.high, p, 0), freq)
            np.testing.assert_allclose(map_frequency(freq, self.low, self.high, p, 1), map_frequency(freq, self.low, self.high, p), atol=1e-8)
            for a in (0.1, 0.25, .5, .75, .9):
                mapped = map_frequency(freq, self.low, self.high, p, a)
                self.assertTrue(np.all(np.isfinite(mapped)))
                self.assertTrue(np.all((mapped>=self.low) & (mapped<=self.high)))

    def test_fold_not_collapsed_at_halfway(self):
        frequencies = np.linspace(self.low, self.high, 1001)
        folded = map_frequency(frequencies, self.low, self.high, 1, .5)
        blended = map_frequency(frequencies, self.low, self.high, 1, .5, mode="blend")
        self.assertGreater(np.ptp(folded), 9_000)
        self.assertLess(np.ptp(blended), 1e-8)

    def test_blend_compresses_near_halfway(self):
        f = np.array([1_000.0, 2_000.0])
        result = map_frequency(f, 20, 20_000, 1, .45, "blend")
        self.assertAlmostEqual(result[1] - result[0], 100.0)

    def test_invalid_domain_rejected(self):
        for kw in ({"low_hz": 0, "high_hz": 2000}, {"low_hz": 1000, "high_hz": 1000}, {"low_hz": 10, "high_hz": 2000, "invert": 1.5}, {"low_hz": 10, "high_hz": 2000, "curvature": -.1}):
            with self.assertRaises(ValueError):
                map_frequency(1000, **kw)
        with self.assertRaises(ValueError):
            map_frequency(3000, 20, 2000)


class OfflineDSPTests(unittest.TestCase):
    fs = 48_000
    n = 48_000

    @staticmethod
    def strongest_bins(x, count=2):
        powers = np.abs(np.fft.rfft(x))
        idx = np.argsort(powers[1:])[-count:]+1
        return set(idx)

    def test_analytic_real_identity(self):
        t = np.arange(self.n)/self.fs
        x = np.sin(2*np.pi*1250*t)
        np.testing.assert_allclose(analytic_signal(x).real, x, atol=1e-11)

    def test_shift_tones(self):
        t = np.arange(self.n)/self.fs
        x = np.sin(2*np.pi*1200*t) + .4*np.sin(2*np.pi*1900*t+.2)
        y = linear_direct_transform(x, self.fs, shift_hz=300)
        self.assertEqual(self.strongest_bins(y), {1500,2200})
        self.assertAlmostEqual(np.sqrt(np.mean(y*y)), np.sqrt(np.mean(x*x)), places=8)

    def test_inversion_multitone(self):
        t = np.arange(self.n)/self.fs
        x = .7*np.sin(2*np.pi*1200*t+.3) + .2*np.sin(2*np.pi*2400*t-.2)
        y = linear_direct_transform(x, self.fs, reflection_sum_hz=10000)
        self.assertEqual(self.strongest_bins(y), {8800,7600})
        self.assertAlmostEqual(np.sqrt(np.mean(y*y)), np.sqrt(np.mean(x*x)), places=8)

    def test_chirp_frequency_path(self):
        t = np.arange(self.n)/self.fs
        initial, slope, center = 1200., 1400., 10000.
        x = np.sin(2*np.pi*(initial*t + .5*slope*t*t))
        y = linear_direct_transform(x, self.fs, reflection_sum_hz=center)
        # FFT Hilbert assumes a periodic segment; analyze central 60%, not edges.
        analytic = analytic_signal(y)
        instant = np.diff(np.unwrap(np.angle(analytic)))*self.fs/(2*np.pi)
        time_mid = (np.arange(self.n-1)+.5)/self.fs
        valid = (time_mid>.2) & (time_mid<.8)
        expected = center - (initial+slope*time_mid)
        self.assertLess(np.median(np.abs(instant[valid]-expected[valid])), 2.0)

    def test_stereo_phase_conjugation_is_explicit(self):
        t = np.arange(self.n)/self.fs
        left = np.cos(2*np.pi*1000*t)
        right = .7*np.cos(2*np.pi*1000*t+.8)
        stereo = np.column_stack((left,right))
        converted = linear_direct_transform(stereo, self.fs, reflection_sum_hz=10000)
        spec = np.fft.rfft(converted, axis=0)
        phase_difference = np.angle(spec[9000,1]/spec[9000,0])
        self.assertAlmostEqual(phase_difference, -.8, places=8)
        self.assertAlmostEqual(np.abs(spec[9000,1]/spec[9000,0]), .7, places=8)

    def test_wet_extremes(self):
        a=np.array([0.2, -0.5, .4])
        b=np.array([.8, .5, -.4])
        np.testing.assert_array_equal(mix_wet(a, b, 0), a)
        np.testing.assert_array_equal(mix_wet(a, b, 1), b)
        np.testing.assert_allclose(mix_wet(a, b, .5), (a+b)/2)


if __name__ == "__main__":
    unittest.main()
