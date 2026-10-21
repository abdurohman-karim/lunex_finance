import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UsersService } from '../users/users.service.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { AdminMonitoringService } from './admin-monitoring.service.js';
import { AdminSettingsService } from './admin-settings.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminGuard } from './admin.guard.js';
import {
  auditQuerySchema,
  categoryCreateSchema,
  categoryPatchSchema,
  currencyPatchSchema,
  monetizationSchema,
  promoSchema,
  settingValueSchema,
  userSearchSchema,
} from './admin.schemas.js';
import { AuditService } from './audit.service.js';

/** The admin panel's API (`/admin`): administrators only. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly settings: AdminSettingsService,
    private readonly catalog: AdminCatalogService,
    private readonly people: AdminUsersService,
    private readonly monitoring: AdminMonitoringService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.profile(user.userId);
  }

  @Get('settings')
  settingsList() {
    return this.settings.list();
  }

  @Put('settings/:key')
  updateSetting(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(settingValueSchema))
    body: z.infer<typeof settingValueSchema>,
  ) {
    return this.settings.update(user.userId, key, body.value);
  }

  /** What switching Lunex Pro on or off changes: for the confirmation window. */
  @Get('monetization')
  monetization() {
    return this.settings.preview();
  }

  @Put('monetization')
  setMonetization(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(monetizationSchema))
    body: z.infer<typeof monetizationSchema>,
  ) {
    return this.settings.setMonetization(user.userId, body.enabled);
  }

  @Get('currencies')
  currencies() {
    return this.catalog.currencies();
  }

  @Patch('currencies/:code')
  updateCurrency(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(currencyPatchSchema))
    body: z.infer<typeof currencyPatchSchema>,
  ) {
    return this.catalog.updateCurrency(user.userId, code, body);
  }

  @Get('categories')
  categories() {
    return this.catalog.categories();
  }

  @Post('categories')
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(categoryCreateSchema))
    body: z.infer<typeof categoryCreateSchema>,
  ) {
    return this.catalog.createCategory(user.userId, body);
  }

  @Patch('categories/:id')
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(categoryPatchSchema))
    body: z.infer<typeof categoryPatchSchema>,
  ) {
    return this.catalog.updateCategory(user.userId, id, body);
  }

  @Get('users')
  searchUsers(
    @Query(new ZodValidationPipe(userSearchSchema))
    query: z.infer<typeof userSearchSchema>,
  ) {
    return this.people.search(query.q);
  }

  @Post('users/:id/promo')
  grantPromo(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(promoSchema))
    body: z.infer<typeof promoSchema>,
  ) {
    return this.people.grantPromo(user.userId, id, body.days);
  }

  @Get('audit')
  auditLog(
    @Query(new ZodValidationPipe(auditQuerySchema))
    query: z.infer<typeof auditQuerySchema>,
  ) {
    return this.audit.list(query.before, query.limit);
  }

  @Get('monitoring')
  monitoringOverview() {
    return this.monitoring.overview();
  }
}
