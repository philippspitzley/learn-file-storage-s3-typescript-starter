import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import { file, type BunRequest } from "bun";
import { BadRequestError, NotFoundError } from "./errors";

import path from "node:path";
import { getAssetPath, getAssetURL, getFileExt } from "./assets";
import { randomBytes } from "node:crypto";

const MAX_UPLOAD_SIZE = 10 << 20; // bit-shifting is same as 10 * 1024 * 1024 = 10MB

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");
  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail file is missing.");
  }

  if (thumbnail.type !== "image/png" && thumbnail.type !== "image/jpeg") {
    throw new BadRequestError("Only png and jpeg files are allowed.");
  }

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail size is too big.");
  }

  const imgData = await thumbnail.arrayBuffer();
  const metaData = getVideo(cfg.db, videoId);

  if (!metaData) {
    throw new NotFoundError("Video metadata not found");
  }

  //const assetFilename = videoId + getFileExt(thumbnail.type);
  const assetFilename =
    randomBytes(32).toString("base64url") + getFileExt(thumbnail.type);
  console.log(assetFilename);
  const assetPath = getAssetPath(cfg, assetFilename);
  const thumbnailURL = getAssetURL(cfg, assetFilename);

  Bun.write(assetPath, imgData);

  metaData.thumbnailURL = thumbnailURL;

  updateVideo(cfg.db, metaData);

  return respondWithJSON(200, metaData);
}
