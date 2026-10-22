const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const INSTALLER_DIR = path.join(ROOT, "src-tauri", "installer");
const ASSETS_DIR = path.join(INSTALLER_DIR, "assets");

function readBmpInfo(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.toString("ascii", 0, 2), "BM", `${filePath} must be BMP`);
  const pixelOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bpp = buf.readUInt16LE(28);
  assert.equal(bpp, 24, `${filePath} must be 24-bit RGB BMP`);
  const rowStride = Math.floor((width * 3 + 3) / 4) * 4;

  function getRgb(x, y) {
    const bmpY = rawHeight > 0 ? height - 1 - y : y;
    const idx = pixelOffset + bmpY * rowStride + x * 3;
    return [buf[idx + 2], buf[idx + 1], buf[idx]];
  }

  return { width, height, getRgb };
}

test("Windows brand BMPs place the VibeX wordmark vertically below the logo", () => {
  const specs = [
    { name: "brand-light.bmp", w: 480, h: 124, bg: [255, 255, 255] },
    { name: "brand-light-2x.bmp", w: 960, h: 248, bg: [255, 255, 255] },
    { name: "brand-dark.bmp", w: 480, h: 124, bg: [27, 27, 27] },
    { name: "brand-dark-2x.bmp", w: 960, h: 248, bg: [27, 27, 27] },
  ];

  for (const spec of specs) {
    const bmp = readBmpInfo(path.join(ASSETS_DIR, spec.name));
    assert.equal(bmp.width, spec.w, `${spec.name} width`);
    assert.equal(bmp.height, spec.h, `${spec.name} height`);
    assert.deepEqual(
      bmp.getRgb(4, 4),
      spec.bg,
      `${spec.name} top-left background`,
    );

    const scale = spec.w / 480;
    // Upper band (y = 12..60 * scale): centered logo mark
    let logoPixels = 0;
    for (let y = 12 * scale; y < 60 * scale; y += 1) {
      for (let x = 216 * scale; x < 264 * scale; x += 1) {
        const [r, g, b] = bmp.getRgb(x, y);
        if (
          Math.abs(r - spec.bg[0]) +
            Math.abs(g - spec.bg[1]) +
            Math.abs(b - spec.bg[2]) >
          24
        ) {
          logoPixels += 1;
        }
      }
    }
    assert.ok(logoPixels > 100, `${spec.name} must contain centered top logo`);

    // Lower band (y = 80..112 * scale): centered VibeX text below logo
    let textPixels = 0;
    for (let y = 80 * scale; y < 112 * scale; y += 1) {
      for (let x = 195 * scale; x < 285 * scale; x += 1) {
        const [r, g, b] = bmp.getRgb(x, y);
        if (
          Math.abs(r - spec.bg[0]) +
            Math.abs(g - spec.bg[1]) +
            Math.abs(b - spec.bg[2]) >
          30
        ) {
          textPixels += 1;
        }
      }
    }
    assert.ok(
      textPixels > 40,
      `${spec.name} must render VibeX text below the logo`,
    );
  }
});

test("Windows and macOS Tauri configs wire the minimal installer templates", () => {
  const winConf = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "src-tauri", "tauri.windows.conf.json"),
      "utf8",
    ),
  );
  assert.equal(winConf.bundle.windows.nsis.template, "installer/installer.nsi");
  assert.equal(
    winConf.bundle.windows.nsis.installerHooks,
    "installer/hooks.nsh",
  );
  assert.deepEqual(winConf.bundle.windows.nsis.languages, [
    "SimpChinese",
    "English",
  ]);

  const macConf = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "src-tauri", "tauri.macos.conf.json"),
      "utf8",
    ),
  );
  const dmg = macConf.bundle.macOS.dmg;
  assert.equal(dmg.background, "installer/assets/dmg-background.png");
  assert.deepEqual(dmg.windowSize, { width: 540, height: 360 });
  assert.deepEqual(dmg.appPosition, { x: 150, y: 175 });
  assert.deepEqual(dmg.applicationFolderPosition, { x: 390, y: 175 });
  assert.ok(
    fs.existsSync(path.join(ROOT, "src-tauri", dmg.background)),
    "macOS DMG background PNG must exist",
  );
});

