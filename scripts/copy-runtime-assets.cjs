#!/usr/bin/env node

const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const assets = [
  {
    source: join(root, "core", "storage", "migrations"),
    target: join(root, "dist", "core", "storage", "migrations"),
  },
];

for (const asset of assets) {
  if (!existsSync(asset.source)) {
    throw new Error(`runtime asset source does not exist: ${asset.source}`);
  }
  mkdirSync(asset.target, { recursive: true });
  cpSync(asset.source, asset.target, { recursive: true, force: true });
}
