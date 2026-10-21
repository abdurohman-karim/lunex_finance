import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { InputController } from './input.controller.js';
import { PhraseParserService } from './phrase-parser.service.js';

/** Voice and text input of operations (`POST /v1/ai/parse`). */
@Module({
  imports: [AiModule],
  controllers: [InputController],
  providers: [PhraseParserService],
})
export class InputModule {}
