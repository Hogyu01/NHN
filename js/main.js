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

const player = { x: 240, y: 240, r: 14, speed: 2.5, dir: "down", moving: false };
const keys = {};
let panelOpen = false;
let currentZoneId = null;

// LPC 워크사이클 스프라이트: 64x64 프레임, 9열 x 4행 (0=위, 1=왼쪽, 2=아래, 3=오른쪽)
const playerSprite = new Image();
playerSprite.src = "assets/sprites/player_walk.png";
const FRAME_SIZE = 64;
const DIR_ROW = { up: 0, left: 1, down: 2, right: 3 };
let animFrame = 1;
let animTimer = 0;
const ANIM_SPEED = 120; // ms per frame
let lastTime = 0;

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

  player.moving = dx !== 0 || dy !== 0;

  if (player.moving) {
    const len = Math.hypot(dx, dy);
    player.x += (dx / len) * player.speed;
    player.y += (dy / len) * player.speed;

    // 이동 방향에 따라 바라보는 방향 갱신 (세로 이동 우선)
    if (dy < 0) player.dir = "up";
    else if (dy > 0) player.dir = "down";
    else if (dx < 0) player.dir = "left";
    else if (dx > 0) player.dir = "right";
  }

  // 벽 충돌 (캔버스 경계)
  player.x = Math.max(player.r, Math.min(canvas.width - player.r, player.x));
  player.y = Math.max(player.r, Math.min(canvas.height - player.r, player.y));

  // 상호작용 구역 접근 확인 (구역에 "새로 들어왔을 때"만 패널을 엽니다.
  // 같은 구역에 계속 서 있으면 다시 열리지 않고, 구역을 벗어났다가 다시 들어와야 재오픈됩니다.)
  let insideZone = null;
  for (const zone of ZONES) {
    if (rectContains(zone, player.x, player.y)) {
      insideZone = zone;
      break;
    }
  }

  if (insideZone) {
    if (insideZone.id !== currentZoneId) {
      currentZoneId = insideZone.id;
      openPanel(insideZone);
    }
  } else {
    currentZoneId = null;
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

  // 발밑 그림자 (입체감)
  ctx.beginPath();
  ctx.ellipse(player.x, player.y + 20, 14, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fill();

  // 플레이어 그리기 (LPC 스프라이트)
  const row = DIR_ROW[player.dir];
  const col = player.moving ? animFrame : 0;
  if (playerSprite.complete && playerSprite.naturalWidth > 0) {
    ctx.drawImage(
      playerSprite,
      col * FRAME_SIZE, row * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE,
      player.x - FRAME_SIZE / 2, player.y - FRAME_SIZE / 2, FRAME_SIZE, FRAME_SIZE
    );
  }
}

function gameLoop(time) {
  const delta = time - lastTime;
  lastTime = time;

  updatePlayer();

  // 걷기 애니메이션 프레임 진행
  if (player.moving) {
    animTimer += delta;
    if (animTimer > ANIM_SPEED) {
      animTimer = 0;
      animFrame = animFrame >= 8 ? 1 : animFrame + 1;
    }
  } else {
    animFrame = 1;
    animTimer = 0;
  }

  draw();
  requestAnimationFrame(gameLoop);
}
