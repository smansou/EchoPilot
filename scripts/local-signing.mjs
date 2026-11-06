import {spawnSync} from 'node:child_process';
import {randomBytes, X509Certificate} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile, rm, chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// A dedicated build keychain. It never changes the login keychain, its search list,
// system-wide trust settings, or application-secret ACLs. Setup trusts only this
// user's local certificate for code signing (never for websites). It pins local
// builds to one private signing key rather than using a changing ad-hoc cdhash.
const directory=process.env.ECHOPILOT_SIGNING_DIRECTORY??join(homedir(),'Library/Application Support/EchoPilot Build');
const configPath=join(directory,'signing.json');
function run(file,args){const result=spawnSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});if(result.status!==0)throw Error(`${file} failed: ${result.stderr.trim()}`);return result.stdout;}
async function signingConfig(){
  if(process.platform!=='darwin'||!existsSync(configPath))return null;
  const config=JSON.parse(await readFile(configPath,'utf8'));
  run('/usr/bin/security',['unlock-keychain','-p',config.password,config.keychain]);
  return {identity:config.identity,keychain:config.keychain};
}
export async function localSigning(){
  const config=await signingConfig();if(!config)return null;
  const identities=run('/usr/bin/security',['find-identity','-v','-p','codesigning',config.keychain]);
  return identities.includes(config.identity)?config:null;
}
export function signingArguments(path,signing){
  return ['--force','--sign',signing?.identity??'-','--timestamp=none',...(signing?['--keychain',signing.keychain]:[]),path];
}
async function setup(){
  const existing=await signingConfig();
  if(existing){
    const cert=join(directory,'certificate.pem');
    await writeFile(cert,run('/usr/bin/security',['find-certificate','-c','EchoPilot Local Development','-p',existing.keychain]),{mode:0o600});
    run('/usr/bin/security',['add-trusted-cert','-r','trustRoot','-p','codeSign',cert]);
    console.log('EchoPilot local signing identity is ready.');return;
  }
  process.umask(0o077);await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const scratch=await mkdtemp(join(tmpdir(),'echopilot-signing-'));
  const keychain=join(directory,'signing.keychain-db');const password=randomBytes(32).toString('hex');
  try{
    const config=join(scratch,'openssl.cnf');const key=join(scratch,'key.pem');const cert=join(scratch,'cert.pem');const bundle=join(scratch,'signing.p12');
    await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=EchoPilot Local Development\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n');
    run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','3650','-config',config,'-keyout',key,'-out',cert]);
    const identity=new X509Certificate(await readFile(cert)).fingerprint.replaceAll(':','');
    const passwordFile=join(scratch,'password');await writeFile(passwordFile,password,{mode:0o600});
    run('/usr/bin/openssl',['pkcs12','-export','-inkey',key,'-in',cert,'-out',bundle,'-passout',`file:${passwordFile}`]);
    run('/usr/bin/security',['create-keychain','-p',password,keychain]);
    run('/usr/bin/security',['import',bundle,'-k',keychain,'-P',password,'-T','/usr/bin/codesign']);
    run('/usr/bin/security',['set-key-partition-list','-S','apple-tool:,apple:','-s','-k',password,keychain]);
    const savedCert=join(directory,'certificate.pem');await writeFile(savedCert,await readFile(cert),{mode:0o600});
    await writeFile(configPath,JSON.stringify({identity,keychain,password}),{mode:0o600});
    run('/usr/bin/security',['add-trusted-cert','-r','trustRoot','-p','codeSign',savedCert]);
    console.log('EchoPilot local signing identity created in its private build keychain.');
  }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await setup();
