import {
  createAuthoredTableServiceTargets,
  createGuestOrderTarget,
  DYNAMIC_SERVICE_TARGET_KIND,
  normalizeDynamicServiceTarget,
  resolveDynamicServiceTarget,
} from "../world/dynamic-target-resolver.js";
import {
  createDynamicInteractionCommand,
  WORLD_INTERACTION_COMMAND_TYPE,
  WORLD_INTERACTION_ROUTE,
  WorldInteractionRouter,
} from "../world/interaction-router.js";
import {
  INPUT_CONTEXT,
  keyboardToLogicalInput,
  LOGICAL_INPUT_KIND,
  resolveInputContext,
} from "../ui/input-router.js";

const QA_ID = "world-interaction";
const PROPERTY = "Property 22: Player collision과 interaction semantics";
const VALIDATES = "Requirements 1.2, 1.3, 1.4, 11.1, 11.2, 11.3, 11.4, 21.4, 33.9, 33.12";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected=${String(expected)}, actual=${String(actual)})`);
  }
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runCases(specifications) {
  const results = [];
  for (const [id, description, validates, execute] of specifications) {
    results.push(await runCase(id, description, validates, execute));
  }
  return results;
}

function dynamicTarget({
  kind,
  targetId,
  entityId,
  x,
  y,
  radius = 200_000,
}) {
  return normalizeDynamicServiceTarget({
    kind,
    targetId,
    entityId,
    worldMilliPx: { x, y },
    proximityRadiusMilliPx: radius,
  });
}

function allPermutations(values) {
  if (values.length <= 1) return [values];
  const permutations = [];
  for (let index = 0; index < values.length; index += 1) {
    const head = values[index];
    const tail = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of allPermutations(tail)) permutations.push([head, ...suffix]);
  }
  return permutations;
}

function navigationWorld(point) {
  return Object.freeze({
    x: point.tileX * 32 + point.offsetX,
    y: point.tileY * 32 + point.offsetY,
  });
}

function dispatchKey(root, type, key, code = "") {
  root.defaultView.dispatchEvent(new root.defaultView.KeyboardEvent(type, {
    key,
    code,
    bubbles: true,
    cancelable: true,
  }));
}

function reportFrom(results) {
  const frozenResults = Object.freeze([...results]);
  const passed = frozenResults.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    property: PROPERTY,
    validates: VALIDATES,
    status: passed === frozenResults.length ? "PASS" : "FAIL",
    passed,
    total: frozenResults.length,
    results: frozenResults,
  });
}

/**
 * Generated Property 22 coverage over deterministic target-set permutations.
 * **Validates: Requirements 1.2, 1.3, 1.4, 11.1, 11.2, 11.3, 11.4, 21.4, 33.9, 33.12**
 */
export async function runWorldInteractionProbe({ baseMap }) {
  if (!baseMap || typeof baseMap !== "object") throw new TypeError("World interaction probe에는 Base Map이 필요합니다.");

  const results = await runCases([
    [
      "authored-table-target-normalization",
      "Base의 6개 authored table target을 World milli-pixel resolver 계약으로 변환한다",
      "Requirements 11.2, 33.9, 33.12",
      () => {
        const targets = createAuthoredTableServiceTargets(baseMap);
        assertEqual(targets.length, 6, "authored table target 수가 6이 아닙니다.");
        const first = targets[0];
        assertEqual(first.targetId, "service-target.01", "첫 authored target ID가 다릅니다.");
        assertEqual(first.entityId, "table.01", "table Entity_ID가 canonical table ID가 아닙니다.");
        assertEqual(first.worldMilliPx.x, 496_000, "첫 table target World X가 다릅니다.");
        assertEqual(first.worldMilliPx.y, 208_000, "첫 table target World Y가 다릅니다.");
        assertEqual(first.proximityRadiusMilliPx, 48_000, "authored proximity가 milli-pixel로 변환되지 않았습니다.");
        return { count: targets.length, first };
      },
    ],
    [
      "nearest-world-distance-first",
      "screen 정보 없이 exact World milli-pixel distance가 가장 가까운 대상을 고른다",
      "Requirements 11.2, 21.8, 33.12",
      () => {
        const targets = [
          dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER, targetId: "target.far", entityId: "entity.a", x: 50_000, y: 0 }),
          dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE, targetId: "target.near", entityId: "entity.z", x: 10_000, y: 0 }),
        ];
        const resolved = resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets });
        assertEqual(resolved.target?.targetId, "target.near", "priority가 더 가까운 World target을 덮었습니다.");
        assertEqual(resolved.distanceSquaredMilliPx, 100_000_000, "exact squared distance가 다릅니다.");
        return { selected: resolved.target.targetId, distanceSquaredMilliPx: resolved.distanceSquaredMilliPx };
      },
    ],
    [
      "guest-priority-on-distance-tie",
      "World 거리가 같으면 GUEST_ORDER=0이 TABLE_SERVICE=1보다 먼저다",
      "Requirements 11.2, 11.3, 11.4",
      () => {
        const targets = [
          dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE, targetId: "target.table", entityId: "entity.a", x: 30_000, y: 40_000 }),
          dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER, targetId: "target.guest", entityId: "entity.z", x: -30_000, y: -40_000 }),
        ];
        const resolved = resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets });
        assertEqual(resolved.target?.targetId, "target.guest", "distance tie에서 guest priority가 적용되지 않았습니다.");
        return { selected: resolved.target.targetId, priority: resolved.target.priority };
      },
    ],
    [
      "entity-id-lexical-final-tie",
      "거리와 kind가 같으면 Entity_ID lexical ascending으로 최종 결정한다",
      "Requirements 11.2, 33.12",
      () => {
        const targets = [
          dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER, targetId: "target.z", entityId: "entity.z", x: 0, y: 20_000 }),
          dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER, targetId: "target.a", entityId: "entity.a", x: 0, y: -20_000 }),
        ];
        const resolved = resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets });
        assertEqual(resolved.target?.entityId, "entity.a", "Entity_ID lexical tie-break가 적용되지 않았습니다.");
        return { selectedTargetId: resolved.target.targetId, selectedEntityId: resolved.target.entityId };
      },
    ],
    [
      "authored-proximity-boundary",
      "proximity 원주 경계는 포함하고 1 milli-pixel 밖은 제외한다",
      "Requirements 11.2, 33.9, 33.12",
      () => {
        const target = dynamicTarget({
          kind: DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE,
          targetId: "target.boundary",
          entityId: "table.boundary",
          x: 48_000,
          y: 0,
          radius: 48_000,
        });
        const boundary = resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets: [target] });
        const outside = resolveDynamicServiceTarget({ playerFootMilliPx: { x: -1, y: 0 }, targets: [target] });
        assertEqual(boundary.target?.targetId, target.targetId, "proximity 경계 target이 제외됐습니다.");
        assertEqual(outside.target, null, "proximity 밖 target이 선택됐습니다.");
        return { boundaryCode: boundary.code, outsideCode: outside.code };
      },
    ],
    [
      "generated-permutation-reproducibility",
      "128개 deterministic target fixture의 모든 insertion permutation과 반복 실행이 같은 target을 고른다",
      "Requirements 11.2, 31.6, 33.12",
      () => {
        let executions = 0;
        for (let seed = 0; seed < 128; seed += 1) {
          const targets = Array.from({ length: 4 }, (_, index) => {
            const x = ((((seed + 3) * (index + 5) * 37) % 181) - 90) * 1_000;
            const y = ((((seed + 11) * (index + 7) * 53) % 181) - 90) * 1_000;
            return dynamicTarget({
              kind: index % 2 === 0
                ? DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER
                : DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE,
              targetId: `target.generated.${seed}.${index}`,
              entityId: `entity.generated.${String(index).padStart(2, "0")}`,
              x,
              y,
              radius: 200_000,
            });
          });
          const expected = resolveDynamicServiceTarget({
            playerFootMilliPx: { x: 0, y: 0 },
            targets,
          }).target.targetId;
          for (const permutation of allPermutations(targets)) {
            const first = resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets: permutation });
            const repeated = resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets: permutation });
            assertEqual(first.target?.targetId, expected, `seed ${seed} insertion order가 결과를 바꿨습니다.`);
            assertEqual(repeated.target?.targetId, expected, `seed ${seed} 반복 결과가 달라졌습니다.`);
            executions += 2;
          }
        }
        return { generatedFixtures: 128, executions, randomDraws: 0 };
      },
    ],
    [
      "ambiguous-identity-rejection",
      "중복 target ID 또는 Entity_ID는 insertion order에 맡기지 않고 명시 거절한다",
      "Requirements 11.2, 31.6, 33.12",
      () => {
        const base = dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER, targetId: "target.dup", entityId: "entity.one", x: 0, y: 0 });
        const duplicateTarget = dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE, targetId: "target.dup", entityId: "entity.two", x: 1, y: 0 });
        const duplicateEntity = dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE, targetId: "target.other", entityId: "entity.one", x: 1, y: 0 });
        let targetError = null;
        let entityError = null;
        try {
          resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets: [base, duplicateTarget] });
        } catch (error) {
          targetError = error;
        }
        try {
          resolveDynamicServiceTarget({ playerFootMilliPx: { x: 0, y: 0 }, targets: [base, duplicateEntity] });
        } catch (error) {
          entityError = error;
        }
        assert(targetError?.message.includes("DUPLICATE_DYNAMIC_TARGET_ID"), "duplicate target ID가 명시 거절되지 않았습니다.");
        assert(entityError?.message.includes("DUPLICATE_DYNAMIC_ENTITY_ID"), "duplicate Entity_ID가 명시 거절되지 않았습니다.");
        return { targetError: targetError.message, entityError: entityError.message };
      },
    ],
    [
      "target-id-only-command-payload",
      "dynamic command payload는 stable targetId 하나만 포함하고 좌표를 포함하지 않는다",
      "Requirements 11.3, 11.4, 31.5, 33.12",
      () => {
        const target = dynamicTarget({ kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER, targetId: "target.command", entityId: "entity.command", x: 12_000, y: 34_000 });
        const command = createDynamicInteractionCommand(target);
        assertEqual(command.type, WORLD_INTERACTION_COMMAND_TYPE.GUEST_ORDER, "guest command type이 다릅니다.");
        assertEqual(JSON.stringify(Object.keys(command.payload)), JSON.stringify(["targetId"]), "command payload가 targetId-only가 아닙니다.");
        assertEqual(command.payload.targetId, target.targetId, "command target ID가 다릅니다.");
        const serialized = JSON.stringify(command);
        for (const forbidden of ["world", "screen", "client", "camera", "x\"", "y\""]) {
          assert(!serialized.toLowerCase().includes(forbidden), `command에 금지 좌표 정보가 포함됐습니다: ${forbidden}`);
        }
        return command;
      },
    ],
    [
      "static-dynamic-route-separation",
      "static transition은 panel sink만, action은 dynamic command sink만 호출한다",
      "Requirements 1.2, 1.3, 1.4, 11.1, 11.2",
      () => {
        const staticRequests = [];
        const commands = [];
        const router = new WorldInteractionRouter({
          mapDefinition: baseMap,
          onStaticOpen: (request) => staticRequests.push(request),
          onDynamicCommand: (command) => commands.push(command),
        });
        const staticRoute = router.routeStaticTransitions({
          openRequests: [
            { zoneId: "zone.storage", semantic: "storage" },
            { zoneId: "zone.board", semantic: "board" },
          ],
        });
        assertEqual(staticRoute.route, WORLD_INTERACTION_ROUTE.STATIC_ZONE_OPEN, "static route type이 다릅니다.");
        assertEqual(staticRequests.length, 1, "static transition이 정확히 한 panel request를 만들지 않았습니다.");
        assertEqual(staticRequests[0].zoneId, "zone.board", "overlap static tie가 zone ID lexical이 아닙니다.");
        assertEqual(commands.length, 0, "static enter가 dynamic command를 발행했습니다.");

        const firstTable = createAuthoredTableServiceTargets(baseMap)[0];
        const actionRoute = router.routeAction({
          playerFootMilliPx: firstTable.worldMilliPx,
          inputSource: "QA",
        });
        assertEqual(actionRoute.route, WORLD_INTERACTION_ROUTE.DYNAMIC_SERVICE_ACTION, "action route type이 다릅니다.");
        assertEqual(commands.length, 1, "action이 dynamic command 하나를 발행하지 않았습니다.");
        assertEqual(staticRequests.length, 1, "dynamic action이 static panel sink를 호출했습니다.");
        return { staticRoute: staticRoute.route, dynamicRoute: actionRoute.route, command: commands[0] };
      },
    ],
    [
      "input-context-priority",
      "입력 context는 modal → panel → Canvas → global 고정 우선순위를 따른다",
      "Requirements 21.4, 31.6",
      () => {
        const cases = [
          [{ modalOpen: true, panelOpen: true, canvasActive: true }, INPUT_CONTEXT.MODAL],
          [{ modalOpen: false, panelOpen: true, canvasActive: true }, INPUT_CONTEXT.PANEL],
          [{ modalOpen: false, panelOpen: false, canvasActive: true }, INPUT_CONTEXT.CANVAS],
          [{ modalOpen: false, panelOpen: false, canvasActive: false }, INPUT_CONTEXT.GLOBAL],
        ];
        for (const [input, expected] of cases) {
          assertEqual(resolveInputContext(input), expected, `input context ${expected} 우선순위가 다릅니다.`);
        }
        return { priority: cases.map(([, expected]) => expected) };
      },
    ],
    [
      "keyboard-logical-action-contract",
      "E/Enter/Space는 동일 ACTION logical command이고 key repeat 정보만 보존한다",
      "Requirements 11.1, 21.2, 21.3",
      () => {
        const actions = [
          keyboardToLogicalInput({ type: "keydown", key: "e" }),
          keyboardToLogicalInput({ type: "keydown", key: "Enter" }),
          keyboardToLogicalInput({ type: "keydown", key: " ", code: "Space" }),
        ];
        assert(actions.every((action) => action?.kind === LOGICAL_INPUT_KIND.ACTION), "action key가 ACTION으로 정규화되지 않았습니다.");
        assert(actions.every((action) => action.worldPoint === null), "keyboard action에 좌표가 포함됐습니다.");
        assertEqual(keyboardToLogicalInput({ type: "keyup", key: "e" }), null, "action keyup이 command를 만들었습니다.");
        return { keys: actions.map((action) => action.key), kind: LOGICAL_INPUT_KIND.ACTION };
      },
    ],
    [
      "display-coordinate-elision",
      "target normalization은 World milli-pixel만 보존하고 screen/client/camera 필드를 제거한다",
      "Requirements 21.8, 31.5, 33.11, 33.12",
      () => {
        const normalized = normalizeDynamicServiceTarget({
          kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER,
          targetId: "target.world-only",
          entityId: "entity.world-only",
          worldMilliPx: { x: 100_000, y: 200_000 },
          proximityRadiusMilliPx: 40_000,
          screenX: 1,
          clientX: 2,
          camera: { x: 3, y: 4 },
        });
        assertEqual(normalized.worldMilliPx.x, 100_000, "World X가 보존되지 않았습니다.");
        for (const field of ["screenX", "clientX", "camera"]) {
          assert(!Object.hasOwn(normalized, field), `display field가 normalized target에 남았습니다: ${field}`);
        }
        return normalized;
      },
    ],
  ]);

  return reportFrom(results);
}

function renderReport(root, report) {
  root.querySelector("#world-interaction-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "world-interaction-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");
  const heading = root.createElement("h2");
  heading.textContent = `World interaction: ${report.status}`;
  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과`;
  const list = root.createElement("ol");
  for (const result of report.results) {
    const item = root.createElement("li");
    item.className = result.status === "PASS" ? "qa-pass" : "qa-fail";
    item.textContent = `${result.status} — ${result.description}`;
    if (result.error) {
      const error = root.createElement("pre");
      error.textContent = result.error;
      item.append(error);
    }
    list.append(item);
  }
  section.append(heading, summary, list);
  root.body.append(section);
  root.body.dataset.worldInteractionQa = report.status.toLowerCase();
  root.body.dataset.worldInteractionQaPassed = String(report.passed);
  root.body.dataset.worldInteractionQaTotal = String(report.total);
  root.dispatchEvent(new CustomEvent("world-interaction:qa-complete", { detail: report }));
}

