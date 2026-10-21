import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import {
  getCellDimensions,
  getImageDimensions,
  Image,
  Text,
} from "@earendil-works/pi-tui";

const PLACEHOLDER = "\u{10EEEE}";
const CHUNK_SIZE = 4096;
const DEFAULT_MAX_WIDTH_CELLS = 60;
const MAX_PREVIEW_SOURCE_DIMENSION_PX = 1600;
const CUSTOM_MESSAGE_TYPE = "pi-render-images-tmux:image-preview";
const transmittedImages = new Set<string>();
const imagePreviews = new Map<string, StoredImagePreview>();

const ROW_DIACRITICS = [
  "\u0305", "\u030D", "\u030E", "\u0310", "\u0312",
  "\u033D", "\u033E", "\u033F", "\u0346", "\u034A",
  "\u034B", "\u034C", "\u0350", "\u0351", "\u0352",
  "\u0357", "\u035B", "\u0363", "\u0364", "\u0365",
  "\u0366", "\u0367", "\u0368", "\u0369", "\u036A",
  "\u036B", "\u036C", "\u036D", "\u036E", "\u036F",
  "\u0483", "\u0484", "\u0485", "\u0486", "\u0487",
  "\u0592", "\u0593", "\u0594", "\u0595", "\u0597",
  "\u0598", "\u0599", "\u059C", "\u059D", "\u059E",
  "\u059F", "\u05A0", "\u05A1", "\u05A8", "\u05A9",
  "\u05AB", "\u05AC", "\u05AF", "\u05C4", "\u0610",
  "\u0611", "\u0612", "\u0613", "\u0614", "\u0615",
  "\u0616", "\u0617", "\u0618", "\u0619", "\u061A",
  "\u0653", "\u0654", "\u0657", "\u0658", "\u06D6",
  "\u06D7", "\u06D8", "\u06D9", "\u06DA", "\u06DB",
  "\u06DC", "\u06DF", "\u06E0", "\u06E1", "\u06E2",
  "\u06E4", "\u06E7", "\u06E8", "\u06EB", "\u06EC",
];

type ImageBlock = { type: "image"; data?: string; mimeType?: string };
type TextBlock = { type: "text"; text?: string };
type StoredImagePreview = {
  data: string;
  mimeType: string;
  imageId: number;
  note: string;
};

type TmuxImagePreviewDetails = {
  previewId: string;
};

type TmuxSupport = "kitty" | "unsupported";
let cachedTmuxSupport: TmuxSupport | undefined;

