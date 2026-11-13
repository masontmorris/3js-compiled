# Native audio

The host runs a page's Web Audio on [web-audio-api-rs](https://github.com/orottier/web-audio-api-rs), which plays through WASAPI in shared mode on Windows. `packages/three-native/src/platform/audio.js` checks each call's arguments and throws Edge's errors, then hands the call to the engine through the ops in `crates/host/src/audio.rs`. `crates/audio` holds the engine's objects and decodes files. The rule is Edge's: for the same calls, the host renders the same samples and throws the same errors, within each lane's threshold in the plan's E7 section.

## Supported

- `AudioContext` and `OfflineAudioContext`, with `state`, `onstatechange`, `currentTime`, `sampleRate`, `baseLatency`, `outputLatency`, `getOutputTimestamp()`, `suspend()`, `resume()`, `close()`, `startRendering()`, `oncomplete`, `destination` and `listener`.
- `createGain`, `createBufferSource`, `createOscillator`, `createConstantSource`, `createStereoPanner`, `createPanner`, `createAnalyser`, `createBiquadFilter`, `createDelay`, `createBuffer` and `decodeAudioData`, with the matching node constructors and their options.
- `AudioNode.connect()` to a node or an `AudioParam`, and every form of `disconnect()`, with `channelCount`, `channelCountMode` and `channelInterpretation`.
- `AudioParam` `value`, `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime`, `setTargetAtTime`, `setValueCurveAtTime`, `cancelScheduledValues`, `cancelAndHoldAtTime` and `automationRate`. Event times land on the frame at `ceil(time * sampleRate)`, as Edge places them.
- `AudioBufferSourceNode` `buffer`, `loop`, `loopStart`, `loopEnd`, `playbackRate`, `detune` and `start(when, offset, duration)`. `OscillatorNode` with the four built-in types. `PannerNode` in `equalpower` and `HRTF` under each distance model, with the cone and the deprecated `setPosition` and `setOrientation`. `AudioListener` with its nine params and `setPosition` and `setOrientation`. `AnalyserNode` with its four reads.
- `AudioBuffer` with `getChannelData`, `copyFromChannel` and `copyToChannel`. A decoded buffer's samples stay in the engine until a page reads them, so playing one copies nothing.
- `XMLHttpRequest` for `file:`, `blob:` and `data:` URLs, with the `arraybuffer`, `blob`, `json` and `text` responses and Edge's order of `readystatechange` and progress events.
- `Audio` and `document.createElement('audio')`, with Edge's `canPlayType` answers for Howler's codec checks.

## Decoding