/** Browser integration over production InputRouter → WorldInteractionRouter wiring. */
export async function runWorldInteractionBrowserProbe({ root, hub, shell, baseMap }) {
  hub.stop();
  hub.setMapDefinition(baseMap);
  hub.activate();
  const pure = await runWorldInteractionProbe({ baseMap });
  const firstAuthored = createAuthoredTableServiceTargets(baseMap)[0];
  const firstApproach = navigationWorld(
    baseMap.navigation.approachPoints.find((point) => point.pointId === "approach.table.01"),
  );

  const browserResults = await runCases([
    [
      "browser-table-action-only",
      "table proximity 진입만으로 command가 없고 action key에서 targetId-only command가 발행된다",
      "Requirements 11.1, 11.2, 11.3, 11.4",
      () => {
        hub.reset();
        hub.setPlayerPosition(firstApproach.x, firstApproach.y);
        hub.step(0);
        assertEqual(hub.getInteractionSnapshot().commands.length, 0, "table proximity enter가 command를 자동 발행했습니다.");
        dispatchKey(root, "keydown", "e", "KeyE");
        const commands = hub.getInteractionSnapshot().commands;
        assertEqual(commands.length, 1, "E action이 table command 하나를 발행하지 않았습니다.");
        assertEqual(commands[0].type, WORLD_INTERACTION_COMMAND_TYPE.TABLE_SERVICE, "table command type이 다릅니다.");
        assertEqual(commands[0].payload.targetId, firstAuthored.targetId, "table target ID가 다릅니다.");
        assertEqual(JSON.stringify(Object.keys(commands[0].payload)), JSON.stringify(["targetId"]), "runtime table command가 targetId-only가 아닙니다.");
        return commands[0];
      },
    ],
    [
      "browser-static-enter-auto-open",
      "board/stove/counter/storage는 action key 없이 enter에서 panel을 열고 service command를 만들지 않는다",
      "Requirements 1.2, 1.3, 1.4, 11.1",
      () => {
        const opened = [];
        for (const zone of baseMap.zones) {
          hub.reset();
          hub.setPlayerPosition(zone.rect.x + zone.rect.width / 2, zone.rect.y + zone.rect.height + 6);
          const state = hub.getState();
          assert(state.panelOpen, `${zone.semantic} enter가 panel을 열지 않았습니다.`);
          assertEqual(state.activePanelZoneId, zone.semantic, `${zone.semantic} panel semantic이 다릅니다.`);
          assertEqual(state.interaction.commands.length, 0, `${zone.semantic} enter가 service command를 발행했습니다.`);
          opened.push(zone.semantic);
        }
        return { opened };
      },
    ],
    [
      "browser-guest-priority-runtime",
      "production hub에서 table과 같은 거리의 guest order target이 action 시 우선된다",
      "Requirements 11.2, 11.3, 11.4, 33.12",
      () => {
        hub.reset();
        hub.setPlayerPosition(firstApproach.x, firstApproach.y);
        hub.setGuestOrderTargets([createGuestOrderTarget({
          targetId: "guest-order-target.browser",
          entityId: "guest-entity.browser",
          footMilliPx: firstAuthored.worldMilliPx,
          proximityRadiusMilliPx: firstAuthored.proximityRadiusMilliPx,
          orderId: "order.browser",
        })]);
        dispatchKey(root, "keydown", "Enter", "Enter");
        const commands = hub.getInteractionSnapshot().commands;
        assertEqual(commands.length, 1, "guest action command가 정확히 하나가 아닙니다.");
        assertEqual(commands[0].type, WORLD_INTERACTION_COMMAND_TYPE.GUEST_ORDER, "guest priority가 runtime에서 적용되지 않았습니다.");
        assertEqual(commands[0].payload.targetId, "guest-order-target.browser", "guest target ID가 다릅니다.");
        return commands[0];
      },
    ],
    [
      "browser-panel-input-suppression",
      "panel context에서는 movement와 service action을 모두 소비하지 않는다",
      "Requirements 21.4, 31.6",
      () => {
        const zone = baseMap.zones.find((candidate) => candidate.semantic === "board");
        hub.reset();
        hub.setPlayerPosition(zone.rect.x + zone.rect.width / 2, zone.rect.y + zone.rect.height + 6);
        const before = hub.getState().player;
        assert(hub.panelOpen, "panel suppression fixture가 panel을 열지 못했습니다.");
        hub.setGuestOrderTargets([createGuestOrderTarget({
          targetId: "guest-order-target.panel",
          entityId: "guest-entity.panel",
          footMilliPx: before.footMilliPx,
          proximityRadiusMilliPx: 48_000,
        })]);
        hub.clearInteractionCommands();
        dispatchKey(root, "keydown", "d", "KeyD");
        dispatchKey(root, "keydown", "e", "KeyE");
        hub.step(16);
        dispatchKey(root, "keyup", "d", "KeyD");
        const after = hub.getState().player;
        assertEqual(after.x, before.x, "panel context에서 Player X가 움직였습니다.");
        assertEqual(after.y, before.y, "panel context에서 Player Y가 움직였습니다.");
        assertEqual(hub.getInteractionSnapshot().commands.length, 0, "panel context에서 service command가 발행됐습니다.");
        return { context: hub.getInteractionSnapshot().input.context, position: { x: after.x, y: after.y } };
      },
    ],
    [
      "browser-modal-input-suppression",
      "modal context가 panel/Canvas보다 우선하며 movement와 service action을 모두 차단한다",
      "Requirements 21.4, 31.6",
      () => {
        hub.reset();
        hub.setPlayerPosition(firstApproach.x, firstApproach.y);
        hub.setGuestOrderTargets([createGuestOrderTarget({
          targetId: "guest-order-target.modal",
          entityId: "guest-entity.modal",
          footMilliPx: { x: firstApproach.x * 1_000, y: firstApproach.y * 1_000 },
          proximityRadiusMilliPx: 48_000,
        })]);
        const before = hub.getState().player;
        shell.credits.open();
        try {
          assertEqual(hub.getInteractionSnapshot().input.context, INPUT_CONTEXT.MODAL, "modal이 최우선 input context가 아닙니다.");
          dispatchKey(root, "keydown", "d", "KeyD");
          dispatchKey(root, "keydown", "e", "KeyE");
          hub.step(16);
          dispatchKey(root, "keyup", "d", "KeyD");
          const after = hub.getState().player;
          assertEqual(after.x, before.x, "modal context에서 Player X가 움직였습니다.");
          assertEqual(after.y, before.y, "modal context에서 Player Y가 움직였습니다.");
          assertEqual(hub.getInteractionSnapshot().commands.length, 0, "modal context에서 service command가 발행됐습니다.");
          return { context: INPUT_CONTEXT.MODAL, position: { x: after.x, y: after.y } };
        } finally {
          shell.credits.close();
        }
      },
    ],
    [
      "browser-pointer-css-world-invariance",
      "CSS 240px/600px에서 같은 World pointer action이 같은 targetId-only command를 발행한다",
      "Requirements 21.8, 31.5, 33.11, 33.12",
      () => {
        hub.reset();
        hub.setPlayerPosition(firstApproach.x, firstApproach.y);
        const canvas = hub.scene.canvas;
        const previousStyle = canvas.getAttribute("style");
        const selected = [];
        let eventDetail = null;
        const listener = (event) => {
          eventDetail = event.detail;
        };
        root.addEventListener("world:interaction-command", listener);
        try {
          for (const size of [240, 600]) {
            canvas.style.width = `${size}px`;
            canvas.style.height = `${size}px`;
            hub.clearInteractionCommands();
            const client = hub.worldToClient(firstAuthored.worldMilliPx.x / 1_000, firstAuthored.worldMilliPx.y / 1_000);
            assert(client.ok, `${size}px World→client 변환이 실패했습니다.`);
            canvas.dispatchEvent(new root.defaultView.MouseEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: client.client.x,
              clientY: client.client.y,
            }));
            const commands = hub.getInteractionSnapshot().commands;
            assertEqual(commands.length, 1, `${size}px pointer action command 수가 다릅니다.`);
            assertEqual(commands[0].payload.targetId, firstAuthored.targetId, `${size}px CSS scale이 target selection을 바꿨습니다.`);
            assertEqual(JSON.stringify(Object.keys(commands[0].payload)), JSON.stringify(["targetId"]), `${size}px command payload에 좌표가 포함됐습니다.`);
            selected.push(commands[0].payload.targetId);
          }
          assert(eventDetail, "world:interaction-command event가 발행되지 않았습니다.");
          assertEqual(JSON.stringify(Object.keys(eventDetail.payload)), JSON.stringify(["targetId"]), "downstream event payload가 targetId-only가 아닙니다.");
          return { cssSizes: [240, 600], selected, eventDetail };
        } finally {
          root.removeEventListener("world:interaction-command", listener);
          if (previousStyle === null) canvas.removeAttribute("style");
          else canvas.setAttribute("style", previousStyle);
        }
      },
    ],
  ]);

  const report = reportFrom([...pure.results, ...browserResults]);
  renderReport(root, report);
  return report;
}
