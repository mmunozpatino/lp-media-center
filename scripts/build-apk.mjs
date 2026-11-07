// Genera el APK. Si está la clave de firma de esta PC (fuera del repo), la usa: así el APK local se puede
// instalar encima del publicado en GitHub. Sin clave, sale uno de depuración, que no se puede.
// Resultado: dist\LP Cine Vault.apk. Gradle solo corre desde una pestaña del panel Terminal.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const keyDir = path.join(os.homedir(), '.lp-media-center-firma');
const keystore = path.join(keyDir, 'lp-release.jks');
const signed = existsSync(keystore);
const env = {
  ...process.env,
  JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr',
  ANDROID_HOME: process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ...(signed ? { LP_KEYSTORE_FILE: keystore, LP_KEYSTORE_PASSWORD: readFileSync(path.join(keyDir, 'clave.txt'), 'utf8').trim() } : {}),
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npx', ['cap', 'sync', 'android'], root);
run(path.join(root, 'android', 'gradlew.bat'), [signed ? 'assembleRelease' : 'assembleDebug', '--no-daemon'], path.join(root, 'android'));

const kind = signed ? 'release' : 'debug';
const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', kind, `app-${kind}.apk`);
const output = path.join(root, 'dist', 'LP Cine Vault.apk');
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(apk, output);
console.log(`APK ${signed ? 'firmado' : 'de depuración'}: ${output} (${Math.round(statSync(output).size / 1024 / 1024)} MB)`);
