// The order of bridge listeners and the promise jobs they queue. In Edge each page event is its own message task, so
// its jobs run before the next event's listeners.
import { bridge } from "../../../packages/three-native/src/bridge.js";

const order = [];
bridge.onEvent(event => { order.push(`${event.type}-A`); Promise.resolve().then(() => order.push(`${event.type}-A-job`)); });
bridge.onEvent(event => order.push(`${event.type}-B`));
globalThis.__report = () => console.log(`R ui-jobs: ${order.join('|')}`);
