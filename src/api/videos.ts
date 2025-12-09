import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { randomBytes } from "node:crypto";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { getAssetPath } from "./assets";

type AspectRatio = "landscape" | "portrait" | "other";

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

  // Create temporary file on disk
  const tempFile = Bun.file(assetPath);
  await tempFile.write(videoData);

  // Process fast start video
  const processedFilePath = await processVideoForFastStart(assetPath);
  const processedTempFile = Bun.file(processedFilePath);

  // Save video in aws bucket
  const aspectRatio = await getVideoAspectRatio(processedFilePath);
  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatio}/${filename}`;
  const file = cfg.s3Client.file(`${aspectRatio}/${filename}`);
  await file.write(processedTempFile, { type: "video/mp4" });

  // Update db entry
  metaData.videoURL = videoURL;
  updateVideo(cfg.db, metaData);

  // Delete temp video file
  await tempFile.delete();
  await processedTempFile.delete();

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(
  filePath: string,
): Promise<AspectRatio> {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=display_aspect_ratio",
    "-of",
    "json",
    filePath,
  ]);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `FFprobe failed with exit code ${proc.exitCode}: ${stderr}`,
    );
  }

  const output = JSON.parse(stdout);

  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video stream found");
  }

  const aspectRatio = output.streams[0]["display_aspect_ratio"];

  return aspectRatio === "16:9"
    ? "landscape"
    : aspectRatio === "9:16"
      ? "portrait"
      : "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + ".processed";
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    { stderr: "pipe" },
  );

  const stderr = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`FFmpeg failed with exit code ${proc.exitCode}: ${stderr}`);
  }

  return outputFilePath;
}
