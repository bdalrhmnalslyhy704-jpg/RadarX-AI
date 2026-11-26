import {readFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {sealProspectiveCohortForRecipient} from '../core/neural-closure-public-key-envelope.mjs';

const [inputPath,encryptedPath,wrappedKeyPath,publicKeyPath,...extra]=
  process.argv.slice(2);
if(!inputPath||!encryptedPath||!wrappedKeyPath||!publicKeyPath||extra.length)
  throw new Error('USAGE: seal-prospective-cohort-bundle.mjs <input.tar.gz> <output.enc> <wrapped-key.enc> <public-key.pem>');
const result=await sealProspectiveCohortForRecipient({
  inputPath:resolve(inputPath),
  encryptedPath:resolve(encryptedPath),
  wrappedKeyPath:resolve(wrappedKeyPath),
  publicKeyPem:await readFile(resolve(publicKeyPath))
});
console.log(JSON.stringify({
  status:'PROSPECTIVE_COHORT_SEALED_FOR_RECIPIENT',
  ...result
},null,2));
