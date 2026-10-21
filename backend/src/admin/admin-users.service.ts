import { Injectable, NotFoundException } from '@nestjs/common';
import type { Access } from '../billing/entitlements.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from './audit.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdminUserDto {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  /** apple, google, telegram, email */
  signIn: string[];
  createdAt: Date;
  deletedAt: Date | null;
  plan: Access['plan'];
  source: Access['source'];
  expiresAt: Date | null;
  /** Shown even while monetization is off, when they don't decide the plan yet */
  trialUntil: Date | null;
  promoUntil: Date | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finding a user and giving them Lunex Pro for a while (spec: «Выдача промо-доступа»). */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /** By id, email or part of it, Telegram id, or name. */
  async search(query: string): Promise<AdminUserDto[]> {
    const where: Prisma.UsersWhereInput = uuid.test(query)
      ? { id: query.toLowerCase() }
      : {
          OR: [
            { email: { contains: query, mode: 'insensitive' } },
            { display_name: { contains: query, mode: 'insensitive' } },
            {
              authIdentities: {
                some: {
                  OR: [
                    { subject: query },
                    { email: { contains: query, mode: 'insensitive' } },
                  ],
                },
              },
            },
          ],
        };
    const rows = await this.prisma.users.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 20,
      include: { authIdentities: { select: { provider: true } } },
    });
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  /** Pro for `days` from now, or from the end of the promo still running. */
  async grantPromo(
    adminId: string,
    userId: string,
    days: number,
    now = new Date(),
  ): Promise<AdminUserDto> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: { authIdentities: { select: { provider: true } } },
    });
    if (!user || user.deleted_at) {
      throw new NotFoundException({
        code: 'user_not_found',
        message: 'No such user',
      });
    }
    const running = await this.prisma.subscriptions.findFirst({
      where: {
        user_id: userId,
        source: 'promo',
        status: 'active',
        expires_at: { gt: now },
      },
      orderBy: { expires_at: 'desc' },
    });
    const from = running?.expires_at ?? now;
    const expiresAt = new Date(from.getTime() + days * DAY_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.subscriptions.create({
        data: {
          user_id: userId,
          source: 'promo',
          status: 'active',
          started_at: now,
          expires_at: expiresAt,
        },
      });
      await this.audit.record(
        tx,
        adminId,
        'subscription.grant',
        userId,
        running ? { promoUntil: running.expires_at } : null,
        { days, promoUntil: expiresAt },
      );
    });
    return this.toDto(user);
  }

  private async toDto(
    row: Prisma.UsersGetPayload<{
      include: { authIdentities: { select: { provider: true } } };
    }>,
  ): Promise<AdminUserDto> {
    const [access, promo] = await Promise.all([
      this.entitlements.getAccess(row.id),
      this.prisma.subscriptions.findFirst({
        where: {
          user_id: row.id,
          source: 'promo',
          status: 'active',
          expires_at: { gt: new Date() },
        },
        orderBy: { expires_at: 'desc' },
        select: { expires_at: true },
      }),
    ]);
    return {
      id: row.id,
      name: row.display_name,
      email: row.email,
      role: row.role,
      signIn: [...new Set(row.authIdentities.map((i) => i.provider))],
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
      plan: access.plan,
      source: access.source,
      expiresAt: access.expiresAt,
      trialUntil: access.trial?.endsAt ?? null,
      promoUntil: promo?.expires_at ?? null,
    };
  }
}
