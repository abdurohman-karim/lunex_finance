import { Readable } from 'node:stream';
import { Controller, Get, Header, StreamableFile } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { DataExportService } from './data-export.service.js';
import { zip } from './zip.js';

/** An archive is heavy to make: a few an hour are plenty for anyone. */
const EXPORTS_PER_HOUR = 5;

@Controller('me')
export class DataExportController {
  constructor(
    private readonly exports: DataExportService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /** «Экспорт всех своих данных»: a ZIP with `data.json` and the photos of receipts. */
  @Get('export')
  @Header('Cache-Control', 'no-store')
  async export(@CurrentUser() user: AuthUser): Promise<StreamableFile> {
    await this.rateLimiter.consume(
      `export:${user.userId}`,
      EXPORTS_PER_HOUR,
      60 * 60,
    );
    const now = new Date();
    const entries = await this.exports.entries(user.userId, now);
    const day = now.toISOString().slice(0, 10);
    return new StreamableFile(Readable.from(zip(entries, now)), {
      type: 'application/zip',
      disposition: `attachment; filename="lunex-export-${day}.zip"`,
    });
  }
}
