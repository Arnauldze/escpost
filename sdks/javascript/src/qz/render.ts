import { EscpostError } from "../errors";
import { base64ToBytes, bytesToBase64, type QzPrintElement } from "./jobs";
import { importPdfJs } from "./pdfjs";

/**
 * Turns the QZ jobs that need rendering (images, HTML, PDF, and the `file`
 * flavor) into plain raw ESC/POS commands, so `jobToBytes` can send them.
 *
 * QZ Tray renders these in its Java app: in raw mode it converts the picture
 * to printer commands, and in pixel mode it hands it to the OS printer driver.
 * ESCPost has no driver, so both modes become an ESC/POS raster image here,
 * in the browser. That only suits ESC/POS printers, which is ESCPost's target.
 */

/** Width of an 80 mm roll at 203 dpi: the default when the job gives none. */
const DEFAULT_WIDTH_DOTS = 576;
const PRINTER_DPI = 203;
/** CSS defines 96 px per inch, so a pixel job's HTML keeps its real-world size. */
const CSS_DPI = 96;
/** Rows per `GS v 0` command; small bands keep cheap printers' buffers safe. */
const BAND_HEIGHT = 256;

const ESC_INIT = [0x1b, 0x40];
const FEED_AND_CUT = [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x41, 0x00];

type Options = Record<string, unknown>;

/** Replace every element that needs rendering by a raw base64 element; leave the rest alone. */
export async function renderElements(elements: unknown[], configOptions: Options): Promise<unknown[]> {
  return Promise.all(elements.map((element) => renderElement(element, configOptions)));
}

async function renderElement(element: unknown, configOptions: Options): Promise<unknown> {
  if (element === null || typeof element !== "object") return element;
  const job = element as QzPrintElement;
  const type = String(job.type ?? "raw").toLowerCase();
  const format = String(job.format ?? "command").toLowerCase();
  const flavor = String(job.flavor ?? "").toLowerCase();

  if (type === "raw" && format === "command") {
    // QZ Tray downloads a `file` flavor itself; we download it in the page.
    if (flavor !== "file") return element;
    return rawElement(await fetchBytes(job.data));
  }

  if (format !== "image" && format !== "html" && format !== "pdf") return element;
  if (type !== "raw" && type !== "pixel") return element;

  const options = (job.options ?? {}) as Options;
  const width = targetWidth(type, options, configOptions);
  const canvases =
    format === "image"
      ? [await imageToCanvas(job, width)]
      : format === "html"
        ? [await htmlToCanvas(job, width, type === "pixel" ? PRINTER_DPI / CSS_DPI : 1, configOptions["scaleContent"] !== false)]
        : await pdfToCanvases(job, width);

  const commands = canvases.flatMap((canvas) => Array.from(canvasToRaster(canvas)));
  // A pixel job is a whole document, which a driver would start and cut.
  const bytes = type === "pixel" ? [...ESC_INIT, ...commands, ...FEED_AND_CUT] : commands;
  return rawElement(Uint8Array.from(bytes));
}

function rawElement(bytes: Uint8Array): QzPrintElement {
  return { type: "raw", format: "command", flavor: "base64", data: bytesToBase64(bytes) };
}

/**
 * Raw jobs give `pageWidth` in dots. Pixel jobs give it, or the config's
 * `size.width`, in the config's units, which we convert at the printer's 203 dpi.
 * Anything wider than the roll is shrunk to it.
 */
