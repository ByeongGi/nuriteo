const greeting = "안녕하세요";
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
