/**
 * Admin: set (or reset) a user's password.
 *   npm run user:set-password -- <username> <new-password>
 * Also signs that user out everywhere.
 */
import 'dotenv/config';
import { passwordSchema } from '@fa/shared';
import { createDb } from '../lib/db';
import { hashPassword } from '../services/users';

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) throw new Error('Usage: npm run user:set-password -- <username> <new-password>');
  const ok = passwordSchema.safeParse(password);
  if (!ok.success) throw new Error(ok.error.issues[0]?.message);
  const db = createDb();
  const user = await db.user.findUnique({ where: { usernameKey: username.toLowerCase() } });
  if (!user) throw new Error(`No user named ${username}`);
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  const { count } = await db.session.deleteMany({ where: { userId: user.id } });
  console.log(`✓ Password set for ${user.username} (${count} old session${count === 1 ? '' : 's'} signed out)`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
