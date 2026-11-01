import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import piRenderImagesTmux, { installHerdrImageRendering } from "./index.ts";

const tui = await import(process.env.PI_TUI_TEST_MODULE ?? "@earendil-works/pi-tui");
const originalCaps = tui.getCapabilities();
const originalCells = tui.getCellDimensions();
const originalRender = tui.Image.prototype.render;
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  tui.setCapabilities(originalCaps);
  tui.setCellDimensions(originalCells);
});

function setup() {
  tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  tui.setCellDimensions({ widthPx: 8, heightPx: 16 });
  const writes: string[] = [];
  restore = installHerdrImageRendering(tui.Image.prototype, (text) => { writes.push(text); });
  const image = new tui.Image("cG5n", "image/png", { fallbackColor: (text: string) => text },
    { imageId: 0xff123456, maxWidthCells: 8 }, { widthPx: 64, heightPx: 32 });
  return { writes, image };
}

test("Herdr uses cell-backed images that an overlay can cover and uncover", () => {
  const { writes, image } = setup();
  const lines = image.render(12);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line: string) => line.includes("\u{10EEEE}")));
  assert.ok(lines.every((line: string) => tui.visibleWidth(line) === 8));
  assert.ok(lines.every((line: string) => !line.includes("\x1b_G")));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /a=T,f=100,q=2,U=1/);
  assert.ok(!writes[0].includes("\x1bPtmux;"));
  assert.ok(writes[0].includes(`a=d,d=I,i=${0xff123456}`));

  if (typeof tui.compositeTuiLine === "function") {
    const covered = tui.compositeTuiLine(lines[0], "agent view", 0, 12, 12);
    assert.ok(covered.includes("agent view"));
    assert.ok(!covered.includes("\u{10EEEE}"));
  }
  assert.deepEqual(image.render(12), lines);
  assert.equal(writes.length, 1, "closing the overlay reuses the uploaded image");
  image.render(6);
  assert.equal(writes.length, 2, "resize updates virtual placement dimensions");
  assert.match(writes[1], /c=4,r=1/);
});

test("restores the native renderer and deletes only its own virtual images", () => {
  const { writes, image } = setup();
  image.render(12);
  const virtualId = /U=1,i=(\d+)/.exec(writes[0])![1];
  assert.notEqual(virtualId, String(0xff123456));
  restore!();
  assert.equal(tui.Image.prototype.render, originalRender);
  assert.ok(writes.at(-1)!.includes(`a=d,d=I,i=${virtualId}`));
  assert.ok(!writes.at(-1)!.includes("d=A"));
  const count = writes.length;
  restore!();
  assert.equal(writes.length, count, "cleanup is idempotent");
});

test("reinstallation does not stack wrappers or let stale cleanup remove the new renderer", () => {
  const { image } = setup();
  const oldRestore = restore!;
  image.render(12);
  const writes: string[] = [];
  restore = installHerdrImageRendering(tui.Image.prototype, (text) => { writes.push(text); });
  const currentRender = tui.Image.prototype.render;
  oldRestore();
  assert.equal(tui.Image.prototype.render, currentRender);
  image.render(12);
  assert.equal(writes.length, 1);
  restore();
  assert.equal(tui.Image.prototype.render, originalRender);
});

test("installs only in interactive Herdr sessions and restores on shutdown", async () => {
  const localTui = await import("@earendil-works/pi-tui");
  const nativeRender = localTui.Image.prototype.render;
  const environment = process.env.HERDR_ENV;
  const handlers = new Map<string, (...args: any[]) => void>();
  piRenderImagesTmux({
    on: (event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); },
    registerMessageRenderer() {},
    registerCommand() {},
  } as unknown as Parameters<typeof piRenderImagesTmux>[0]);
  try {
    delete process.env.HERDR_ENV;
    handlers.get("session_start")!({}, { hasUI: true });
    assert.equal(localTui.Image.prototype.render, nativeRender);
    process.env.HERDR_ENV = "1";
    handlers.get("session_start")!({}, { hasUI: false });
    assert.equal(localTui.Image.prototype.render, nativeRender);
    handlers.get("session_start")!({}, { hasUI: true });
    assert.notEqual(localTui.Image.prototype.render, nativeRender);
  } finally {
    handlers.get("session_shutdown")!();
    if (environment === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = environment;
  }
  assert.equal(localTui.Image.prototype.render, nativeRender);
});

type Command = Parameters<Parameters<typeof piRenderImagesTmux>[0]["registerCommand"]>[1];

