import { randomBytes, scryptSync } from 'node:crypto';
let password = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) password += chunk;
password = password.replace(/\r?\n$/, '');
if (password.length < 12) throw new Error('Use at least 12 characters. Supply the password through stdin.');
const salt = randomBytes(16).toString('hex');
console.log(`${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
