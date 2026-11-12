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
- `--audio-out <file.wav>` writes what each context hands the device, as 32-bit float, in the order the contexts ran.
- `audio.csv` in the working directory has one row per 128-frame render quantum: the context, the device callback, its first context frame and the WAV frame it lands on, the quantum's render time, the callback's render time and its budget, the time since the previous callback, and `underrun`. A callback underruns when it took longer than the audio it rendered lasts, or when it started more than twice its own length after the previous one.

## HRTF

HRTF panning uses the HRIR set in `crates/audio/hrir/sphere.bin`. It is IRCAM LISTEN subject 1003, the set the engine bundles. Edge uses Chromium's composite IRCAM set, so HRTF channel levels differ from Edge's by up to 5.74 dB, against lane 4's 1 dB rule. Replacing the file swaps the set, with no code change.

## Engine patches

`third_party/web-audio-api` is web-audio-api-rs at upstream main `40402e2` with the patches in `third_party/web-audio-api.patches`. `node tools/vendor/web-audio-api.mjs` rebuilds it, and `--check` fails when it drifts. Each patch's message says what it changes and why:

1. Event boundaries at `ceil(time * sampleRate)`, as Chromium places them.
2. A loop started at or past `loopEnd` starts at `loopStart`.
3. The cone angle measured from the source to the listener.
4. `set_hrir_sphere()`, the HRIR data seam.
5. A render observer on `AudioContext`, for `--audio-out` and `audio.csv`.
6. An unknown output device is an error, never the default device.

## Checks

- `cargo test -p threejsc-audio --test offline` renders every reference graph and decode case in `crates/audio/tests/graphs.json` with the engine and compares it with Edge's render. `modal run tools/modal/lanes.py::audio_offline` runs it on Linux.
- `npm test -w packages/three-native` runs `test/audio.test.js`, which plays `tools/audio-parity/scenarios.mjs` against the shims with a fake engine and compares each log with Edge's in `tools/audio-parity/scenarios.edge.json`.
- `node tools/audio-parity/edge.mjs <dir>` renders the reference graphs in headless Edge, muted. `node tools/audio-parity/edge-scenarios.mjs` records Edge's scenario logs.
- `node tools/audio-parity/host.mjs graphs <edge dir> <out>` and `host.mjs scenarios <out>` run the same graphs and scenarios in the host, under the GPU lease.