function targetWidth(type: string, options: Options, configOptions: Options): number {
  if (type === "raw") return positive(options["pageWidth"]) ?? DEFAULT_WIDTH_DOTS;

  const units = String(configOptions["units"] ?? "in").toLowerCase();
  const size = configOptions["size"] as { width?: unknown } | null | undefined;
  const width = positive(options["pageWidth"]) ?? positive(size?.width);
  if (width === undefined) return DEFAULT_WIDTH_DOTS;

  const inches = units === "mm" ? width / 25.4 : units === "cm" ? width / 2.54 : width;
  return Math.min(DEFAULT_WIDTH_DOTS, Math.round(inches * PRINTER_DPI));
}

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** The job's content as bytes: base64 data, or a URL for the `file` and `plain` flavors. */
async function contentBytes(job: QzPrintElement): Promise<Uint8Array> {
  if (typeof job.data !== "string") {
    throw new EscpostError("UNSUPPORTED_FORMAT", "A print element must carry its data as a string.");
  }
  const flavor = String(job.flavor ?? "file").toLowerCase();
  if (flavor === "base64") return base64ToBytes(job.data);
  return fetchBytes(job.data);
}

async function fetchBytes(url: unknown): Promise<Uint8Array> {
  if (typeof url !== "string") {
    throw new EscpostError("UNSUPPORTED_FORMAT", "The file flavor needs a URL string.");
  }
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new EscpostError("PRINT_FAILED", `Could not download "${url}". A file on another site needs CORS.`);
  }
  if (!response.ok) throw new EscpostError("PRINT_FAILED", `Could not download "${url}" (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function whiteCanvas(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new EscpostError("PRINT_FAILED", "This browser cannot draw on a canvas.");
  // Transparent pixels must print as paper, not ink.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

/** Draw the image at the target width, keeping its proportions. */
async function imageToCanvas(job: QzPrintElement, width: number): Promise<HTMLCanvasElement> {
  const bytes = await contentBytes(job);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    throw new EscpostError("UNSUPPORTED_FORMAT", "The image could not be decoded (PNG, JPEG, GIF, WebP or BMP expected).");
  }
  const drawWidth = Math.min(width, bitmap.width);
  const height = Math.round((bitmap.height * drawWidth) / bitmap.width);
  const { canvas, context } = whiteCanvas(drawWidth, height);
  context.drawImage(bitmap, 0, 0, drawWidth, height);
  bitmap.close();
  return canvas;
}

/**
 * Render HTML through an SVG `foreignObject`, the browser's own layout engine.
 *
 * `dotsPerPixel` is 1 for a raw job, whose width is given in dots: one CSS
 * pixel prints as one dot, as in QZ Tray. A pixel job is a document, so its
 * CSS sizes are honoured instead: it is laid out at the paper width in CSS
 * pixels (96 per inch), then drawn enlarged to the printer's 203 dpi, so 12 px
 * text prints about 3 mm tall.
 *
 * The HTML is first laid out in a hidden sandboxed iframe (no scripts) at the
 * target width, to learn its height and to get it as XHTML, which SVG needs.
 * An SVG drawn as an image may not download anything, so `<img>` files, style
 * sheets and the fonts and images they use are embedded first (see
 * `inlineImages` and `inlineStyles`).
 *
 * With QZ's `scaleContent` option (on by default), content wider than the
 * paper, such as a large image, is shrunk to fit instead of being cut off.
 */
async function htmlToCanvas(
  job: QzPrintElement,
  width: number,
  dotsPerPixel: number,
  scaleContent: boolean,
): Promise<HTMLCanvasElement> {
  const flavor = String(job.flavor ?? "plain").toLowerCase();
  const html =
    flavor === "plain" && typeof job.data === "string"
      ? job.data
      : new TextDecoder().decode(await contentBytes(job));

  const layoutWidth = Math.round(width / dotsPerPixel);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.style.cssText = `position:fixed; left:-10000px; top:0; width:${layoutWidth}px; height:10px; border:0; visibility:hidden;`;
  frame.srcdoc = html;
  const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  document.body.append(frame);

  try {
    await loaded;
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) throw new EscpostError("PRINT_FAILED", "The HTML could not be laid out.");
    await Promise.all([inlineImages(frameDocument), inlineStyles(frameDocument)]);
    // A font changes the text's size, so measure only once the fonts are in.
    await frameDocument.fonts.ready;
    const root = frameDocument.documentElement;
    const contentWidth = scaleContent ? Math.max(layoutWidth, Math.ceil(root.scrollWidth)) : layoutWidth;
    const layoutHeight = Math.ceil(root.scrollHeight);
    const height = Math.round((layoutHeight * width) / contentWidth);
    const xhtml = new XMLSerializer().serializeToString(root);
    // The viewBox scales the whole content to the paper width as vectors, so
    // text stays sharp at 203 dpi and nothing wider than the paper is cut off.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${contentWidth} ${layoutHeight}">` +
      `<foreignObject width="${contentWidth}" height="${layoutHeight}">${xhtml}</foreignObject></svg>`;

    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    const { canvas, context } = whiteCanvas(width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas;
  } finally {
    frame.remove();
  }
}

