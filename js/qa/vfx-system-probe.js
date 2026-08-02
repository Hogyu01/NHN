import { freezeDeep } from "../core/result.js";
import { VfxSystem } from "../render/vfx-system.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id, description, validates, status: "FAIL", error: error instanceof Error ? error.message : String(error),
    });
  }
}

const SHEET = {
  vfxSheet: { width: 768, height: 512, columns: 3, rows: 2, frameWidth: 256, frameHeight: 256, frameCount: 6 },
  vfx: [{ id: "vfx.sale_success", fps: 12, anchor: "CENTER" }],
};

export async function runVfxSystemProbe() {
  const results = [];

  results.push(await runCase(
    "spawn-and-immediate-update-shows-frame-0",
    "spawn 직후(0ms 경과)에는 첫 프레임을 돌려준다",
    "design 11.1 vfxContainer",
    () => {
      const vfx = new VfxSystem(SHEET);
      vfx.spawn({ vfxId: "vfx.sale_success", x: 100, y: 200, atMs: 1000 });
      const active = vfx.update(1000);
      assert(active.length === 1, "활성 vfx가 1개여야 합니다.");
      assert(active[0].frame.x === 0 && active[0].frame.y === 0, "첫 프레임이 아닙니다.");
      assert(active[0].x === 100 && active[0].y === 200, "위치가 다릅니다.");
      return { active };
    },
  ));

  results.push(await runCase(
    "expires-after-duration",
    "frameCount/fps로 계산한 재생 시간이 지나면 목록에서 사라진다",
    "design 11.1 결과 중립 VFX",
    () => {
      const vfx = new VfxSystem(SHEET);
      vfx.spawn({ vfxId: "vfx.sale_success", x: 0, y: 0, atMs: 0 });
      const durationMs = Math.ceil((6 / 12) * 1000);
      const beforeEnd = vfx.update(durationMs - 1);
      const afterEnd = vfx.update(durationMs + 1);
      assert(beforeEnd.length === 1, "재생 시간 안에는 살아있어야 합니다.");
      assert(afterEnd.length === 0, "재생 시간이 지났는데 남아 있습니다.");
      return { durationMs };
    },
  ));

  results.push(await runCase(
    "multiple-instances-independent",
    "여러 개를 동시에 spawn해도 서로 다른 instanceId로 독립적으로 관리된다",
    "design 11.1",
    () => {
      const vfx = new VfxSystem(SHEET);
      const a = vfx.spawn({ vfxId: "vfx.sale_success", x: 0, y: 0, atMs: 0 });
      const b = vfx.spawn({ vfxId: "vfx.sale_success", x: 10, y: 10, atMs: 0 });
      assert(a !== b, "instanceId가 겹칩니다.");
      assert(vfx.update(0).length === 2, "둘 다 활성 상태여야 합니다.");
      return { a, b };
    },
  ));

  results.push(await runCase(
    "unknown-vfx-id-is-noop",
    "정의되지 않은 vfxId는 조용히 무시하고(null) 아무것도 추가하지 않는다",
    "design 11.1",
    () => {
      const vfx = new VfxSystem(SHEET);
      const result = vfx.spawn({ vfxId: "vfx.unknown", x: 0, y: 0, atMs: 0 });
      assert(result === null, "null이 아닙니다.");
      assert(vfx.update(0).length === 0, "아무것도 없어야 합니다.");
      return { result };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
