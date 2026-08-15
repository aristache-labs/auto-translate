import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = join(process.cwd(), 'src', 'js');
const files = readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.backup'));
let failed = 0;
for (const file of files) {
    const path = join(dir, file);
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed += 1;
        process.stderr.write(result.stderr || result.stdout || `check failed: ${file}\n`);
    }
}
if (failed) {
    process.exit(1);
}
console.log(`checked ${files.length} files`);
