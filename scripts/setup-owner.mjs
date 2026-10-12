import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, chmod, rename } from 'node:fs/promises';
if (!process.stdin.isTTY) { console.error('Run this helper in an interactive terminal. Password input is hidden.'); process.exit(1); }
const silent = new Writable({write(_chunk,_encoding,callback){callback();}});
const input = createInterface({input:process.stdin,output:silent,terminal:true,historySize:0});
input.on('SIGINT',()=>{input.close();process.stderr.write('\nCancelled.\n');process.exit(130);});
try {
  process.stderr.write('Choose your owner password (12+ characters; input hidden): ');
  const password = await input.question(''); process.stderr.write('\n');
  if (password.length < 12) throw new Error('Use at least 12 characters.');
  process.stderr.write('Confirm password (input hidden): ');
  const confirmation = await input.question(''); process.stderr.write('\n');
  if (password !== confirmation) throw new Error('Passwords did not match. Configuration was not changed.');
  const salt=randomBytes(16).toString('hex'),hash=`${salt}:${scryptSync(password,salt,64).toString('hex')}`;
  const path=new URL('../.env',import.meta.url),temporary=new URL('../.env.setup-tmp',import.meta.url);
  const contents=await readFile(path,'utf8');
  const updated=/^OWNER_PASSWORD_HASH=.*$/m.test(contents)?contents.replace(/^OWNER_PASSWORD_HASH=.*$/m,`OWNER_PASSWORD_HASH=${hash}`):contents+`\nOWNER_PASSWORD_HASH=${hash}\n`;
  await writeFile(temporary,updated,{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);
  console.log('Owner password configured. Only its salted hash was saved in .env.');
} catch(e) { console.error(e instanceof Error ? e.message : 'Setup failed.');process.exitCode=1; }
finally {input.close();}