function statusHarness(t: TestContext, env: Record<string, string>, responses: Array<string | null>) {
  const saved = { ...process.env };
  delete process.env.HERDR_ENV;
  delete process.env.TMUX;
  process.env.TERM = "xterm-256color";
  Object.assign(process.env, env);
  t.after(() => {
    process.env = saved;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const calls: string[] = [];
  t.mock.method(childProcess, "execSync", (command: string) => {
    calls.push(command);
    const response = responses.shift();
    if (response == null) throw new Error("probe failed with private details");
    return response;
  });
  syncBuiltinESMExports();
  const writes = t.mock.method(process.stdout, "write", () => true);
  const messages = t.mock.fn();
  const handlers = new Map<string, (...args: any[]) => any>();
  let command: Command | undefined;
  piRenderImagesTmux({
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    },
    registerMessageRenderer() {},
    registerCommand(name: string, registered: Command) {
      assert.equal(name, "image-status");
      command = registered;
    },
    sendMessage: messages,
  } as unknown as Parameters<typeof piRenderImagesTmux>[0]);
  assert.ok(command, "registers /image-status");
  assert.deepEqual(calls, [], "registration does not probe");
  const notifications: string[] = [];
  const statusCommand = command;
  const invoke = () => statusCommand.handler("", {
    hasUI: true,
    ui: { notify: (message: string) => { notifications.push(message); } },
  } as unknown as Parameters<Command["handler"]>[1]);
  return { invoke, notifications, calls, writes, messages, handlers };
}

const passthroughQuery = "tmux show-options -g allow-passthrough";
const sessionQuery = "tmux show-environment TERM_PROGRAM";
const globalQuery = "tmux show-environment -g TERM_PROGRAM";
const statusCases: Array<{
  name: string;
  env?: Record<string, string>;
  responses: Array<string | null>;
  expected: RegExp;
  calls: string[];
}> = [
  {
    name: "Herdr takes precedence over tmux",
    env: { HERDR_ENV: "1", TMUX: "private" },
    responses: [],
    expected: /Herdr mode/,
    calls: [],
  },
  {
    name: "outside tmux",
    env: {},
    responses: [],
    expected: /outside tmux/,
    calls: [],
  },
  {
    name: "passthrough probe failure",
    responses: [null],
    expected: /passthrough probe failed/,
    calls: [passthroughQuery],
  },
  {
    name: "passthrough off",
    responses: ["allow-passthrough off"],
    expected: /passthrough is disabled/,
    calls: [passthroughQuery],
  },
  {
    name: "unrecognized passthrough response",
    responses: ["unexpected"],
    expected: /passthrough probe failed/,
    calls: [passthroughQuery],
  },
  {
    name: "terminal probe failure",
    responses: ["allow-passthrough on", null, null],
    expected: /TERM_PROGRAM probe failed/,
    calls: [passthroughQuery, sessionQuery, globalQuery],
  },
  {
    name: "missing terminal",
    responses: ["allow-passthrough on", "-TERM_PROGRAM"],
    expected: /TERM_PROGRAM is missing/,
    calls: [passthroughQuery, sessionQuery],
  },
  {
    name: "unsupported terminal",
    responses: ["allow-passthrough on", "TERM_PROGRAM=private-terminal"],
    expected: /terminal is unsupported/,
    calls: [passthroughQuery, sessionQuery],
  },
  {
    name: "Ghostty supported",
    responses: ["allow-passthrough on", "TERM_PROGRAM=Ghostty"],
    expected: /prerequisites are supported/,
    calls: [passthroughQuery, sessionQuery],
  },
  {
    name: "kitty global fallback and TERM detection",
    env: { TERM: "tmux-256color" },
    responses: ["allow-passthrough all", null, "TERM_PROGRAM=kitty"],
    expected: /prerequisites are supported/,
    calls: [passthroughQuery, sessionQuery, globalQuery],
  },
];

for (const scenario of statusCases) {
  test(`image-status: ${scenario.name}`, async (t) => {
    const harness = statusHarness(t, scenario.env ?? { TMUX: "private" }, [...scenario.responses]);

    await harness.invoke();

    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0], scenario.expected);
    assert.match(harness.notifications[0], /does not prove successful rendering/);
    assert.doesNotMatch(harness.notifications[0], /private|\x1b/);
    assert.deepEqual(harness.calls, scenario.calls, "only read-only probes are executed");
    assert.equal(harness.writes.mock.callCount(), 0, "no graphics are transmitted");
    assert.equal(harness.messages.mock.callCount(), 0, "no persistent messages are added");
  });
}

test("image-status probes afresh without populating or replacing the preview cache", async (t) => {
  const harness = statusHarness(t, { TMUX: "private" }, [
    "allow-passthrough off",
    "allow-passthrough on", "TERM_PROGRAM=kitty",
    "allow-passthrough off",
  ]);
  await harness.invoke();
  const imageResult = {
    toolName: "read",
    toolCallId: "status-cache",
    content: [{
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    }],
  };
  await harness.handlers.get("tool_result")!(imageResult);
  assert.equal(harness.messages.mock.callCount(), 1, "status did not seed the cache with unsupported");
  await harness.invoke();
  await harness.handlers.get("tool_result")!(imageResult);
  assert.equal(harness.messages.mock.callCount(), 2, "status did not replace cached support");
  assert.deepEqual(harness.calls, [passthroughQuery, passthroughQuery, sessionQuery, passthroughQuery]);
  assert.ok(harness.notifications.every((message) => /passthrough is disabled/.test(message)));
});

test("leaves non-Kitty fallback rendering untouched", () => {
  const { writes, image } = setup();
  tui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  assert.deepEqual(image.render(12), originalRender.call(image, 12));
  assert.deepEqual(writes, []);
});
