import { Global, Module } from '@nestjs/common';
import { AttachmentStorage } from './attachment-storage.js';

/** Files of the users: photos of receipts. */
@Global()
@Module({
  providers: [AttachmentStorage],
  exports: [AttachmentStorage],
})
export class StorageModule {}
