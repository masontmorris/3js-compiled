# HRTF responses

`chromium/Composite.flac` is the head-related impulse response set every HRTF `PannerNode` uses: Chromium's composite IRCAM set, the one Edge uses, copied unchanged. `chromium/NOTICE` names its source, carries the acknowledgement IRCAM asks for and the LISTEN terms, and records the operator's decision to ship it.

`threejsc_audio::init()` decodes it, converts each response to the context's rate with Chromium's resampler, and hands the responses to the engine, which renders HRTF panning with its port of Chromium's HRTF panner. Swapping the set means replacing the file and rerunning lane 4. No code changes.
