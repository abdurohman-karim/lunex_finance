import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

/** Photos attached to operations (`/v1/attachments`). */
@Module({
  imports: [BillingModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
