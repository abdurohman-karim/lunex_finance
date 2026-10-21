import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/**
 * Where photos of receipts live (spec: «Объектное хранилище»): a folder on this server's disk,
 * one subfolder per user, so deleting an account removes them all at once. Production keeps it
 * on a volume (`deploy/compose.yaml`); an S3-compatible bucket can take its place behind the
 * same methods.
 */
@Injectable()
export class AttachmentStorage {
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = resolve(config.get('STORAGE_DIR', { infer: true }));
  }

  key(userId: string, attachmentId: string): string {
    return `${userId}/${attachmentId}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written aside and renamed, so a reader never sees half a photo.
    const partial = `${path}.part`;
    await writeFile(partial, data);
    await rename(partial, path);
  }

  /** The file, or null when it is not there. */
  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async removeUser(userId: string): Promise<void> {
    await rm(this.path(userId), { recursive: true, force: true });
  }

  /** Keys are made of ids, but a path never leaves the root whatever comes in. */
  private path(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) {
      throw new Error(`Storage key outside the root: ${key}`);
    }
    return path;
  }
}
