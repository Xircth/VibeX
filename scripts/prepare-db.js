#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const checkMode = process.argv.includes("--check");

console.log(
  checkMode
    ? "Checking SQLx prepared queries..."
    : "Preparing database for SQLx...",
);

// Change to backend directory
const backendDir = path.join(__dirname, "..", "crates/db");
process.chdir(backendDir);

// Create temporary database file
const dbFile = path.join(backendDir, "prepare_db.sqlite");
fs.writeFileSync(dbFile, "");

function toSqliteUrl(filePath) {
  const normalizedPath = path.resolve(filePath).replace(/\\/g, "/");

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `sqlite:///${normalizedPath}`;
  }

  return `sqlite://${normalizedPath}`;
}

function ensureCargoSqlxInstalled() {
  try {
    execSync("cargo sqlx --version", {
      stdio: "ignore",
      env: process.env,
    });
  } catch {
    throw new Error(
      "Missing required Cargo subcommand `cargo sqlx`. Install it with `cargo install sqlx-cli --no-default-features --features sqlite` and rerun prepare-db.",
    );
  }
}

try {
  // Get absolute path (cross-platform)
  const databaseUrl = toSqliteUrl(dbFile);

  console.log(`Using database: ${databaseUrl}`);

  ensureCargoSqlxInstalled();

  // Run migrations
  console.log("Running migrations...");
  execSync("cargo sqlx migrate run", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Prepare queries
  const sqlxCommand = checkMode
    ? "cargo sqlx prepare --check"
    : "cargo sqlx prepare";
  console.log(
    checkMode ? "Checking prepared queries..." : "Preparing queries...",
  );
  execSync(sqlxCommand, {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  console.log(
    checkMode ? "SQLx check complete!" : "Database preparation complete!",
  );
} finally {
  // Clean up temporary file
  if (fs.existsSync(dbFile)) {
    fs.unlinkSync(dbFile);
  }
}
