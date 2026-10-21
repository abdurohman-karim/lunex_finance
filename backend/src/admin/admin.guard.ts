import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Only administrators. The role is read from the database on every request, so taking it away
 * works at once, without waiting for the access token to expire.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.userId;
    const user = userId
      ? await this.prisma.users.findUnique({
          where: { id: userId },
          select: { role: true, deleted_at: true },
        })
      : null;
    if (!user || user.role !== 'admin' || user.deleted_at) {
      throw new ForbiddenException({
        code: 'admin_only',
        message: 'This account is not an administrator',
      });
    }
    return true;
  }
}
