const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("vibex plugin pack creates a validated VXP package", () => {
  const root = mkdtempSync(join(tmpdir(), "vibex-cli-plugin-"));
  const output = join(root, "test.vxp");
  try {
    writeFixture(root);
    const result = spawnSync(
      process.execPath,
      [join(__dirname, "cli.js"), "plugin", "pack", root, "--output", output],
      {
        encoding: "utf8",
        env: { ...process.env, VIBEX_LOCAL: "1" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /test\.vxp\nsha256:[a-f0-9]{64}/u);
    assert.equal(existsSync(output), true);
    assert.equal(readFileSync(output).subarray(0, 2).toString("ascii"), "PK");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(__dirname, "..", "dist"), { recursive: true, force: true });
  }
});

test("plugin add extracts a vxp whose entries have no unix mode bits", () => {
  const { extractArchive, pickRoot, findPluginRoots } = require("./plugin");
  const root = mkdtempSync(join(tmpdir(), "vibex-plugin-lock-"));
  const dest = mkdtempSync(join(tmpdir(), "vibex-plugin-out-"));
  try {
    writeFixture(root);
    const archive = join(root, "locked.vxp");
    const packed = spawnSync(
      "python3",
      [
        "-c",
        [
          "import os, sys, zipfile",
          "src, dest = sys.argv[1], sys.argv[2]",
          "z = zipfile.ZipFile(dest, 'w')",
          "for dirpath, dirnames, filenames in os.walk(src):",
          "  for name in filenames:",
          "    full = os.path.join(dirpath, name)",
          "    rel = os.path.relpath(full, src).replace(os.sep, '/')",
          "    if rel.endswith('.vxp'):",
          "      continue",
          "    info = zipfile.ZipInfo(rel)",
          "    info.external_attr = 0",
          "    with open(full, 'rb') as fh:",
          "      z.writestr(info, fh.read())",
          "z.close()",
        ].join("\n"),
        root,
        archive,
      ],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    extractArchive(archive, dest);
    const found = findPluginRoots(dest);
    const picked = pickRoot(found, "test");
    assert.equal(picked.id, "test");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("plugin add discovers a local Host token without VIBEX_TOKEN", () => {
  const { discoverHost } = require("./plugin");
  const dir = mkdtempSync(join(tmpdir(), "vibex-host-"));
  const prevDir = process.env.VIBEX_DATA_DIR;
  const prevToken = process.env.VIBEX_TOKEN;
  const prevUrl = process.env.VIBEX_URL;
  try {
    delete process.env.VIBEX_TOKEN;
    delete process.env.VIBEX_URL;
    process.env.VIBEX_DATA_DIR = dir;
    writeFileSync(join(dir, "host.token"), "vbx_local_host_token_value_for_tests\n");
    const host = discoverHost();
    assert.equal(host.token, "vbx_local_host_token_value_for_tests");
    assert.match(host.url, /127\.0\.0\.1:17891/);
  } finally {
    if (prevDir === undefined) delete process.env.VIBEX_DATA_DIR;
    else process.env.VIBEX_DATA_DIR = prevDir;
    if (prevToken === undefined) delete process.env.VIBEX_TOKEN;
    else process.env.VIBEX_TOKEN = prevToken;
    if (prevUrl === undefined) delete process.env.VIBEX_URL;
    else process.env.VIBEX_URL = prevUrl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin add resolves marketplace and GitHub sources", async () => {
  const { resolveSource, findPluginRoots, pickRoot } = require("./plugin");
  const github = await resolveSource("https://github.com/acme/office", "office");
  assert.match(github.url, /codeload\.github\.com\/acme\/office/);
  const shorthand = await resolveSource("acme/office");
  assert.match(shorthand.url, /codeload\.github\.com\/acme\/office/);
  const root = mkdtempSync(join(tmpdir(), "vibex-plugin-find-"));
  try {
    writeFixture(root);
    const found = findPluginRoots(root);
    assert.deepEqual(found, [root]);
    const picked = pickRoot(found, "test");
    assert.equal(picked.id, "test");
    assert.throws(() => pickRoot(found, "missing"), /not in the archive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin add parses --web, --profile, and --dev", () => {
  const { parseAddArgs, parseGitSource, inferAddMode } = require("./plugin");
  const web = parseAddArgs(["--web", "https://github.com/acme/office", "-y"]);
  assert.equal(web.mode, "web");
  assert.equal(web.source, "https://github.com/acme/office");
  assert.equal(web.flags.yes, true);
  const profile = parseAddArgs(["--profile", "~/plugins/search.vxp"]);
  assert.equal(profile.mode, "profile");
  assert.match(profile.source, /plugins[\\/]search\.vxp$/);
  const dev = parseAddArgs(["--dev", "~/Projects/office", "--detach"]);
  assert.equal(dev.mode, "dev");
  assert.equal(dev.flags.detach, true);
  assert.throws(
    () => parseAddArgs(["--web", "https://example.com", "--dev", "."]),
    /only one/,
  );
  assert.throws(() => parseAddArgs([]), /--web/);
  const git = parseGitSource("https://github.com/Xircth/vibex-plugin-office");
  assert.equal(git.url, "https://github.com/Xircth/vibex-plugin-office.git");
  assert.equal(git.ref, undefined);
  const branch = parseGitSource(
    "https://github.com/Xircth/vibex-plugin-office/tree/main",
  );
  assert.equal(branch.ref, "main");
  const tagged = parseGitSource(
    "https://github.com/Xircth/vibex-plugin-office#v1.2.0",
  );
  assert.equal(tagged.ref, "v1.2.0");
  const spec = parseGitSource("github:Xircth/vibex-plugin-office#v1.2.0");
  assert.equal(spec.url, "https://github.com/Xircth/vibex-plugin-office.git");
  assert.equal(spec.ref, "v1.2.0");
  const shorthandTag = parseGitSource("Xircth/vibex-plugin-office#v1.2.0");
  assert.equal(shorthandTag.ref, "v1.2.0");
  const commit = parseGitSource(
    "https://github.com/Xircth/vibex-plugin-office/commit/abcdef1",
  );
  assert.equal(commit.ref, "abcdef1");
  const archive = parseGitSource("https://example.com/search.vxp");
  assert.equal(archive, null);
  const root = mkdtempSync(join(tmpdir(), "vibex-plugin-infer-"));
  try {
    writeFixture(root);
    assert.equal(inferAddMode(root), "dev");
    const packed = join(root, "search.vxp");
    writeFileSync(packed, "PK");
    assert.equal(inferAddMode(packed), "profile");
    assert.equal(inferAddMode("acme/office"), "web");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin list formats catalog rows", () => {
  const { formatPluginList, pluginSourceLabel } = require("./plugin");
  assert.equal(formatPluginList([]), "No plugins installed.");
  assert.equal(
    pluginSourceLabel({ builtin: true, sourceKind: "snapshot" }),
    "builtin",
  );
  assert.equal(
    pluginSourceLabel({ sourceKind: "developer_link" }),
    "linked",
  );
  const table = formatPluginList([
    {
      id: "vibex.office",
      version: "3.0.0",
      sourceKind: "builtin",
      builtin: true,
      enabled: false,
    },
    {
      id: "acme.search",
      version: "1.2.0",
      sourceKind: "snapshot",
      enabled: true,
      sourceLocked: true,
      sourceRef: "v1.2.0",
    },
  ]);
  assert.match(table, /ID\s+VERSION\s+SOURCE\s+ENABLED\s+LOCK/);
  assert.match(table, /vibex\.office\s+3\.0\.0\s+builtin\s+off/);
  assert.match(table, /acme\.search\s+1\.2\.0\s+installed\s+on\s+v1\.2\.0/);
});

test("plugin add parses GitHub release URLs", () => {
  const { parseGithubReleaseSpec } = require("./plugin");
  const tagged = parseGithubReleaseSpec(
    "https://github.com/acme/search/releases/tag/v1.2.0",
  );
  assert.equal(tagged.owner, "acme");
  assert.equal(tagged.repo, "search");
  assert.equal(tagged.tag, "v1.2.0");
  const latest = parseGithubReleaseSpec(
    "https://github.com/acme/search/releases/latest",
  );
  assert.equal(latest.tag, "latest");
  const asset = parseGithubReleaseSpec(
    "https://github.com/acme/search/releases/download/v1.2.0/search-1.2.0.vxp",
  );
  assert.equal(asset.tag, "v1.2.0");
  assert.match(asset.assetUrl, /\.vxp$/);
  const spec = parseGithubReleaseSpec("github:acme/search/releases/v1.2.0");
  assert.equal(spec.tag, "v1.2.0");
});

function writeFixture(root) {
  mkdirSync(join(root, ".vibex-plugin"), { recursive: true });
  mkdirSync(join(root, "contents", "skills", "test"), { recursive: true });
  writeFileSync(
    join(root, ".vibex-plugin", "plugin.json"),
    JSON.stringify({
      manifestVersion: 4,
      apiVersion: "1.0",
      id: "test",
      publisher: "tests",
      version: "1.0.0",
      name: "Test",
      readme: "README.md",
      engines: { vibex: ">=0.1.3", pluginSdk: "^1.0.0" },
      content: {
        root: "contents",
        index: ".vibex-plugin/content.index.json",
      },
      config: {
        schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      permissions: [],
      integrations: [
        {
          id: "test",
          kind: "content.skill",
          resource: "contents/skills/test",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, ".vibex-plugin", "content.index.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          path: "contents/skills/test/SKILL.md",
          kind: "skill",
          title: "Test skill",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "README.md"),
    "---\nsummary: Test the VibeX plugin pack command.\n---\n# Test\n",
  );
  writeFileSync(join(root, "config.json"), "{}\n");
  writeFileSync(
    join(root, "contents", "skills", "test", "SKILL.md"),
    "---\nname: test\ndescription: Test skill.\n---\n",
  );
}
