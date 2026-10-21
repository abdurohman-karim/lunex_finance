import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { InputController } from './input.controller.js';
import { PhraseParserService } from './phrase-parser.service.js';
import { ReceiptReaderService } from './receipt-reader.service.js';

/** Voice and text input of operations and receipts (`POST /v1/ai/parse`, `/v1/ai/receipt`). */
@Module({
  imports: [AiModule, BillingModule],
  controllers: [InputController],
  providers: [PhraseParserService, ReceiptReaderService],
})
export class InputModule {}
