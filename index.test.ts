import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
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

test("leaves non-Kitty fallback rendering untouched", () => {
  const { writes, image } = setup();
  tui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  assert.deepEqual(image.render(12), originalRender.call(image, 12));
  assert.deepEqual(writes, []);
});
