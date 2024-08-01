import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { extractTar, listTar } from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import * as path from "path";
import * as fs from "fs-extra";
import { State } from "./state";
import {
  findObject,
  formatSize,
  getInputAsArray,
  getInputAsBoolean,
  isGhes,
  newMinio,
  setCacheHitOutput,
  setCacheHitLocal,
  saveMatchedKey,
} from "./utils";

process.on("uncaughtException", (e) => core.info("warning: " + e.message));

async function restoreCache() {
  try {
    const bucket = core.getInput("bucket", { required: true });
    const key = core.getInput("key", { required: true });
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");
    const restoreKeys = getInputAsArray("restore-keys");
    const local = core.getInput("local");
    const errorOnS3Exception = getInputAsBoolean("error-on-s3-exception");

    try {
      const compressionMethod = await utils.getCompressionMethod();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(
        await utils.createTempDirectory(),
        cacheFileName
      );

      // Inputs are re-evaluted before the post action, so we want to store the original values
      core.saveState(State.PrimaryKey, key);
      core.saveState(State.AccessKey, core.getInput("accessKey"));
      core.saveState(State.SecretKey, core.getInput("secretKey"));
      core.saveState(State.SessionToken, core.getInput("sessionToken"));

      if (local) {
        core.info("Local cache is enabled");

        const localKey = path.join(local, key, cacheFileName);

        core.info(`Looking for exact match: ${localKey}`);

        if (fs.existsSync(localKey)) {
          core.info("Local cache HIT! ✅");
          await fs.copy(localKey, archivePath);
          core.info("Local cache copied!");

          core.info("Extracting cache file...");
          await extractTar(archivePath, compressionMethod);

          saveMatchedKey(key);
          setCacheHitOutput(true);
          setCacheHitLocal(true);

          core.info("Cache restored from local successfully");
          return;
        } else {
          setCacheHitLocal(false);
          core.info("Local cache MISS! ❌");
        }
      }

      const mc = newMinio();

      const { item: obj, matchingKey } = await findObject(
        mc,
        bucket,
        key,
        restoreKeys,
        compressionMethod
      );
      core.debug("found cache object");
      saveMatchedKey(matchingKey);
      core.info(
        `Downloading cache from s3 to ${archivePath}. bucket: ${bucket}, object: ${obj.name}`
      );

      if (obj.name) {
        await mc.fGetObject(bucket, obj.name, archivePath);
      }

      if (core.isDebug()) {
        await listTar(archivePath, compressionMethod);
      }

      core.info(`Cache Size: ${formatSize(obj.size)} (${obj.size} bytes)`);

      await extractTar(archivePath, compressionMethod);
      setCacheHitOutput(matchingKey === key);
      core.info("Cache restored from s3 successfully");
    } catch (e: any) {
      setCacheHitOutput(false);
      if (errorOnS3Exception) {
        core.setFailed("Restore s3 cache failed: " + e.message);
      } else {
        core.info("Restore s3 cache failed: " + e.message);
      }
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Restore cache using fallback cache");
          const fallbackMatchingKey = await cache.restoreCache(
            paths,
            key,
            restoreKeys
          );
          if (fallbackMatchingKey) {
            setCacheHitOutput(fallbackMatchingKey === key);
            core.info("Fallback cache restored successfully");
          } else {
            core.info("Fallback cache restore failed");
          }
        }
      }
    }
  } catch (e: any) {
    core.setFailed(e.message);
  }
}

restoreCache();
