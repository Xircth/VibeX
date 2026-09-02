const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');

function readPngRgba(filePath) {
  return decodePngRgba(fs.readFileSync(filePath), filePath);
}

function decodePngRgba(data, label) {
  assert.deepEqual(
    data.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    `${label} is not a PNG`,
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

  assert.equal(colorType, 6, `${label} must be 8-bit RGBA`);
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = 1 + width * bytesPerPixel;
  assert.equal(inflated.length, stride * height, `${label} has unexpected pixels`);

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
        throw new Error(`${label} uses an unsupported PNG filter`);
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

function extractIcoPng(filePath, targetSize) {
  const data = fs.readFileSync(filePath);
  assert.equal(data.readUInt16LE(0), 0, `${filePath} is not an ICO`);
  assert.equal(data.readUInt16LE(2), 1, `${filePath} is not an ICO`);
  const count = data.readUInt16LE(4);
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = data[offset] === 0 ? 256 : data[offset];
    if (width !== targetSize) continue;
    const size = data.readUInt32LE(offset + 8);
    const pointer = data.readUInt32LE(offset + 12);
    return data.subarray(pointer, pointer + size);
  }
  throw new Error(`${filePath} has no ${targetSize}x${targetSize} frame`);
}

function assertSquircleIcon(filePath, expectedSize) {
  const { width, height, rgba } = readPngRgba(filePath);
  assertSquirclePixels(rgba, width, height, expectedSize, filePath);
}

function assertSquircleBuffer(data, expectedSize, label) {
  const { width, height, rgba } = decodePngRgba(data, label);
  assertSquirclePixels(rgba, width, height, expectedSize, label);
}

function assertSquirclePixels(rgba, width, height, expectedSize, label) {
  assert.equal(width, expectedSize, `${label} width`);
  assert.equal(height, expectedSize, `${label} height`);

  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  for (const [x, y] of corners) {
    assert.equal(
      pixel(rgba, width, x, y)[3],
      0,
      `${label} corner ${x},${y} must be transparent`
    );
  }

  const canvasEdge = [
    [Math.floor(width / 2), 0],
    [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)],
    [width - 1, Math.floor(height / 2)],
  ];
  for (const [x, y] of canvasEdge) {
    assert.equal(
      pixel(rgba, width, x, y)[3],
      0,
      `${label} canvas edge ${x},${y} must be inset`
    );
  }

  const inner = Math.round(width * 0.25);
  const innerSamples = [
    [Math.floor(width / 2), inner],
    [Math.floor(width / 2), height - 1 - inner],
    [inner, Math.floor(height / 2)],
    [width - 1 - inner, Math.floor(height / 2)],
  ];
  for (const [x, y] of innerSamples) {
    assert.equal(
      pixel(rgba, width, x, y)[3],
      255,
      `${label} inner ${x},${y} must be opaque`
    );
  }

  const center = pixel(
    rgba,
    width,
    Math.floor(width / 2),
    Math.floor(height / 2)
  );
  assert.notDeepEqual(center.slice(0, 3), [0, 0, 0]);
  assert.equal(center[3], 255);

  const rim = Math.round(width * 0.18);
  const rimPixel = pixel(rgba, width, Math.floor(width / 2), rim);
  assert.ok(
    rimPixel[3] >= 240,
    `${label} rim ${rim} must stay inside the squircle`
  );
  assert.ok(
    rimPixel[0] + rimPixel[1] + rimPixel[2] < 40,
    `${label} mark must not crowd the squircle rim`
  );
}

function readIcoSizes(filePath) {
  const data = fs.readFileSync(filePath);
  assert.equal(data.readUInt16LE(0), 0, `${filePath} is not an ICO`);
  assert.equal(data.readUInt16LE(2), 1, `${filePath} is not an ICO`);
  const count = data.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = data[offset] === 0 ? 256 : data[offset];
    const height = data[offset + 1] === 0 ? 256 : data[offset + 1];
    sizes.push(`${width}x${height}`);
  }
  return sizes;
}

function readIcnsEntries(filePath) {
  const data = fs.readFileSync(filePath);
  assert.equal(data.subarray(0, 4).toString('latin1'), 'icns');
  const entries = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const type = data.subarray(offset, offset + 4).toString('latin1');
    const size = data.readUInt32BE(offset + 4);
    if (size < 8) break;
    entries.push({
      type,
      payload: data.subarray(offset + 8, offset + size),
    });
    offset += size;
  }
  return entries;
}

