import { existsSync, mkdirSync } from "fs";

import type { ApiConfig } from "../config";
import path from "path";

export function ensureAssetsDir(cfg: ApiConfig) {
  if (!existsSync(cfg.assetsRoot)) {
    mkdirSync(cfg.assetsRoot, { recursive: true });
  }
}

export function getFileExt(mediaType: string) {
  const parts = mediaType.split("/");
  if (parts.length !== 2) {
    return ".bin";
  }
  return "." + parts[1];
}

export function getAssetPath(cfg: ApiConfig, filename: string) {
  return path.join(cfg.assetsRoot, filename);
}

export function getAssetURL(cfg: ApiConfig, filename: string) {
  return `http://localhost:${cfg.port}/assets/${filename}`;
}
