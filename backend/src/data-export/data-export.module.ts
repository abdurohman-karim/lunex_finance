import { Module } from '@nestjs/common';
import { DataExportController } from './data-export.controller.js';
import { DataExportService } from './data-export.service.js';

/** Everything of a user in one archive (`GET /v1/me/export`). */
@Module({
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class DataExportModule {}
