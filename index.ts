import { execSync } from "node:child_process";
import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { convertToPng, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getCellDimensions,
  getImageDimensions,
  Text,
} from "@earendil-works/pi-tui";

const PLACEHOLDER = "\u{10EEEE}";
const CHUNK_SIZE = 4096;
const DEFAULT_MAX_WIDTH_CELLS = 60;

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
type RenderState = {
  imageId?: number;
  transmittedKey?: string;
  conversionKey?: string;
  converted?: { data: string; mimeType: string } | null;
  converting?: boolean;
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

function buildTransmitSequence(base64: string, imageId: number, columns: number, rows: number): string {
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

  return wrapTmuxPassthrough(chunks.join(""));
}

function buildDeleteSequence(imageId: number): string {
  return wrapTmuxPassthrough(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
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

function startConversion(image: ImageBlock, state: RenderState, context: { invalidate: () => void }) {
  const key = imageKey(image);
  if (state.converting && state.conversionKey === key) return;

  state.conversionKey = key;
  state.converted = null;
  state.converting = true;

  convertToPng(image.data ?? "", image.mimeType ?? "").then((converted) => {
    if (state.conversionKey !== key) return;
    state.converted = converted;
    state.converting = false;
    context.invalidate();
  }).catch(() => {
    if (state.conversionKey !== key) return;
    state.converted = null;
    state.converting = false;
    context.invalidate();
  });
}

function renderTmuxKittyImage(
  result: { content: Array<TextBlock | ImageBlock> },
  options: ToolRenderResultOptions,
  theme: any,
  context: { state: RenderState; showImages: boolean; invalidate: () => void },
) {
  const image = result.content.find((part): part is ImageBlock => part.type === "image" && Boolean(part.data && part.mimeType));
  if (!image || options.isPartial || !context.showImages || detectTmuxSupport() !== "kitty") return null;

  let imageData = image.data!;
  let mimeType = image.mimeType!;

  if (mimeType !== "image/png") {
    startConversion(image, context.state, context);
    if (!context.state.converted) {
      const note = textBlocksOnly(result);
      return new Text(`${theme.fg("toolOutput", note)}\n${theme.fg("muted", "[Converting image for terminal preview...]")}`, 0, 0);
    }
    imageData = context.state.converted.data;
    mimeType = context.state.converted.mimeType;
  }

  if (mimeType !== "image/png") return null;

  const dimensions = getImageDimensions(imageData, mimeType) ?? { widthPx: 800, heightPx: 600 };
  const cellDimensions = getCellDimensions();
  const maxHeightCells = Math.max(1, Math.ceil((DEFAULT_MAX_WIDTH_CELLS * cellDimensions.widthPx) / cellDimensions.heightPx));
  const size = calculateImageCellSize(dimensions, DEFAULT_MAX_WIDTH_CELLS, maxHeightCells, cellDimensions);

  const key = `${imageKey({ ...image, data: imageData, mimeType })}:${size.columns}x${size.rows}`;
  if (context.state.transmittedKey !== key) {
    context.state.imageId = context.state.imageId ?? randomImageId();
    const imageId = context.state.imageId;
    process.stdout.write(buildDeleteSequence(imageId) + buildTransmitSequence(imageData, imageId, size.columns, size.rows));
    context.state.transmittedKey = key;
  }

  const imageId = context.state.imageId!;
  const note = textBlocksOnly(result);
  const lines = buildPlaceholderLines(imageId, size.columns, size.rows);
  return new Text(`${theme.fg("toolOutput", note)}\n${lines.join("\n")}`, 0, 0);
}

export default function piRenderImagesTmux(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadToolDefinition(cwd);

  pi.registerTool({
    name: "read",
    label: originalRead.label,
    description: originalRead.description,
    parameters: originalRead.parameters,
    promptSnippet: originalRead.promptSnippet,
    promptGuidelines: originalRead.promptGuidelines,

    execute(toolCallId, params, signal, onUpdate, ctx) {
      return originalRead.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      return originalRead.renderCall(args, theme, context);
    },

    renderResult(result, options, theme, context) {
      const tmuxImage = renderTmuxKittyImage(result, options, theme, context as any);
      if (tmuxImage) return tmuxImage;
      return originalRead.renderResult(result, options, theme, context);
    },
  });
}
