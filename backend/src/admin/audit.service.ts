import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface AuditEntry {
  id: string;
  admin: { id: string; name: string | null };
  action: string;
  target: string | null;
  oldValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  createdAt: Date;
}

type Db = Pick<Prisma.TransactionClient, 'adminAuditLog'>;

/** Who did what in the admin panel, when, and what it was before and after. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    db: Db,
    adminId: string,
    action: string,
    target: string | null,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    await db.adminAuditLog.create({
      data: {
        admin_id: adminId,
        action,
        target,
        old_value: (oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
        new_value: (newValue ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** Newest first; `before` is the id of the last entry already shown. */
  async list(
    before: string | undefined,
    limit: number,
  ): Promise<{ items: AuditEntry[]; nextBefore: string | null }> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: before ? { id: { lt: BigInt(before) } } : {},
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: {
        admin: { select: { id: true, display_name: true, email: true } },
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id.toString(),
        admin: {
          id: row.admin.id,
          name: row.admin.display_name ?? row.admin.email,
        },
        action: row.action,
        target: row.target,
        oldValue: row.old_value,
        newValue: row.new_value,
        createdAt: row.created_at,
      })),
      nextBefore: rows.length > limit ? page.at(-1)!.id.toString() : null,
    };
  }
}
