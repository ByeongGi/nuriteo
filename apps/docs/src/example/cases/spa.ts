import type { ContainerCase } from "./types.ts";

const indexHtml = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>인사</title>
    <style>
      :root { color-scheme: light; }
      html, body { height: 100%; }
      body {
        box-sizing: border-box;
        margin: 0;
        padding: 1.5rem;
        overflow: auto;
        background: #f1f5f9;
        color: #18222b;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #app { width: 100%; }
      .card {
        padding: 1.25rem;
        background: #ffffff;
        border: 1px solid #e3eaf2;
        border-radius: 0.75rem;
      }
      .status { margin: 0; font-size: 0.75rem; color: #3566e8; }
      h1 { margin: 0.35rem 0 0; font-size: 1.5rem; font-weight: 650; letter-spacing: -0.02em; }
      .lead { margin: 0.5rem 0 1rem; color: #414e5b; line-height: 1.5; }
      form { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; }
      label { display: grid; gap: 0.35rem; flex: 1 1 12rem; min-width: 0; font-size: 0.875rem; color: #414e5b; }
      input {
        width: 100%;
        box-sizing: border-box;
        min-height: 2.5rem;
        padding: 0.5rem 0.7rem;
        border: 1px solid #cfd8e3;
        border-radius: 0.5rem;
        font: inherit;
        font-size: 1rem;
        color: inherit;
        background: #ffffff;
      }
      input:focus { outline: 2px solid #7393fa; outline-offset: 1px; }
      button {
        min-height: 2.5rem;
        padding: 0.5rem 0.9rem;
        border: 0;
        border-radius: 0.5rem;
        background: #3566e8;
        color: #ffffff;
        font: inherit;
        font-size: 1rem;
        font-weight: 600;
      }
      .empty { margin: 1rem 0 0; color: #414e5b; }
      .board { margin: 0.75rem 0 0; padding: 0; list-style: none; }
      .board li { margin: 0; padding: 0.7rem 0; border-top: 1px solid #e3eaf2; font-weight: 600; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

const mainJs = `const greeting = "안녕하세요";
const place = "누리터";
const action = "남기기";

const root = document.querySelector("#app");
root.innerHTML = '<section class="card"><p class="status">spa-ready</p><h1></h1><p class="lead"></p><form><label>이름 <input name="visitor" placeholder="지민" autocomplete="name" enterkeyhint="send" spellcheck="false"></label><button type="button"></button></form><p class="empty"></p><ul class="board"></ul></section>';

const title = root.querySelector("h1");
const lead = root.querySelector(".lead");
const input = root.querySelector("input");
const button = root.querySelector("button");
const empty = root.querySelector(".empty");
const board = root.querySelector(".board");
title.textContent = greeting;
lead.textContent = place + "에 온 사람에게 인사를 남깁니다.";
button.textContent = action;
empty.textContent = "아직 남긴 인사가 없습니다.";

function leaveGreeting() {
  const name = input.value.trim();
  if (!name) return;
  const item = document.createElement("li");
  item.textContent = greeting + ", " + name;
  board.appendChild(item);
  empty.hidden = true;
  input.value = "";
}

button.addEventListener("click", leaveGreeting);
input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  leaveGreeting();
});
`;

const packageJson = `{
  "name": "spa",
  "private": true
}
`;

export const containerCase = {
  kind: "spa",
  entry: "src/main.js",
  previewScript: null,
  files: [
    { path: "package.json", contents: packageJson },
    { path: "index.html", contents: indexHtml },
    { path: "src/main.js", contents: mainJs }
  ]
} satisfies ContainerCase;
