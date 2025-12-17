import type { BunRequest } from "bun";
import { randomBytes } from "node:crypto";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { getAssetPath } from "./assets";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { respondWithJSON } from "./json";

type AspectRatio = "landscape" | "portrait" | "other";

const MAX_UPLOAD_SIZE = 1 << 30; // bit shifting, 1 * 1024 * 1024 * 1024 = 1GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId: videoID } = req.params as { videoId?: string };

  if (!videoID) {
    throw new BadRequestError("Invalid video ID");
  }

  // validate user
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoID, "by user", userID);

  const video = getVideo(cfg.db, videoID);

  if (!video) {
    throw new NotFoundError("Video metadata not found");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Your are not allowed to edit this video");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");

  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video file is missing.");
  }

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exeeds the upload limit.");
  }

  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Only mp4 files are allowed.");
  }

  const videoData = await videoFile.arrayBuffer();
  const filename = `${randomBytes(32).toString("base64url")}.${videoFile.type.split("/")[1]}`;
  const assetPath = getAssetPath(cfg, filename);

  // Create temporary file on disk
  const tempFile = Bun.file(assetPath);
  await tempFile.write(videoData);

  // Create and Process temporary fast start video
  const processedFilePath = await processVideoForFastStart(assetPath);
  const processedTempFile = Bun.file(processedFilePath);

  // Save fast start video in aws bucket
  const aspectRatio = await getVideoAspectRatio(processedFilePath);
  const key = `${aspectRatio}/${filename}`;
  await uploadVideoToS3(cfg, key, processedTempFile, "video/mp4");

  // Update db entry
  video.videoURL = `${cfg.s3CfDistribution}/${key}`;
  updateVideo(cfg.db, video);

  // Delete temp video files
  await tempFile.delete();
  await processedTempFile.delete();

  return respondWithJSON(200, video);
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

export async function uploadVideoToS3(
  cfg: ApiConfig,
  key: string,
  processedFile: Bun.BunFile,
  contentType: string,
) {
  const s3file = cfg.s3Client.file(key, { bucket: cfg.s3Bucket });
  await s3file.write(processedFile, { type: contentType });
}
