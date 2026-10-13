import { label } from "./message";
import "./style.css";

const state = (window as unknown as { __fixtureState?: { count: number } }).__fixtureState ?? { count: 0 };
(window as unknown as { __fixtureState: { count: number } }).__fixtureState = state;
state.count += 1;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing app root");

function render() {
  app.textContent = `${label}:${state.count}`;
}

render();

if (import.meta.hot) {
  import.meta.hot.accept("./message", (next) => {
    if (next) {
      app.textContent = `${next.label}:${state.count}`;
    }
  });
}
