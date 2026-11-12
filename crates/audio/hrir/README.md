# HRIR sphere

`sphere.bin` is the head-related impulse response set every HRTF `PannerNode` uses, in the `hrtf` crate's sphere format. `threejsc_audio::init()` hands it to the engine, so swapping the set means replacing this file and rerunning lane 4. No code changes.

The current file is IRCAM LISTEN subject 1003, compensated, the `IRC_1003_C.bin` that web-audio-api-rs bundles. It comes from the LISTEN HRTF database, measured by IRCAM's Room Acoustics Team (Olivier Warusfel). The database's terms ask for an acknowledgement in the work that uses it.

Edge uses a different set, Chromium's `IRC_Composite_C_R0195`. Its redistribution terms are unclear, so this repo doesn't ship it yet. With subject 1003, HRTF channel levels differ from Edge's by up to 5.74 dB, against lane 4's 1 dB rule.
