import { Global, Module } from '@nestjs/common';
import { AccessController } from './access.controller.js';
import { EntitlementsService } from './entitlements.service.js';
import { ProFeatureGuard } from './requires-pro.js';

/** Global so any feature module can use @RequiresPro() and EntitlementsService without importing it. */
@Global()
@Module({
  controllers: [AccessController],
  providers: [EntitlementsService, ProFeatureGuard],
  exports: [EntitlementsService, ProFeatureGuard],
})
export class BillingModule {}
