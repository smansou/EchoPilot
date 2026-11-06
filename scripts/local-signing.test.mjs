import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signingArguments} from './local-signing.mjs';
test('local signing pins the certificate and dedicated keychain for every build',()=>{
  assert.deepEqual(signingArguments('/tmp/EchoPilot.app',{identity:'certificate-sha1',keychain:'/private/build/signing.keychain-db'}),['--force','--sign','certificate-sha1','--timestamp=none','--keychain','/private/build/signing.keychain-db','/tmp/EchoPilot.app']);
  assert.deepEqual(signingArguments('/tmp/EchoPilot.app',null),['--force','--sign','-','--timestamp=none','/tmp/EchoPilot.app']);
});
