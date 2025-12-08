import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { randomBytes } from "node:crypto";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { getAssetPath } from "./assets";

const MAX_UPLOAD_SIZE = 1 << 30; // bit shifting, 1 * 1024 * 1024 * 1024 = 1GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId: videoID } = req.params as { videoId?: string };
  console.log("PARAMS:", req.params);
  console.log("VIDEO ID:", videoID);
  if (!videoID) {
    throw new BadRequestError("Invalid video ID");
  }

  // validate user
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  // upload video
  console.log("uploading video", videoID, "by user", userID);

  const metaData = getVideo(cfg.db, videoID);

  if (!metaData) {
    throw new NotFoundError("Video metadata not found");
  }

  if (metaData.userID !== userID) {
    throw new UserForbiddenError("Your are not allowed to edit this video");
  }

  const formData = await req.formData();
  const video = formData.get("video");

  if (!(video instanceof File)) {
    throw new BadRequestError("Video file is missing.");
  }

  if (video.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exeeds the upload limit.");
  }

  if (video.type !== "video/mp4") {
    throw new BadRequestError("Only mp4 files are allowed.");
  }

  const videoData = await video.arrayBuffer();
  const filename = `${randomBytes(32).toString("base64url")}.${video.type.split("/")[1]}`;
  const assetPath = getAssetPath(cfg, filename);
  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${filename}`;

  // Create temporary file on disk
  const tempFile = Bun.file(assetPath);
  await tempFile.write(videoData);

  // Save video in aws bucket
  const file = cfg.s3Client.file(filename);
  await file.write(videoData, { type: "video/mp4" });

  // Update db entry
  metaData.videoURL = videoURL;
  updateVideo(cfg.db, metaData);

  // Delete temp video file
  await tempFile.delete();

  return respondWithJSON(200, null);
}
