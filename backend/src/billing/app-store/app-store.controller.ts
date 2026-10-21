import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public } from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/auth.types.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import type { Access } from '../entitlements.js';
import { AppStoreService } from './app-store.service.js';

const jws = z.string().min(20).max(20_000);
const transactionSchema = z.object({
  /** StoreKit 2 `Transaction.jwsRepresentation` */
  signedTransaction: jws,
});
const notificationSchema = z.object({ signedPayload: jws });

/** Lunex Pro purchases (StoreKit 2) and App Store Server Notifications V2. */
@Controller('billing/app-store')
export class AppStoreController {
  constructor(private readonly appStore: AppStoreService) {}

  /** A verified purchase, renewal or restore from the app → the user's access. */
  @Post('transactions')
  @HttpCode(200)
  transaction(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(transactionSchema))
    body: z.infer<typeof transactionSchema>,
  ): Promise<Access> {
    return this.appStore.syncTransaction(user.userId, body.signedTransaction);
  }

  /** The App Store's server-to-server notifications (URL set in App Store Connect). */
  @Public()
  @Post('notifications')
  @HttpCode(200)
  async notification(
    @Body(new ZodValidationPipe(notificationSchema))
    body: z.infer<typeof notificationSchema>,
  ): Promise<void> {
    await this.appStore.notify(body.signedPayload);
  }
}