`decodeAudioData` decodes MP3, Ogg Vorbis, WAV and FLAC with Symphonia at the file's rate, on a worker thread. It converts the rate with a port of Chromium's `SincResampler` (`crates/audio/src/resample.rs`), with Chromium's output length of `(int)(length / (fileRate / contextRate))`. MP3 encoder delay and padding are trimmed from the LAME or Xing header, as Edge trims them. Edge ends an Ogg Vorbis file `min(delay, last packet's frames)` early, because FFmpeg adds the decoder delay to the end skip of the last packet and Chromium trims that buffer by it, or drops the buffer when the skip is longer. The decoder makes the same cut.

## Not supported

Each of these throws a `NotSupportedError` whose message names it, or returns a promise that rejects with one, and sound already playing keeps playing:

- `createMediaElementSource`, `createMediaStreamSource`, `createMediaStreamTrackSource`, `createMediaStreamDestination`, `createScriptProcessor`, `audioWorklet.addModule`, `setSinkId` and a `sinkId` option.
- `createPeriodicWave`, `OscillatorNode.setPeriodicWave`, `createConvolver`, `createWaveShaper`, `createDynamicsCompressor`, `createIIRFilter`, `createChannelSplitter`, `createChannelMerger` and `BiquadFilterNode.getFrequencyResponse`.
- `OfflineAudioContext.suspend` and `resume`, and nodes created on an offline context while it renders.
- Media playback on `Audio`: `play`, `pause` and `load`.
- Opus, AAC and other codecs Symphonia does not decode. `decodeAudioData` rejects them with `EncodingError`, although `canPlayType` answers as Edge does.

## Output

Nothing opens an audio device until a page creates an `AudioContext`. Each context starts `running` with no user gesture, as Edge does with `--autoplay-policy=no-user-gesture-required`.

- With no `--audio-device`, the host plays to the default output and follows it: a thread checks the default device every 200 ms and moves each context to a new default.
- `--audio-device <name>` plays to the output with that name, as Windows lists it, such as `Speakers (Steam Streaming Speakers)`. A name that matches no output fails the `AudioContext` constructor and logs the outputs. The host never falls back to another device. `none` renders with no device at all, which the host's tests use.
- `--audio-out <file.wav>` writes what each context hands the device, as 32-bit float, one file per context: `file.wav` for the first, `file-2.wav` for the second, and so on, since each context is its own device stream.
- `audio.csv` in the working directory has one row per 128-frame render quantum: the context, the device callback, its first context frame and the WAV frame it lands on, the quantum's render time, the callback's render time and its budget, the time since the previous callback, `late` and `underrun`. A callback underruns when its render took longer than its budget, the audio it hands the device; that is what Chromium's render capacity reports. A callback is late when it started more than twice the previous callback's length after it; the device's queued audio covers a late callback, so lateness is information, and whether the device ran dry shows in a loopback recording of it.

### Latency

The rule is lane 5's: once the context runs steadily, `baseLatency + outputLatency` on the lane's device is at most 50 ms, or Edge's lowest steady reading on the same device in the same session when that is higher. `tools/audio-parity/edge-latency.mjs` takes Edge's reading in headless Edge, muted, with the device chosen by `sinkId`. `baseLatency` is the device period and `outputLatency` is what WASAPI holds queued plus the device's own latency, so both depend on the device more than on the engine.

| Run | Device | Host at start | Host steady | Edge at start | Edge steady | Limit |
| --- | --- | --- | --- | --- | --- | --- |
| Lane 5 at 0b20cfd | Speakers (Steam Streaming Speakers) | 0.051 s | 0.044 s | 0.010 s | 0.052, 0.063, 0.071 s | 0.052 s |

All readings in this table were taken on MASON-DESKTOP, host and Edge on the same device in the same session.
| Probe, Edge only | Edge's default output | | | 0.010 s | 0.050 s | |

Edge reports an `outputLatency` of 0 until its device reports one, so its reading at start is `baseLatency` alone. The `context-start` scenario's "latency under 50 ms" row reads at startup, on different devices, so it is information only.

## The game thread

A busy game changes its graph every frame: Howler and three.js move panners and set gains through `AudioParam`, and read `currentTime` to time them. Two things keep that off the game thread's budget, without changing what the page sees:

- `platform/index.js` queues `AudioParam` automation, property sets, connections and source starts and stops, in order, and sends them to the engine in one `op_audio_batch` call when the task turn's promise jobs run, which is before the frame ends, or before any other audio call, so each call sees the changes made before it. `audio_changes_made_in_a_frame_reach_the_engine_in_one_call_before_it_ends` in `crates/host/src/game.rs` checks both.
- An online context's `currentTime` is the frame count the render thread publishes, in render quanta, to a `SharedArrayBuffer` the context's page holds, as each render quantum begins. Reading it is an `Atomics.load`, not a call into the engine, and it advances by render quantum, as Chrome's does. `Graph::online` writes the count the engine has already reached before the observer goes on, so a read in the same task as the constructor is the engine's time too. `audio_current_time_is_the_engines_and_advances_by_render_quantum` checks it against the engine's own value.

## HRTF

HRTF panning uses Chromium's composite IRCAM set, the one Edge uses, in `crates/audio/hrir/chromium/Composite.flac`, copied unchanged from chromium/chromium at `09931c1f02320a1b1175af4f338c992c02342f89`, path `third_party/blink/renderer/platform/audio/resources/`. `threejsc_audio::init()` converts each response to the context's rate with the ported Chromium resampler, and the engine renders with a port of Chromium's `HRTFPanner`: kernels with their group delay taken out, 7 kernels interpolated between each pair of measured azimuths, the measured elevation at or below the source, per-ear delay lines, overlap-add convolvers, and a 2048-frame crossfade when the kernel changes. Replacing the file swaps the set, with no code change.

The responses come from IRCAM's LISTEN HRTF database, measured by IRCAM's Room Acoustics Team, Olivier Warusfel, in the LISTEN project with AKG. IRCAM's pages state no terms. The copy of the terms libmysofa ships with LISTEN data, in [`tests/LICENSE.LISTEN_1002_IRC_1002_C_HRIR`](https://github.com/hoene/libmysofa/blob/main/tests/LICENSE.LISTEN_1002_IRC_1002_C_HRIR), reads: "The Listen database is public and available for any use. We would however appreciate an acknowledgment of the database somewhere in the description of your work (e.g. paper) or in your development." Chromium and WebKit ship these files without a separate license. The operator chose on 2026-11-12 to ship them on those terms, the footing on which web-audio-api-rs ships LISTEN subject 1003. `crates/audio/hrir/chromium/NOTICE` carries the acknowledgement, the terms and the sources.

## Engine patches

`third_party/web-audio-api` is web-audio-api-rs at upstream main `40402e2` with the patches in `third_party/web-audio-api.patches`. `node tools/vendor/web-audio-api.mjs` rebuilds it, and `--check` fails when it drifts. Each patch's message says what it changes and why:

1. Event boundaries at `ceil(time * sampleRate)`, as Chromium places them.
2. A loop started at or past `loopEnd` starts at `loopStart`.
3. The cone angle measured from the source to the listener.
4. A render observer on `AudioContext`, for `--audio-out` and `audio.csv`.
5. An unknown output device is an error, never the default device.
6. `baseLatency` is the device period, the shortest callback, as Chromium reports it.
7. HRTF directions mapped onto the HRIR sphere's axes. The engine had swapped two, so horizontal sources were looked up on the sphere's vertical circle.
8. `set_hrtf_responses()` and the port of Chromium's HRTF panner.
9. `RenderObserver::frame()`, which sees the frame count as each render quantum begins, so the host can publish `currentTime`.
10. Leave the built-in HRTF database to the first panner that needs it, so making a context no longer loads a set the host never uses.

## Checks

- `cargo test -p threejsc-audio --test offline` renders every reference graph and decode case in `crates/audio/tests/graphs.json` with the engine and compares it with Edge's render. `modal run tools/modal/lanes.py::audio_offline` runs it on Linux.
- `npm test -w packages/three-native` runs `test/audio.test.js`, which plays `tools/audio-parity/scenarios.mjs` against the shims with a fake engine and compares each log with Edge's in `tools/audio-parity/scenarios.edge.json`.
- `node tools/audio-parity/edge.mjs <dir>` renders the reference graphs in headless Edge, muted. `node tools/audio-parity/edge-scenarios.mjs` records Edge's scenario logs.
- `node tools/audio-parity/host.mjs graphs <edge dir> <out>` and `host.mjs scenarios <out>` run the same graphs and scenarios in the host, under the GPU lease. [native-audio-scenarios.md](native-audio-scenarios.md) is the scenario table, row by row.
- `node tools/audio-parity/gaps.mjs <expected.wav> <loopback.wav>` finds where a loopback recording of a virtual device leaves what the engine handed it: inserted silence, skipped frames, or a stretch that matches nothing. A virtual device runs on the engine's clock, so the two agree sample for sample apart from one lag and the endpoint volume. Lane 5 and every audio-on perf run check their recordings with it.
- `node tools/audio-parity/perf.mjs <out>` runs `examples/audio/stress.js`, 32 HRTF voices of seeded noise changed every frame, with audio on and off, under the GPU lease and `quiet_run.py`.