function run(command: string): string | null {
  try {
    return execSync(command, {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function tmuxPassthroughEnabled(): boolean {
  const output = run("tmux show-options -g allow-passthrough");
  return /allow-passthrough\s+(on|all)/.test(output ?? "");
}

function tmuxEnvironment(name: string): string | null {
  const session = run(`tmux show-environment ${name}`);
  const global = session ? null : run(`tmux show-environment -g ${name}`);
  const output = session ?? global;
  const match = output?.match(new RegExp(`^${name}=(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function detectTmuxSupport(): TmuxSupport {
  if (cachedTmuxSupport) return cachedTmuxSupport;

  const inTmux = Boolean(process.env.TMUX) || (process.env.TERM ?? "").toLowerCase().startsWith("tmux");
  if (!inTmux || !tmuxPassthroughEnabled()) {
    cachedTmuxSupport = "unsupported";
    return cachedTmuxSupport;
  }

  const termProgram = (tmuxEnvironment("TERM_PROGRAM") ?? "").toLowerCase();
  cachedTmuxSupport = termProgram === "ghostty" || termProgram === "kitty" ? "kitty" : "unsupported";
  return cachedTmuxSupport;
}

function wrapTmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function randomImageId(): number {
  return Math.floor(Math.random() * 0xfffffe) + 1;
}

function buildTransmitSequence(base64: string, imageId: number, columns: number, rows: number, tmux = true): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += CHUNK_SIZE) {
    const chunk = base64.slice(offset, offset + CHUNK_SIZE);
    const first = offset === 0;
    const last = offset + CHUNK_SIZE >= base64.length;
    const more = last ? 0 : 1;
    const params = first
      ? `a=T,f=100,q=2,U=1,i=${imageId},c=${columns},r=${rows},m=${more}`
      : `m=${more}`;
    chunks.push(`\x1b_G${params};${chunk}\x1b\\`);
  }

  if (chunks.length === 0) {
    chunks.push(`\x1b_Ga=T,f=100,q=2,U=1,i=${imageId},c=${columns},r=${rows},m=0;\x1b\\`);
  }

  return tmux ? wrapTmuxPassthrough(chunks.join("")) : chunks.join("");
}

function buildDeleteSequence(imageId: number, tmux = true): string {
  const sequence = `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
  return tmux ? wrapTmuxPassthrough(sequence) : sequence;
}

function calculateImageCellSize(
  imageDimensions: { widthPx: number; heightPx: number },
  maxWidthCells: number,
  maxHeightCells: number,
  cellDimensions: { widthPx: number; heightPx: number },
): { columns: number; rows: number } {
  const imageWidth = Math.max(1, imageDimensions.widthPx);
  const imageHeight = Math.max(1, imageDimensions.heightPx);
  const widthScale = (Math.max(1, maxWidthCells) * cellDimensions.widthPx) / imageWidth;
  const heightScale = (Math.max(1, maxHeightCells) * cellDimensions.heightPx) / imageHeight;
  const scale = Math.min(widthScale, heightScale);
  const columns = Math.ceil((imageWidth * scale) / cellDimensions.widthPx);
  const rows = Math.ceil((imageHeight * scale) / cellDimensions.heightPx);
  return {
    columns: Math.max(1, Math.min(maxWidthCells, columns)),
    rows: Math.max(1, Math.min(maxHeightCells, rows)),
  };
}

function buildPlaceholderLines(imageId: number, columns: number, rows: number): string[] {
  const red = (imageId >> 16) & 255;
  const green = (imageId >> 8) & 255;
  const blue = imageId & 255;
  const colorOn = `\x1b[38;2;${red};${green};${blue}m`;
  const colorOff = "\x1b[39m";

  return Array.from({ length: rows }, (_, row) => {
    const diacritic = ROW_DIACRITICS[row] ?? ROW_DIACRITICS[0];
    return `${colorOn}${PLACEHOLDER}${diacritic}${PLACEHOLDER.repeat(Math.max(0, columns - 1))}${colorOff}`;
  });
}

function textBlocksOnly(result: { content: Array<TextBlock | ImageBlock> }): string {
  return result.content
    .filter((part): part is TextBlock => part.type === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function imageKey(image: ImageBlock): string {
  return `${image.mimeType ?? ""}:${image.data?.length ?? 0}:${image.data?.slice(0, 64) ?? ""}`;
}

function findRenderableImage(content: unknown): ImageBlock | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find(
    (part): part is ImageBlock =>
      Boolean(part && part.type === "image" && part.data && part.mimeType),
  );
}

function isTmuxImagePreviewDetails(details: unknown): details is TmuxImagePreviewDetails {
  return Boolean(
    details &&
      typeof details === "object" &&
      typeof (details as TmuxImagePreviewDetails).previewId === "string",
  );
}

function shouldAttemptTmuxPreview(data: string, mimeType: string): boolean {
  const dimensions = getImageDimensions(data, mimeType);
  if (!dimensions) return false;

  // Large screenshots have produced empty Ghostty/tmux placeholder blocks in practice.
  // If the custom renderer cannot be trusted, emit nothing and let the read tool fallback stand.
  return Math.max(dimensions.widthPx, dimensions.heightPx) <= MAX_PREVIEW_SOURCE_DIMENSION_PX;
}

function renderTmuxKittyImage(preview: StoredImagePreview, theme: any) {
  if (preview.mimeType !== "image/png" || detectTmuxSupport() !== "kitty") return null;
  if (!shouldAttemptTmuxPreview(preview.data, preview.mimeType)) return null;

  const dimensions = getImageDimensions(preview.data, preview.mimeType) ?? { widthPx: 800, heightPx: 600 };
  const cellDimensions = getCellDimensions();
  const maxHeightCells = Math.max(1, Math.ceil((DEFAULT_MAX_WIDTH_CELLS * cellDimensions.widthPx) / cellDimensions.heightPx));
  const size = calculateImageCellSize(dimensions, DEFAULT_MAX_WIDTH_CELLS, maxHeightCells, cellDimensions);

  const key = `${imageKey({ type: "image", data: preview.data, mimeType: preview.mimeType })}:${size.columns}x${size.rows}:${preview.imageId}`;
  if (!transmittedImages.has(key)) {
    process.stdout.write(buildDeleteSequence(preview.imageId) + buildTransmitSequence(preview.data, preview.imageId, size.columns, size.rows));
    transmittedImages.add(key);
  }

  const lines = buildPlaceholderLines(preview.imageId, size.columns, size.rows);
  return new Text(`${theme.fg("toolOutput", preview.note)}\n${lines.join("\n")}`, 0, 0);
}

const HERDR_RENDERER = Symbol.for("pi-render-images-tmux:herdr-renderer");

// Pi 1.3 skips overlay composition on native image rows. Herdr's virtual
// placements instead follow text cells, so covering a cell also covers its image.
export function installHerdrImageRendering(
  prototype: Pick<Image, "render"> & { [HERDR_RENDERER]?: () => void } = Image.prototype,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
): () => void {
  prototype[HERDR_RENDERER]?.();
  const nativeRender = prototype.render;
  const cache = new WeakMap<object, { id: number; source: string; lines: string[] }>();
  const ids = new Set<number>();
  const render: Image["render"] = function (this: Image, width) {
    const nativeLines = nativeRender.call(this, width);
    const source = nativeLines.join("\n");
    const previous = cache.get(this);
    if (previous?.source === source) return previous.lines;

    const chunks = [...source.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    const params = chunks[0]?.[1] ?? "";
    const columns = Number(/(?:^|,)c=(\d+)/.exec(params)?.[1]);
    const rows = Number(/(?:^|,)r=(\d+)/.exec(params)?.[1]);
    const nativeId = Number(/(?:^|,)i=(\d+)/.exec(params)?.[1]);
    if (!params.includes("a=T") || !columns || !rows || rows > ROW_DIACRITICS.length || !nativeId) {
      return nativeLines;
    }

    let id = previous?.id ?? randomImageId();
    if (!previous) {
      while (ids.has(id) || id === nativeId) id = (id % 0xfffffe) + 1;
      ids.add(id);
    }
    const data = chunks.map((chunk) => chunk[2]).join("");
    write(
      buildDeleteSequence(nativeId, false) + buildDeleteSequence(id, false)
      + buildTransmitSequence(data, id, columns, rows, false),
    );
    const lines = buildPlaceholderLines(id, columns, rows);
    cache.set(this, { id, source, lines });
    return lines;
  };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (prototype.render === render) prototype.render = nativeRender;
    if (prototype[HERDR_RENDERER] === restore) delete prototype[HERDR_RENDERER];
    if (ids.size) write([...ids].map((id) => buildDeleteSequence(id, false)).join(""));
  };
  prototype.render = render;
  prototype[HERDR_RENDERER] = restore;
  return restore;
}

export default function piRenderImagesTmux(pi: ExtensionAPI) {
  let restoreHerdr: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && process.env.HERDR_ENV === "1") {
      restoreHerdr = installHerdrImageRendering();
    }
  });
  pi.on("session_shutdown", () => {
    restoreHerdr?.();
  });

  pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
    if (!isTmuxImagePreviewDetails(message.details)) return undefined;

    const preview = imagePreviews.get(message.details.previewId);
    if (!preview) return undefined;

    return renderTmuxKittyImage(preview, theme) ?? undefined;
  });

  pi.on("tool_result", async (event) => {
    if (process.env.HERDR_ENV === "1" || event.toolName !== "read" || event.isError || detectTmuxSupport() !== "kitty") return;

    const image = findRenderableImage(event.content);
    if (!image) return;

    let imageData = image.data!;
    let mimeType = image.mimeType!;
    if (mimeType !== "image/png") {
      const converted = await convertToPng(imageData, mimeType);
      if (!converted || converted.mimeType !== "image/png") return;
      imageData = converted.data;
      mimeType = converted.mimeType;
    }

    if (!shouldAttemptTmuxPreview(imageData, mimeType)) return;

    const note = textBlocksOnly({ content: event.content as Array<TextBlock | ImageBlock> }) || "Read image file";
    const previewId = `${event.toolCallId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    imagePreviews.set(previewId, {
      data: imageData,
      mimeType,
      imageId: randomImageId(),
      note,
    });

    pi.sendMessage({
      customType: CUSTOM_MESSAGE_TYPE,
      content: note,
      display: true,
      details: { previewId },
    });
  });
}
