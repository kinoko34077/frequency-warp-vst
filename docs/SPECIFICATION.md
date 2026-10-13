# Frequency Warp VST — initial scope

## Objective
Develop a VST3 audio effect that explores spectral frequency transformations beyond conventional constant-Hz frequency shifting.

## Proposed transformations (research targets)
- Constant-Hz translation: f' = f + Δf.
- Frequency inversion around a configurable reference, including f' = C/f for f > 0.
- Continuous parameterized mappings between linear and logarithmic-style behavior, subject to mathematical and DSP feasibility.
- Sample-rate-aware handling of frequency ranges, DC and Nyquist boundaries.

## Engineering boundaries
- Separate mathematical frequency mapping from the DSP implementation.
- Evaluate latency, phase continuity, aliasing, artifacts, CPU usage and automation before selecting a DSP algorithm.
- Target VST3; framework, OS support, UI and distribution remain undecided.
- No claim that an ordinary frequency shifter alone implements arbitrary nonlinear spectral mapping.

## Initial milestones
1. Define exact transformations, control parameters and edge behavior.
2. Prototype offline DSP and objective audio tests.
3. Select a realtime-capable architecture.
4. Build and test VST3 prototype.

This is an initial research scope, not an approved complete product specification.
