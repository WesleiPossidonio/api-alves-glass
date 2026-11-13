import * as dotenv from "dotenv";
import { Client } from "minio";
import fs from "node:fs";
import https from "node:https";

dotenv.config();

export function createMinioClient(env = process.env) {
  const endPoint = env.MINIO_ENDPOINT?.trim();
  const port = Number(env.MINIO_PORT);
  const useSSL = env.MINIO_USE_SSL === "true";
  const accessKey = env.MINIO_ACCESS_KEY;
  const secretKey = env.MINIO_SECRET_KEY;
  const region = env.MINIO_REGION?.trim() || undefined;

  if (!endPoint || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Valid MINIO_ENDPOINT and MINIO_PORT are required");
  }
  if (!accessKey || !secretKey) {
    throw new Error("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required");
  }
  if (env.MINIO_USE_SSL && !["true", "false"].includes(env.MINIO_USE_SSL)) {
    throw new Error("MINIO_USE_SSL must be true or false");
  }

  const options = { endPoint, port, useSSL, accessKey, secretKey };
  if (region) options.region = region;

  const caPath = env.MINIO_CA_CERT_PATH?.trim();
  if (caPath) {
    if (!useSSL) throw new Error("MINIO_CA_CERT_PATH requires MINIO_USE_SSL=true");
    options.transportAgent = new https.Agent({ ca: fs.readFileSync(caPath), keepAlive: true });
  }

  return new Client(options);
}

const minioClient = process.env.NODE_ENV === 'test'
  ? null
  : process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY
    ? createMinioClient()
    : null

export default minioClient;