test('desktop PNG icons are inset squircles', () => {
  const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');
  assertSquircleIcon(path.join(iconsDir, 'icon.png'), 512);
  assertSquircleIcon(path.join(iconsDir, '128x128.png'), 128);
  assertSquircleIcon(path.join(iconsDir, '128x128@2x.png'), 256);
  assertSquircleIcon(path.join(iconsDir, '32x32.png'), 32);
  assertSquircleIcon(path.join(iconsDir, '64x64.png'), 64);
});

function assertCaptionMargin(rgba, width, height, margin, label) {
  for (let offset = 0; offset < margin; offset += 1) {
    for (let cursor = 0; cursor < width; cursor += 1) {
      assert.ok(
        pixel(rgba, width, cursor, offset)[3] < 8,
        `${label} top ${offset}`
      );
      assert.ok(
        pixel(rgba, width, cursor, height - 1 - offset)[3] < 8,
        `${label} bottom ${offset}`
      );
      assert.ok(
        pixel(rgba, width, offset, cursor)[3] < 8,
        `${label} left ${offset}`
      );
      assert.ok(
        pixel(rgba, width, width - 1 - offset, cursor)[3] < 8,
        `${label} right ${offset}`
      );
    }
  }
}

test('Windows ICO frames are the same inset squircle', () => {
  const icoPath = path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico');
  for (const size of [32, 48, 128, 256]) {
    assertSquircleBuffer(
      extractIcoPng(icoPath, size),
      size,
      `icon.ico ${size}x${size}`
    );
  }
});

test('Windows caption ICO sizes keep a DWM-safe transparent margin', () => {
  const icoPath = path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico');
  for (const [size, margin] of [
    [16, 2],
    [20, 2],
    [24, 2],
  ]) {
    const { width, height, rgba } = decodePngRgba(
      extractIcoPng(icoPath, size),
      `icon.ico ${size}x${size}`
    );
    assert.equal(width, size);
    assert.equal(height, size);
    assertCaptionMargin(rgba, width, height, margin, `icon.ico ${size}x${size}`);
    const center = pixel(
      rgba,
      width,
      Math.floor(width / 2),
      Math.floor(height / 2)
    );
    assert.equal(center[3], 255);
  }
});

test('Windows Store logos are the same inset squircle', () => {
  const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');
  assertSquircleIcon(path.join(iconsDir, 'Square44x44Logo.png'), 44);
  assertSquircleIcon(path.join(iconsDir, 'Square150x150Logo.png'), 150);
  assertSquircleIcon(path.join(iconsDir, 'StoreLogo.png'), 50);
});

test('Windows ICO includes the desktop icon sizes', () => {
  const sizes = readIcoSizes(
    path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico')
  );
  for (const required of [
    '16x16',
    '20x20',
    '24x24',
    '32x32',
    '40x40',
    '48x48',
    '64x64',
    '128x128',
    '256x256',
  ]) {
    assert.ok(sizes.includes(required), `icon.ico missing ${required}`);
  }
});

test('macOS ICNS includes the standard 1x and 2x slots', () => {
  const types = readIcnsEntries(
    path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.icns')
  ).map((entry) => entry.type);
  for (const required of [
    'ic07',
    'ic08',
    'ic09',
    'ic10',
    'ic11',
    'ic12',
    'ic13',
    'ic14',
  ]) {
    assert.ok(types.includes(required), `icon.icns missing ${required}`);
  }
});

test('macOS ICNS bakes the squircle so Dock folders do not show a square', () => {
  const icnsPath = path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.icns');
  const ic10 = readIcnsEntries(icnsPath).find((entry) => entry.type === 'ic10');
  assert.ok(ic10, 'icon.icns missing 1024px ic10');
  const { width, height, rgba } = decodePngRgba(ic10.payload, 'icon.icns ic10');
  assert.equal(width, 1024);
  assert.equal(height, 1024);
  for (const [x, y] of [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]) {
    assert.equal(
      pixel(rgba, width, x, y)[3],
      0,
      `ic10 corner ${x},${y} must be transparent`
    );
  }
  for (const [x, y] of [
    [512, 0],
    [512, 1023],
    [0, 512],
    [1023, 512],
  ]) {
    assert.equal(
      pixel(rgba, width, x, y)[3],
      0,
      `ic10 canvas edge ${x},${y} must be inset`
    );
  }
  assert.equal(pixel(rgba, width, 512, 256)[3], 255);
  assert.equal(pixel(rgba, width, 256, 512)[3], 255);
  const center = pixel(rgba, width, 512, 512);
  assert.notDeepEqual(center.slice(0, 3), [0, 0, 0]);
  assert.equal(center[3], 255);
  const rim = pixel(rgba, width, 512, 133);
  assert.equal(rim[3], 255);
  assert.ok(rim[0] + rim[1] + rim[2] < 40, 'ic10 mark must not crowd the rim');
});
