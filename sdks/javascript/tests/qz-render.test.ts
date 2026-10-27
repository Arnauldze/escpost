import { describe, expect, it } from "vitest";
import { rasterToEscpos } from "../src/qz/render";

/** RGBA pixels from rows of "#" (black) and "." (white). */
function pixels(rows: string[]): Uint8ClampedArray {
  const values = rows.flatMap((row) =>
    Array.from(row).flatMap((cell) => (cell === "#" ? [0, 0, 0, 255] : [255, 255, 255, 255])),
  );
  return Uint8ClampedArray.from(values);
}

function countBits(byte: number): number {
  let count = 0;
  for (let bit = 0; bit < 8; bit++) count += (byte >> bit) & 1;
  return count;
}

describe("rasterToEscpos", () => {
  it("packs each row 8 pixels per byte under one GS v 0 header", () => {
    const bytes = rasterToEscpos(pixels(["#.......", "........", "#######."]), 8, 3);
    expect(Array.from(bytes)).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 3, 0, 0x80, 0x00, 0xfe]);
  });

  it("pads a row that is not a whole number of bytes with white", () => {
    const bytes = rasterToEscpos(pixels(["#########"]), 9, 1);
    expect(Array.from(bytes)).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 1, 0, 0xff, 0x80]);
  });

  it("dithers a mid-grey area into a bit less than half black dots, to make up for dot gain", () => {
    const size = 32;
    const bytes = rasterToEscpos(new Uint8ClampedArray(size * size * 4).fill(128), size, size);
    const ones = Array.from(bytes.slice(8)).reduce((sum, byte) => sum + countBits(byte), 0);
    // Grey 128 is lightened to about 147 before dithering: about 42% black dots, not 50%.
    expect(ones / (size * size)).toBeGreaterThan(0.37);
    expect(ones / (size * size)).toBeLessThan(0.47);
  });

  it("leaves pure black and pure white exactly as they are", () => {
    const black = rasterToEscpos(pixels(["########", "########"]), 8, 2);
    const white = rasterToEscpos(pixels(["........", "........"]), 8, 2);
    expect(Array.from(black.slice(8))).toEqual([0xff, 0xff]);
    expect(Array.from(white.slice(8))).toEqual([0x00, 0x00]);
  });

  it("keeps a light grey line visible as sparse dots, where a plain threshold printed nothing", () => {
    const width = 64;
    const bytes = rasterToEscpos(new Uint8ClampedArray(width * 4 * 4).fill(200), width, 4);
    const ones = Array.from(bytes.slice(8)).reduce((sum, byte) => sum + countBits(byte), 0);
    expect(ones).toBeGreaterThan(0);
  });

  it("splits a tall image into bands of at most 256 rows", () => {
    const height = 300;
    const bytes = rasterToEscpos(new Uint8ClampedArray(8 * height * 4).fill(255), 8, height);
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 0, 1]);
    const second = 8 + 256;
    expect(Array.from(bytes.slice(second, second + 8))).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 44, 0]);
    expect(bytes.length).toBe(8 + 256 + 8 + 44);
  });
});
