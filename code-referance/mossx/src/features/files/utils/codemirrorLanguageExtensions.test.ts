import { describe, expect, it } from "vitest";
import { codeMirrorExtensionsForPath } from "./codemirrorLanguageExtensions";

describe("codeMirrorExtensionsForPath", () => {
  it("returns editor extensions for java/spring/python/sql/toml/gitignore/lock paths", () => {
    expect(codeMirrorExtensionsForPath("src/main/java/App.java").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("src/main/resources/pom.xml").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("src/main/resources/application.properties").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("scripts/main.py").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("src/main/resources/application.yml").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("queries/report.sql").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("configs/settings.toml").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath(".gitignore").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("Cargo.lock").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("yarn.lock").length).toBeGreaterThan(0);
  });

  it("keeps baseline editor language coverage", () => {
    expect(codeMirrorExtensionsForPath("src/main.ts").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("src/main.js").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("src/view.json").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("README.md").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("styles/main.css").length).toBeGreaterThan(0);
    expect(codeMirrorExtensionsForPath("config/settings.yaml").length).toBeGreaterThan(0);
  });

  it("falls back to plain text for unsupported types", () => {
    expect(codeMirrorExtensionsForPath("assets/logo.bmp")).toEqual([]);
    expect(codeMirrorExtensionsForPath("README")).toEqual([]);
  });
});
