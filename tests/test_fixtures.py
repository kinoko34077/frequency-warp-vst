import unittest

import numpy as np

from research.fixtures import corpus, render
from research.reference import map_frequency


class R2FixturesTests(unittest.TestCase):
    def test_manifest_unique_and_reproducible(self):
        names = [case.name for case in corpus()]
        self.assertEqual(len(names), len(set(names)))
        for case in corpus():
            first = render(case, sample_rate=8000, duration_s=.4, high_hz=3500)
            second = render(case, sample_rate=8000, duration_s=.4, high_hz=3500)
            np.testing.assert_array_equal(first[0], second[0])
            if first[1] is not None:
                np.testing.assert_array_equal(first[1], second[1])

    def test_identity_oracle_matches_dry(self):
        for case in corpus():
            if case.broadband_noise:
                continue
            dry, expected, _ = render(case, sample_rate=12000, duration_s=.2,
                                      invert=0, high_hz=5000)
            np.testing.assert_array_equal(expected, dry)

    def test_target_is_known_warp_of_each_partial(self):
        case = next(c for c in corpus() if c.name == "crossing_chirps")
        _, target, sources = render(case, sample_rate=12000, duration_s=.25,
                                     high_hz=5000, curvature=0.4, invert=0.7)
        self.assertEqual(sources.shape, (2, 3000))
        self.assertIsNotNone(target)
        for source in sources:
            mapped = map_frequency(source, 20, 5000, .4, .7)
            self.assertTrue(np.all(np.isfinite(mapped)))
            self.assertLess(np.max(np.abs(np.diff(mapped))), 3.0)

    def test_stereo_is_known_phase_offset_not_time_delay(self):
        case = next(c for c in corpus() if c.name == "steady_tone")
        _, target, _ = render(case, invert=1, curvature=1,
                              low_hz=20, high_hz=8000)
        spectrum = np.fft.rfft(target, axis=0)
        k = 8020 - 900
        phase = np.angle(spectrum[k, 1] / spectrum[k, 0])
        self.assertAlmostEqual(phase, .5, places=8)
        self.assertAlmostEqual(abs(spectrum[k, 1] / spectrum[k, 0]), .52/.7, places=8)

    def test_noise_has_no_oracle_claim(self):
        case = next(c for c in corpus() if c.broadband_noise)
        dry, expected, paths = render(case, sample_rate=8000, duration_s=.1,
                                       high_hz=3500)
        self.assertIsNone(expected)
        self.assertEqual(paths.shape, (0, 800))
        self.assertGreater(np.std(dry), .01)


if __name__ == "__main__":
    unittest.main()
