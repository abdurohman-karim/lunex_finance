/**
 * Gives or takes the administrator role (the admin panel at /admin):
 *
 *   npm run admin:role -- grant someone@example.com
 *   npm run admin:role -- revoke <user id or email>
 *
 * On the server: docker compose exec api npm run admin:role -- grant someone@example.com
 * The account must exist: sign in to the app with that email (or method) first.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const [action, who] = process.argv.slice(2);
if ((action !== 'grant' && action !== 'revoke') || !who) {
  console.error('Usage: npm run admin:role -- grant|revoke <email or user id>');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
try {
  const isId = /^[0-9a-f-]{36}$/i.test(who);
  const user = await prisma.users.findFirst({
    where: isId
      ? { id: who.toLowerCase() }
      : {
          OR: [
            { email: { equals: who, mode: 'insensitive' } },
            {
              authIdentities: {
                some: { email: { equals: who, mode: 'insensitive' } },
              },
            },
          ],
        },
  });
  if (!user || user.deleted_at) {
    console.error(`No account for ${who}`);
    process.exitCode = 1;
  } else {
    await prisma.users.update({
      where: { id: user.id },
      data: { role: action === 'grant' ? 'admin' : 'user' },
    });
    console.log(
      `${action === 'grant' ? 'Granted' : 'Revoked'} admin: ${user.id} ${user.email ?? ''}`,
    );
  }
} finally {
  await prisma.$disconnect();
}