/**
 * Replace each `<img>` source by a `data:` URL holding the image itself, so the
 * SVG needs no download. The page downloads it instead, which it may do for its
 * own files, and for other sites' files when they allow it (CORS). An image
 * that cannot be downloaded stays blank, like a broken image, and the rest of
 * the receipt still prints.
 */
async function inlineImages(frameDocument: Document): Promise<void> {
  await Promise.all(
    Array.from(frameDocument.images).map(async (image) => {
      const source = image.getAttribute("src");
      if (!source || source.startsWith("data:")) return;
      const dataUrl = await fetchDataUrl(new URL(source, frameDocument.baseURI));
      if (dataUrl === undefined) return;
      image.removeAttribute("srcset");
      image.setAttribute("src", dataUrl);
      await image.decode().catch(() => {});
    }),
  );
}

/**
 * The same for CSS: each `<link rel="stylesheet">` becomes a `<style>` holding
 * the file's text, and the files the CSS points to (fonts, background images,
 * `@import`ed sheets) become `data:` URLs. Same rule as images: a file the page
 * may not download is skipped, and the receipt prints without it.
 */
async function inlineStyles(frameDocument: Document): Promise<void> {
  const base = frameDocument.baseURI;
  const links = Array.from(frameDocument.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]'));
  const styles = Array.from(frameDocument.querySelectorAll("style"));
  const styled = Array.from(frameDocument.querySelectorAll<HTMLElement>('[style*="url("]'));

  await Promise.all([
    ...links.map(async (link) => {
      const css = await fetchCss(new URL(link.getAttribute("href")!, base), 0);
      if (css === undefined) return;
      const style = frameDocument.createElement("style");
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.textContent = css;
      link.replaceWith(style);
    }),
    ...styles.map(async (style) => {
      style.textContent = await inlineCssUrls(style.textContent ?? "", base);
    }),
    ...styled.map(async (element) => {
      element.setAttribute("style", await inlineCssUrls(element.getAttribute("style")!, base));
    }),
  ]);
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?[^;]*;/g;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
/** How deep `@import` chains are followed: enough for real sheets, safe from loops. */
const MAX_IMPORT_DEPTH = 3;

async function fetchCss(url: URL, depth: number): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    // The sheet's own urls are relative to the sheet, not to the page.
    return await inlineCssUrls(await response.text(), url, depth);
  } catch {
    return undefined;
  }
}

/** Replace a sheet's `@import`s and `url()`s by the files themselves. */
export async function inlineCssUrls(css: string, base: string | URL, depth = 0): Promise<string> {
  const imported =
    depth < MAX_IMPORT_DEPTH
      ? await replaceAsync(css, CSS_IMPORT, async (rule, _quote, href) => (await fetchCss(new URL(href!, base), depth + 1)) ?? rule)
      : css;
  return replaceAsync(imported, CSS_URL, async (match, _quote, href) => {
    // data: is already inline, and "#id" points into the page (SVG filters).
    if (href!.startsWith("data:") || href!.startsWith("#")) return match;
    const dataUrl = await fetchDataUrl(new URL(href!, base));
    return dataUrl === undefined ? match : `url("${dataUrl}")`;
  });
}

