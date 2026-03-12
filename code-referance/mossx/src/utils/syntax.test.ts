import { describe, expect, it } from "vitest";
import { highlightLine, languageFromPath } from "./syntax";

describe("syntax", () => {
  it("resolves preview languages for java/spring/python/sql/toml/gitignore/lock files", () => {
    expect(languageFromPath("src/main/java/App.java")).toBe("java");
    expect(languageFromPath("pom.xml")).toBe("markup");
    expect(languageFromPath("src/main/resources/application.properties")).toBe("properties");
    expect(languageFromPath("scripts/main.py")).toBe("python");
    expect(languageFromPath("src/main/resources/application-dev.yml")).toBe("yaml");
    expect(languageFromPath("queries/report.sql")).toBe("sql");
    expect(languageFromPath("configs/settings.toml")).toBe("toml");
    expect(languageFromPath(".gitignore")).toBe("git");
    expect(languageFromPath("Cargo.lock")).toBe("toml");
    expect(languageFromPath("yarn.lock")).toBe("yaml");
  });

  it("keeps baseline preview language mappings", () => {
    expect(languageFromPath("src/main.ts")).toBe("typescript");
    expect(languageFromPath("src/main.js")).toBe("javascript");
    expect(languageFromPath("README.md")).toBe("markdown");
    expect(languageFromPath("styles/main.css")).toBe("css");
    expect(languageFromPath("config/settings.yaml")).toBe("yaml");
    expect(languageFromPath("data/sample.json")).toBe("json");
  });

  it("falls back to escaped plain text when language is unknown", () => {
    const highlighted = highlightLine("<tag>", "unknown-language");
    expect(highlighted).toBe("&lt;tag&gt;");
  });
});
