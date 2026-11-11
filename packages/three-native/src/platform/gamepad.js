// The Gamepad API over the host's gamepads in the standard mapping. As in Edge, a page sees no gamepad until one has
// a button pressed or a stick pushed past half way, and each update is a new snapshot.
import { Event } from './events.js';
import { logOnce } from './dom.js';

// Edge's pressed threshold for the analog triggers, buttons 6 and 7, from XInput's 30 of 255.
const TRIGGER_THRESHOLD = 30 / 255;
const SLOTS = 8;

export class GamepadButton {
  constructor(value, analog) {
    this.value = value;
    this.pressed = analog ? value > TRIGGER_THRESHOLD : value > 0;
    this.touched = this.pressed || value > 0;
  }
}
export class GamepadHapticActuator {
  get type() { return 'dual-rumble'; }
  get effects() { return ['dual-rumble', 'trigger-rumble']; }
  playEffect() { logOnce('GamepadHapticActuator.playEffect is not implemented; no rumble plays'); return Promise.resolve('complete'); }
  reset() { return Promise.resolve('complete'); }
}
export class Gamepad {
  constructor({ index, id, buttons, axes }, timestamp, actuator) {
    this.id = id;
    this.index = index;
    this.connected = true;
    this.mapping = 'standard';
    this.timestamp = timestamp;
    this.axes = Object.freeze([...axes]);
    this.buttons = Object.freeze(buttons.map((value, i) => new GamepadButton(value, i === 6 || i === 7)));
    this.vibrationActuator = actuator;
    this.hapticActuators = [];
  }
}
export class GamepadEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.gamepad = init.gamepad ?? null;
  }
}

const gesture = pad => pad.buttons.some((value, i) => value > ((i === 6 || i === 7) ? TRIGGER_THRESHOLD : 0)) || pad.axes.some(value => Math.abs(value) > 0.5);

export class Gamepads {
  constructor(window) {
    this.window = window;
    this.slots = new Array(SLOTS).fill(null);
    this.actuators = new Map();
    this.exposed = false;
  }
  getGamepads() { return this.exposed ? [...this.slots] : new Array(SLOTS).fill(null); }
  // Applies the host's snapshot of every connected gamepad, at `now` ms.
  update(pads, now) {
    const previous = this.slots;
    this.slots = new Array(SLOTS).fill(null);
    for (const pad of pads) {
      if (pad.index >= SLOTS) continue;
      const old = previous[pad.index];
      const same = old && old.id === pad.id && old.axes.every((value, i) => value === pad.axes[i]) && old.buttons.every((button, i) => button.value === pad.buttons[i]);
      if (!this.actuators.has(pad.index)) this.actuators.set(pad.index, new GamepadHapticActuator());
      this.slots[pad.index] = same ? old : new Gamepad(pad, now, this.actuators.get(pad.index));
    }
    const wasExposed = this.exposed;
    if (!this.exposed && pads.some(gesture)) this.exposed = true;
    if (!this.exposed) return;
    for (let i = 0; i < SLOTS; i++) {
      const old = wasExposed ? previous[i] : null;
      const next = this.slots[i];
      if (old && (!next || next.id !== old.id)) {
        old.connected = false;
        this.window.dispatchEvent(new GamepadEvent('gamepaddisconnected', { gamepad: old }));
        this.actuators.delete(i);
      }
      if (next && (!old || next.id !== old.id)) this.window.dispatchEvent(new GamepadEvent('gamepadconnected', { gamepad: next }));
    }
  }
}
