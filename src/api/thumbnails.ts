import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError } from "./errors";

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

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail size is too big.");
  }
  const mediaType = thumbnail.type;
  const imgData = await thumbnail.arrayBuffer();
  const metaData = getVideo(cfg.db, videoId);

  if (!metaData) {
    throw new NotFoundError("Video metadata not found");
  }

  const thumbnailBuffer = Buffer.from(imgData).toString("base64");
  const thumbnailURL = `data:${mediaType};base64,${thumbnailBuffer}`;

  metaData.thumbnailURL = thumbnailURL;

  updateVideo(cfg.db, metaData);

  return respondWithJSON(200, metaData);
}
