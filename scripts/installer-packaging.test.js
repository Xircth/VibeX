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

test("Windows installer logo BMPs exist for every DPI bucket at integer sizes", () => {
  // Large logo 64 @ 100/125/150/200% -> 64/80/96/128; small logo 48 -> 48/60/72/96.
  const sizes = [48, 60, 64, 72, 80, 96, 128];
  const themes = [
    { name: "light", bg: [255, 255, 255], squircleLight: false },
    { name: "dark", bg: [31, 31, 31], squircleLight: true },
  ];
  for (const theme of themes) {
    for (const size of sizes) {
      const name = `icon-${theme.name}-${size}.bmp`;
      const bmp = readBmpInfo(path.join(ASSETS_DIR, name));
      assert.equal(bmp.width, size, `${name} width`);
      assert.equal(bmp.height, size, `${name} height`);
      assert.deepEqual(bmp.getRgb(0, 0), theme.bg, `${name} corner = window background`);
      // A point inside the squircle near its edge: light-on-dark for the dark theme.
      const [r, g, b] = bmp.getRgb(Math.round(size * 0.2), Math.round(size / 2));
      const luma = (r + g + b) / 3;
      if (theme.squircleLight) {
        assert.ok(luma > 180, `${name} dark-theme logo must be light (got ${luma})`);
      } else {
        assert.ok(luma < 80, `${name} light-theme logo must be dark (got ${luma})`);
      }
    }
  }
});

test("Windows Tauri config wires the custom installer template", () => {
  const winConf = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.windows.conf.json"), "utf8"),
  );
  assert.equal(winConf.bundle.windows.nsis.template, "installer/installer.nsi");
  assert.equal(winConf.bundle.windows.nsis.installerHooks, "installer/hooks.nsh");
  assert.deepEqual(winConf.bundle.windows.nsis.languages, ["SimpChinese", "English"]);
});

test("Windows NSIS custom template compiles cleanly with makensis when available", (t) => {
  // Windows: Tauri's bundled NSIS. Elsewhere: makensis on PATH plus a folder of
  // Tauri's NSIS helpers (utils.nsh, FileAssociation.nsh, English.nsh,
  // SimpChinese.nsh, plugins/nsis_tauri_utils.dll) in VIBEX_NSIS_HELPER_DIR.
  const makensisCandidates = [
    path.join(ROOT, "target", ".tauri", "NSIS", "makensis.exe"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe")
      : "",
    process.platform !== "win32" ? "/usr/bin/makensis" : "",
    process.platform !== "win32" ? "/usr/local/bin/makensis" : "",
  ].filter(Boolean);
  const makensis = makensisCandidates.find((p) => fs.existsSync(p));
  const nsisHelperDir =
    process.env.VIBEX_NSIS_HELPER_DIR ||
    path.join(ROOT, "target", "release", "nsis", "x64");

  if (!makensis || !fs.existsSync(path.join(nsisHelperDir, "utils.nsh"))) {
    t.skip("makensis or Tauri NSIS helper scripts not present in this environment");
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-nsis-test-"));
  try {
    for (const helper of [
      "utils.nsh",
      "FileAssociation.nsh",
      "English.nsh",
      "SimpChinese.nsh",
    ]) {
      fs.copyFileSync(
        path.join(nsisHelperDir, helper),
        path.join(scratch, helper),
      );
    }
    const dummyBin = path.join(scratch, "vibex.exe");
    fs.writeFileSync(dummyBin, "MZ");
    const outExe = path.join(scratch, "VibeX-setup-test.exe");
    const hooksPath = path.join(INSTALLER_DIR, "hooks.nsh");
    const pluginsDir = fs.existsSync(path.join(nsisHelperDir, "plugins"))
      ? path.join(nsisHelperDir, "plugins")
      : path.join(path.dirname(makensis), "Plugins", "x86-unicode", "additional");
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
        `!include "${path.join(scratch, "English.nsh")}"\n!include "${path.join(scratch, "SimpChinese.nsh")}"`,
      )
      .replace(
        /\{\{#each file_associations[\s\S]*?\{\{\/each\}\}\s*\{\{\/each\}\}/g,
        "",
      )
      .replace(/\{\{#each [\s\S]*?\{\{\/each\}\}/g, "");

    const renderedNsi = path.join(scratch, "installer.nsi");
    fs.writeFileSync(renderedNsi, tpl, "utf8");
    if (process.env.VIBEX_NSIS_KEEP_RENDERED) {
      fs.copyFileSync(renderedNsi, process.env.VIBEX_NSIS_KEEP_RENDERED);
    }
    const output = execFileSync(makensis, ["-INPUTCHARSET", "UTF8", renderedNsi], {
      cwd: scratch,
      encoding: "utf8",
    });
    assert.doesNotMatch(
      output,
      /warning 6000|warning 6001/i,
      `makensis emitted variable warnings:\n${output}`,
    );
    assert.ok(fs.existsSync(outExe), "makensis must produce output installer");
    if (process.env.VIBEX_NSIS_KEEP_OUTPUT) {
      fs.copyFileSync(outExe, process.env.VIBEX_NSIS_KEEP_OUTPUT);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
