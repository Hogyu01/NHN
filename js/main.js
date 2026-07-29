// 화면 전환

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("hidden", el.id !== screenId);
  });
}

document.getElementById("btn-start").addEventListener("click", () => {
  showScreen("screen-room");
  requestAnimationFrame(gameLoop);
});

// 캔버스 + 캐릭터 이동 + 상호작용 구역

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const ZONES = [
  { id: "board", label: "길드 게시판", x: 20, y: 20, w: 100, h: 80, color: "#4a6fa5", body: "(3단계에서 구현 예정)" },
  { id: "stove", label: "조리대", x: 360, y: 20, w: 100, h: 80, color: "#c9752f", body: "(5단계에서 구현 예정)" },
  { id: "counter", label: "카운터", x: 190, y: 380, w: 100, h: 80, color: "#5a9e6f", body: "(6단계에서 구현 예정)" },
];

const player = { x: 240, y: 240, r: 14, speed: 2.5 };
const keys = {};
let panelOpen = false;

window.addEventListener("keydown", (e) => { keys[e.key.toLowerCase()] = true; });
window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

function rectContains(rect, px, py) {
  return px > rect.x && px < rect.x + rect.w && py > rect.y && py < rect.y + rect.h;
}

function updatePlayer() {
  if (panelOpen) return;

  let dx = 0;
  let dy = 0;
  if (keys["arrowup"] || keys["w"]) dy -= 1;
  if (keys["arrowdown"] || keys["s"]) dy += 1;
  if (keys["arrowleft"] || keys["a"]) dx -= 1;
  if (keys["arrowright"] || keys["d"]) dx += 1;

  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    player.x += (dx / len) * player.speed;
    player.y += (dy / len) * player.speed;
  }

  // 벽 충돌 (캔버스 경계)
  player.x = Math.max(player.r, Math.min(canvas.width - player.r, player.x));
  player.y = Math.max(player.r, Math.min(canvas.height - player.r, player.y));

  // 상호작용 구역 접근 확인
  for (const zone of ZONES) {
    if (rectContains(zone, player.x, player.y)) {
      openPanel(zone);
      break;
    }
  }
}

function openPanel(zone) {
  panelOpen = true;
  document.getElementById("panel-title").textContent = zone.label;
  document.getElementById("panel-body").textContent = zone.body;
  document.getElementById("panel-overlay").classList.remove("hidden");
}

document.getElementById("btn-panel-close").addEventListener("click", () => {
  panelOpen = false;
  document.getElementById("panel-overlay").classList.add("hidden");
});

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 구역 그리기
  for (const zone of ZONES) {
    ctx.fillStyle = zone.color;
    ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
    ctx.fillStyle = "#f0f0f0";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(zone.label, zone.x + zone.w / 2, zone.y + zone.h / 2 + 5);
  }

  // 플레이어 그리기
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
  ctx.fillStyle = "#e0a458";
  ctx.fill();
}

function gameLoop() {
  updatePlayer();
  draw();
  requestAnimationFrame(gameLoop);
}
