import React from "react";
import { createRoot } from "react-dom/client";
import { label } from "./message.js";
import "./style.css";

const state = globalThis.__fixtureState ??= { count: 1 };
const root = createRoot(document.getElementById("root"));
let currentLabel = label;

function App() {
  return React.createElement("main", { id: "app" }, `${currentLabel}:${state.count}`);
}

function render() {
  root.render(React.createElement(App));
}

render();

if (import.meta.hot) {
  import.meta.hot.accept("./message.js", (module) => {
    currentLabel = module.label;
    render();
  });
}
