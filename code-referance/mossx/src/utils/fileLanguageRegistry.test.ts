import { describe, expect, it } from "vitest";
import {
  resolveEditorLanguageFromPath,
  resolveFileLanguageFromPath,
  resolvePreviewLanguageFromPath,
} from "./fileLanguageRegistry";

describe("fileLanguageRegistry", () => {
  it("supports filename-priority rules before extension fallback", () => {
    expect(resolveFileLanguageFromPath("pom.xml")).toMatchObject({
      previewLanguage: "markup",
      editorLanguage: "xml",
      matchedBy: "filename",
    });

    expect(resolveFileLanguageFromPath("config/application-dev.properties")).toMatchObject({
      previewLanguage: "properties",
      editorLanguage: "properties",
      matchedBy: "filename",
    });

    expect(resolveFileLanguageFromPath("config/application-prod.yml")).toMatchObject({
      previewLanguage: "yaml",
      editorLanguage: "yaml",
      matchedBy: "filename",
    });

    expect(resolveFileLanguageFromPath(".gitignore")).toMatchObject({
      previewLanguage: "git",
      editorLanguage: "shell",
      matchedBy: "filename",
    });

    expect(resolveFileLanguageFromPath("Cargo.lock")).toMatchObject({
      previewLanguage: "toml",
      editorLanguage: "toml",
      matchedBy: "filename",
    });
  });

  it("covers new language types for java/spring/python/sql/toml/lock", () => {
    expect(resolveFileLanguageFromPath("src/main/java/App.java")).toMatchObject({
      previewLanguage: "java",
      editorLanguage: "java",
    });
    expect(resolveFileLanguageFromPath("src/main/resources/logback-spring.xml")).toMatchObject({
      previewLanguage: "markup",
      editorLanguage: "xml",
    });
    expect(resolveFileLanguageFromPath("service/main.py")).toMatchObject({
      previewLanguage: "python",
      editorLanguage: "python",
    });
    expect(resolveFileLanguageFromPath("src/main/resources/application.properties")).toMatchObject({
      previewLanguage: "properties",
      editorLanguage: "properties",
    });
    expect(resolveFileLanguageFromPath("queries/report.sql")).toMatchObject({
      previewLanguage: "sql",
      editorLanguage: "sql",
    });
    expect(resolveFileLanguageFromPath("configs/settings.toml")).toMatchObject({
      previewLanguage: "toml",
      editorLanguage: "toml",
    });
    expect(resolveFileLanguageFromPath("yarn.lock")).toMatchObject({
      previewLanguage: "yaml",
      editorLanguage: "yaml",
      matchedBy: "extension",
    });
  });

  it("keeps baseline mappings unchanged for existing supported types", () => {
    const baselineCases = [
      {
        path: "src/main.ts",
        previewLanguage: "typescript",
        editorLanguage: "typescript",
      },
      {
        path: "src/view.js",
        previewLanguage: "javascript",
        editorLanguage: "javascript",
      },
      {
        path: "styles/main.css",
        previewLanguage: "css",
        editorLanguage: "css",
      },
      {
        path: "README.md",
        previewLanguage: "markdown",
        editorLanguage: "markdown",
      },
      {
        path: "package.json",
        previewLanguage: "json",
        editorLanguage: "json",
      },
      {
        path: "config/application.yaml",
        previewLanguage: "yaml",
        editorLanguage: "yaml",
      },
    ] as const;

    for (const testCase of baselineCases) {
      expect(resolvePreviewLanguageFromPath(testCase.path)).toBe(testCase.previewLanguage);
      expect(resolveEditorLanguageFromPath(testCase.path)).toBe(testCase.editorLanguage);
    }
  });

  it("falls back safely for unknown file types", () => {
    expect(resolveFileLanguageFromPath("assets/data.unknown")).toEqual({
      previewLanguage: null,
      editorLanguage: null,
      matchedBy: "none",
    });
    expect(resolveFileLanguageFromPath("README")).toEqual({
      previewLanguage: null,
      editorLanguage: null,
      matchedBy: "none",
    });
  });
});
