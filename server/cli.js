// Admin helper: `npm run create-user -- email@example.com 'password'`
// Works even when public registration is disabled (ALLOW_REGISTRATION=false).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { Auth } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, email, password] = process.argv.slice(2);

if (command !== 'create-user' || !email || !password) {
  console.error("Naudojimas: npm run create-user -- el.pastas@pvz.lt 'slaptazodis'");
  process.exit(1);
}

const store = new JsonStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
try {
  const user = await new Auth(store).register(email, password, { force: true });
  console.log(`Sukurtas vartotojas: ${user.email}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
