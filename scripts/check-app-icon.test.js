const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');

function readPngRgba(filePath) {
  const data = fs.readFileSync(filePath);
  assert.deepEqual(
    data.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    `${filePath} is not a PNG`,
  );

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    const chunk = data.subarray(start, end);

    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }

    offset = end + 4;
  }

  assert.equal(colorType, 6, `${filePath} must be 8-bit RGBA`);
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = 1 + width * bytesPerPixel;
  assert.equal(inflated.length, stride * height, `${filePath} has unexpected pixels`);

  const rgba = Buffer.alloc(width * height * bytesPerPixel);
  let previous = Buffer.alloc(width * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * stride];
    const raw = inflated.subarray(y * stride + 1, (y + 1) * stride);
    const recon = Buffer.alloc(width * bytesPerPixel);
    for (let index = 0; index < raw.length; index += 1) {
      const left = index >= bytesPerPixel ? recon[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upLeft =
        index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let value = raw[index];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) {
        value = (value + Math.floor((left + up) / 2)) & 255;
      } else if (filter === 4) {
        value = (value + paethPredictor(left, up, upLeft)) & 255;
      } else if (filter !== 0) {
        throw new Error(`${filePath} uses an unsupported PNG filter`);
      }
      recon[index] = value;
    }
    recon.copy(rgba, y * width * bytesPerPixel);
    previous = recon;
  }

  return { width, height, rgba };
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  if (upDistance <= upLeftDistance) {
    return up;
  }
  return upLeft;
}

function pixel(rgba, width, x, y) {
  const index = (y * width + x) * 4;
  return [rgba[index], rgba[index + 1], rgba[index + 2], rgba[index + 3]];
}

test('bundle app icon fills the canvas so macOS does not add a plate', () => {
  const iconPath = path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.png');
  const { width, height, rgba } = readPngRgba(iconPath);
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  for (const [x, y] of corners) {
    assert.deepEqual(pixel(rgba, width, x, y), [0, 0, 0, 255]);
  }

  const center = pixel(rgba, width, Math.floor(width / 2), Math.floor(height / 2));
  assert.notDeepEqual(center.slice(0, 3), [0, 0, 0]);
  assert.equal(center[3], 255);
});
