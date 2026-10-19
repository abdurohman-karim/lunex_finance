import { Global, Module } from '@nestjs/common';
import { AppSettingsService } from './app-settings.service.js';
import { RateLimiter } from './rate-limiter.service.js';

@Global()
@Module({
  providers: [RateLimiter, AppSettingsService],
  exports: [RateLimiter, AppSettingsService],
})
export class CommonModule {}
