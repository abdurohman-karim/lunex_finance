import { Global, Module } from '@nestjs/common';
import { AccessController } from './access.controller.js';
import { AppStoreApi } from './app-store/app-store-api.js';
import { AppStoreController } from './app-store/app-store.controller.js';
import { AppStoreService } from './app-store/app-store.service.js';
import { AppStoreVerifier } from './app-store/app-store-verifier.js';
import { EntitlementsService } from './entitlements.service.js';
import { ProFeatureGuard } from './requires-pro.js';

/** Global so any feature module can use @RequiresPro() and EntitlementsService without importing it. */
@Global()
@Module({
  controllers: [AccessController, AppStoreController],
  providers: [
    EntitlementsService,
    ProFeatureGuard,
    AppStoreVerifier,
    AppStoreApi,
    AppStoreService,
  ],
  exports: [EntitlementsService, ProFeatureGuard],
})
export class BillingModule {}
