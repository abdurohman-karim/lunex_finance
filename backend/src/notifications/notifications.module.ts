import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { APNS_HOSTS, ApnsPushSender } from './apns-push-sender.js';
import { NOTIFICATIONS_QUEUE } from './notifications.constants.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import {
  LogPushSender,
  PushSender,
  SimulatorPushSender,
} from './push-sender.js';

/** Storing and sending pushes; what triggers them lives with each feature and the jobs. */
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: PushSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PushSender => {
        const get = <K extends keyof Env>(key: K) =>
          config.get(key, { infer: true });
        switch (get('PUSH_PROVIDER')) {
          case 'apns':
            // env validation guarantees the key, team and key id for the apns provider
            return new ApnsPushSender({
              keyId: get('APNS_KEY_ID')!,
              teamId: get('APNS_TEAM_ID')!,
              privateKey: get('APNS_PRIVATE_KEY')!,
              topic: get('APNS_TOPIC'),
              host: APNS_HOSTS[get('APNS_ENVIRONMENT')],
            });
          case 'simulator':
            return new SimulatorPushSender(
              get('SIMULATOR_DEVICE'),
              get('APNS_TOPIC'),
            );
          default:
            return new LogPushSender();
        }
      },
    },
  ],
  exports: [NotificationsService, BullModule],
})
export class NotificationsModule {}
