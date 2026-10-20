import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import type { Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { UserRole } from '../generated/prisma/enums.js';
import type { AuthUser, IssuedTokens } from './auth.types.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 60;

const ISSUER = 'lunex';
const AUDIENCE = 'lunex-app';

type Db = PrismaService | Prisma.TransactionClient;

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function unauthorized(code: string, message: string): UnauthorizedException {
  return new UnauthorizedException({ code, message });
}

/** A device whose session ended: no APNs token, no pushes. */
const SILENT = { apns_token: null, push_enabled: false };
@Injectable()
export class TokensService {
  private readonly accessKey: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.accessKey = new TextEncoder().encode(
      config.get('JWT_ACCESS_SECRET', { infer: true }),
    );
  }

  /** New access token plus a new refresh token stored (hashed) for the device. */
  async issue(
    db: Db,
    user: { id: string; role: UserRole },
    deviceId: string,
    now = new Date(),
  ): Promise<IssuedTokens> {
    const accessTokenExpiresAt = new Date(
      now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
    const accessToken = await new SignJWT({ role: user.role, did: deviceId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(accessTokenExpiresAt.getTime() / 1000))
      .setJti(randomUUID())
      .sign(this.accessKey);

    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(
      now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    await db.refreshTokens.create({
      data: {
        user_id: user.id,
        device_id: deviceId,
        token_hash: hashRefreshToken(refreshToken),
        expires_at: refreshTokenExpiresAt,
      },
    });

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.accessKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.did !== 'string' ||
        (payload.role !== 'user' && payload.role !== 'admin')
      ) {
        throw new Error('Malformed claims');
      }
      return { userId: payload.sub, role: payload.role, deviceId: payload.did };
    } catch {
      throw unauthorized(
        'invalid_access_token',
        'Access token is invalid or expired',
      );
    }
  }

  /**
   * Rotation: the presented token is revoked and a new pair is issued.
   * A revoked token presented again means it leaked, so every session of that device is revoked.
   */
  async refresh(refreshToken: string, now = new Date()): Promise<IssuedTokens> {
    const stored = await this.prisma.refreshTokens.findUnique({
      where: { token_hash: hashRefreshToken(refreshToken) },
      include: { user: { select: { id: true, role: true, deleted_at: true } } },
    });
    if (!stored) {
      throw unauthorized('invalid_refresh_token', 'Refresh token is invalid');
    }
    // Deleting the account revokes its tokens; say why rather than reporting reuse.
    if (stored.user.deleted_at) {
      throw unauthorized('account_deleted', 'Account is deleted');
    }
    if (stored.revoked_at) {
      await this.revokeDevice(stored.device_id, now);
      throw unauthorized(
        'refresh_token_reused',
        'Refresh token was already used',
      );
    }
    if (stored.expires_at <= now) {
      throw unauthorized('refresh_token_expired', 'Refresh token has expired');
    }

    return this.prisma.$transaction(async (tx) => {
      // Two parallel refreshes with one token: only the first wins, the second is treated as reuse.
      const { count } = await tx.refreshTokens.updateMany({
        where: { id: stored.id, revoked_at: null },
        data: { revoked_at: now },
      });
      if (count === 0) {
        throw unauthorized(
          'refresh_token_reused',
          'Refresh token was already used',
        );
      }
      await tx.devices.update({
        where: { id: stored.device_id },
        data: { last_seen_at: now },
      });
      return this.issue(tx, stored.user, stored.device_id, now);
    });
  }

  /**
   * Logout of one session; unknown or already revoked tokens are ignored. Wherever a session
   * ends, its device stops getting the account's pushes until it registers again.
   */
  async revoke(refreshToken: string, now = new Date()): Promise<void> {
    const stored = await this.prisma.refreshTokens.findUnique({
      where: { token_hash: hashRefreshToken(refreshToken) },
      select: { device_id: true, revoked_at: true },
    });
    if (!stored || stored.revoked_at) return;
    await this.prisma.$transaction([
      this.prisma.refreshTokens.updateMany({
        where: { token_hash: hashRefreshToken(refreshToken), revoked_at: null },
        data: { revoked_at: now },
      }),
      this.prisma.devices.updateMany({
        where: { id: stored.device_id },
        data: SILENT,
      }),
    ]);
  }

  async revokeDevice(
    deviceId: string,
    now = new Date(),
    db: Db = this.prisma,
  ): Promise<void> {
    await db.refreshTokens.updateMany({
      where: { device_id: deviceId, revoked_at: null },
      data: { revoked_at: now },
    });
    await db.devices.updateMany({ where: { id: deviceId }, data: SILENT });
  }

  async revokeAllForUser(
    userId: string,
    now = new Date(),
    db: Db = this.prisma,
  ): Promise<void> {
    await db.refreshTokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: now },
    });
    await db.devices.updateMany({ where: { user_id: userId }, data: SILENT });
  }
}