/** `String.replace` with an async replacer: the downloads run in parallel. */
async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: Array<string | undefined>) => Promise<string>,
): Promise<string> {
  const matches = Array.from(text.matchAll(pattern));
  const replacements = await Promise.all(matches.map((match) => replacer(match[0], ...match.slice(1))));
  let index = 0;
  return text.replace(pattern, () => replacements[index++]!);
}

/** A file as a `data:` URL, or undefined when the page may not download it (often CORS). */
async function fetchDataUrl(url: URL): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return await blobToDataUrl(await response.blob());
  } catch {
    return undefined;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

type PdfJs = {
  getDocument(source: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(number: number): Promise<{
        getViewport(options: { scale: number }): { width: number; height: number };
        render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
      }>;
    }>;
  };
};

let pdfJs: Promise<PdfJs> | undefined;

/** pdf.js is about 1.7 MB, so it is loaded only for the first PDF (see pdfjs.ts). */
function loadPdfJs(): Promise<PdfJs> {
  if (pdfJs === undefined) {
    pdfJs = (async () => {
      const [library, worker] = await importPdfJs();
      // pdf.js runs its worker code in the page when it finds it here, so it
      // never has to locate pdf.worker.min.js by URL, which bundlers move around.
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      return library as PdfJs;
    })();
    // A failed download (missing file) must not block every later try.
    pdfJs.catch(() => {
      pdfJs = undefined;
    });
  }
  return pdfJs;
}

/** One canvas per page, each scaled to the target width. */
async function pdfToCanvases(job: QzPrintElement, width: number): Promise<HTMLCanvasElement[]> {
  const bytes = await contentBytes(job);
  let pdf: Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
  try {
    pdf = await (await loadPdfJs()).getDocument({ data: bytes }).promise;
  } catch {
    throw new EscpostError("PRINT_FAILED", "The PDF could not be opened, or pdf.js could not be loaded.");
  }

  const canvases: HTMLCanvasElement[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const { canvas, context } = whiteCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: context, viewport }).promise;
    canvases.push(canvas);
  }
  return canvases;
}

function canvasToRaster(canvas: HTMLCanvasElement): Uint8Array {
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return rasterToEscpos(data, canvas.width, canvas.height);
}

/**
 * RGBA pixels to ESC/POS `GS v 0` raster commands, one command per band.
 *
 * A thermal printer only prints black dots, so greys are dithered: each
 * pixel's rounding error is passed on to its neighbours (Floyd-Steinberg), and
 * a grey area becomes a pattern of dots instead of turning all white or all
 * black. This keeps grey logos and the soft edges of thin text visible.
 * Each row is packed 8 pixels per byte, most significant bit first.
 */
export function rasterToEscpos(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const black = ditherToBlack(rgba, width, height);
  const bytesPerRow = Math.ceil(width / 8);
  const out: number[] = [];

  for (let top = 0; top < height; top += BAND_HEIGHT) {
    const rows = Math.min(BAND_HEIGHT, height - top);
    out.push(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8);
    for (let y = top; y < top + rows; y++) {
      for (let column = 0; column < bytesPerRow; column++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = column * 8 + bit;
          if (x < width && black[y * width + x] === 1) byte |= 0x80 >> bit;
        }
        out.push(byte);
      }
    }
  }
  return Uint8Array.from(out);
}

/** One entry per pixel, 1 for a black dot, using Floyd-Steinberg error diffusion. */
function ditherToBlack(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const grey = new Float32Array(width * height);
  for (let index = 0; index < grey.length; index++) {
    const offset = index * 4;
    grey[index] = (299 * rgba[offset]! + 587 * rgba[offset + 1]! + 114 * rgba[offset + 2]!) / 1000;
  }

  const black = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const value = grey[index]!;
      const isBlack = value < 128;
      black[index] = isBlack ? 1 : 0;
      const error = value - (isBlack ? 0 : 255);
      if (x + 1 < width) grey[index + 1]! += (error * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) grey[index + width - 1]! += (error * 3) / 16;
        grey[index + width]! += (error * 5) / 16;
        if (x + 1 < width) grey[index + width + 1]! += error / 16;
      }
    }
  }
  return black;
}
