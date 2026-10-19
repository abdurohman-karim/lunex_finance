import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Profile } from '../users/users.service.js';
import {
  deviceUpdateSchema,
  onboardingSchema,
  updateProfileSchema,
  updateSettingsSchema,
} from './profile.schemas.js';
import {
  type ChecklistDto,
  type OnboardingResult,
  ProfileService,
  type SettingsDto,
} from './profile.service.js';

/** `GET /v1/me` and the identity routes live in MeController; this one edits the account. */
@Controller('me')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Patch()
  update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateProfileSchema))
    body: z.infer<typeof updateProfileSchema>,
  ): Promise<Profile> {
    return this.profile.updateProfile(user.userId, body);
  }

  @Get('settings')
  settings(@CurrentUser() user: AuthUser): Promise<SettingsDto> {
    return this.profile.settings(user.userId);
  }

  @Patch('settings')
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateSettingsSchema))
    body: z.infer<typeof updateSettingsSchema>,
  ): Promise<SettingsDto> {
    return this.profile.updateSettings(user.userId, body);
  }

  /** Language, base currency, focus, income, first goal; creates the «Наличные» account. */
  @Post('onboarding')
  @HttpCode(200)
  onboarding(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(onboardingSchema))
    body: z.infer<typeof onboardingSchema>,
  ): Promise<OnboardingResult> {
    return this.profile.completeOnboarding(user.userId, body);
  }

  /** «Первые шаги» */
  @Get('checklist')
  checklist(@CurrentUser() user: AuthUser): Promise<ChecklistDto> {
    return this.profile.checklist(user.userId);
  }

  /** The calling device: APNs token and versions. */
  @Put('devices/current')
  device(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(deviceUpdateSchema))
    body: z.infer<typeof deviceUpdateSchema>,
  ) {
    return this.profile.updateDevice(user.userId, user.deviceId, body);
  }
}