test("Windows NSIS custom template compiles cleanly with makensis when available", (t) => {
  const makensisCandidates = [
    path.join(ROOT, "target", ".tauri", "NSIS", "makensis.exe"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe")
      : "",
  ].filter(Boolean);
  const makensis = makensisCandidates.find((p) => fs.existsSync(p));
  const nsisHelperDir = path.join(ROOT, "target", "release", "nsis", "x64");

  if (
    process.platform !== "win32" ||
    !makensis ||
    !fs.existsSync(path.join(nsisHelperDir, "utils.nsh"))
  ) {
    t.skip("makensis or Tauri NSIS helper scripts not present in this environment");
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-nsis-test-"));
  try {
    for (const helper of ["utils.nsh", "FileAssociation.nsh", "English.nsh"]) {
      fs.copyFileSync(
        path.join(nsisHelperDir, helper),
        path.join(scratch, helper),
      );
    }
    const dummyBin = path.join(scratch, "vibex.exe");
    fs.writeFileSync(dummyBin, "MZ");
    const outExe = path.join(scratch, "VibeX-setup-test.exe");
    const hooksPath = path.join(INSTALLER_DIR, "hooks.nsh");
    const pluginsDir = path.join(
      path.dirname(makensis),
      "Plugins",
      "x86-unicode",
      "additional",
    );

    let tpl = fs.readFileSync(
      path.join(INSTALLER_DIR, "installer.nsi"),
      "utf8",
    );
    tpl = tpl
      .replace(/\{\{compression\}\}/g, "none")
      .replace(
        /\{\{#if installer_hooks\}\}[\s\S]*?\{\{\/if\}\}/g,
        `!include "${hooksPath}"`,
      )
      .replace(/\{\{manufacturer\}\}/g, "vibex")
      .replace(/\{\{product_name\}\}/g, "VibeX")
      .replace(/\{\{version\}\}/g, "0.3.0")
      .replace(/\{\{version_with_build\}\}/g, "0.3.0.0")
      .replace(/\{\{homepage\}\}/g, "")
      .replace(/\{\{install_mode\}\}/g, "currentUser")
      .replace(/\{\{license\}\}/g, "")
      .replace(
        /\{\{installer_icon\}\}/g,
        path.join(ROOT, "src-tauri", "icons", "icon.ico"),
      )
      .replace(/\{\{sidebar_image\}\}/g, "")
      .replace(/\{\{header_image\}\}/g, "")
      .replace(/\{\{main_binary_name\}\}/g, "vibex")
      .replace(/\{\{main_binary_path\}\}/g, dummyBin)
      .replace(/\{\{bundle_id\}\}/g, "com.vibex.app")
      .replace(/\{\{copyright\}\}/g, "")
      .replace(/\{\{out_file\}\}/g, outExe)
      .replace(/\{\{arch\}\}/g, "x64")
      .replace(/\{\{additional_plugins_path\}\}/g, pluginsDir)
      .replace(/\{\{allow_downgrades\}\}/g, "true")
      .replace(/\{\{display_language_selector\}\}/g, "false")
      .replace(/\{\{install_webview2_mode\}\}/g, "downloadBootstrapper")
      .replace(/\{\{webview2_installer_args\}\}/g, "/silent")
      .replace(/\{\{webview2_bootstrapper_path\}\}/g, "")
      .replace(/\{\{webview2_installer_path\}\}/g, "")
      .replace(/\{\{minimum_webview2_version\}\}/g, "")
      .replace(/\{\{uninstaller_sign_cmd\}\}/g, "")
      .replace(/\{\{estimated_size\}\}/g, "1024")
      .replace(/\{\{start_menu_folder\}\}/g, "")
      .replace(
        /\{\{#each languages\}\}[\s\S]*?\{\{\/each\}\}/g,
        '!insertmacro MUI_LANGUAGE "SimpChinese"\n!insertmacro MUI_LANGUAGE "English"',
      )
      .replace(
        /\{\{#each language_files\}\}[\s\S]*?\{\{\/each\}\}/g,
        `!include "${path.join(scratch, "English.nsh")}"`,
      )
      .replace(
        /\{\{#each file_associations[\s\S]*?\{\{\/each\}\}\s*\{\{\/each\}\}/g,
        "",
      )
      .replace(/\{\{#each [\s\S]*?\{\{\/each\}\}/g, "");

    const renderedNsi = path.join(scratch, "installer.nsi");
    fs.writeFileSync(renderedNsi, tpl, "utf8");
    const output = execFileSync(makensis, [renderedNsi], {
      cwd: scratch,
      encoding: "utf8",
    });
    assert.doesNotMatch(
      output,
      /warning 6000|warning 6001/i,
      `makensis emitted variable warnings:\n${output}`,
    );
    assert.ok(fs.existsSync(outExe), "makensis must produce output installer");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
