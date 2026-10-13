import { createApp, h } from "vue";
import "./style.css";
import { label } from "./message.js";

globalThis.__fixtureState ||= { count: 1 };

let currentLabel = label;
const app = createApp({
  render() {
    return h("div", { id: "app" }, `${currentLabel}:${globalThis.__fixtureState.count}`);
  }
});

const instance = app.mount("#root");

if (import.meta.hot) {
  import.meta.hot.accept("./message.js", (module) => {
    currentLabel = module.label;
    instance.$forceUpdate();
  });
}
