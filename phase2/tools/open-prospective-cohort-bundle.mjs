import {readFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {openProspectiveCohortForRecipient} from '../core/neural-closure-public-key-envelope.mjs';

const [encryptedPath,wrappedKeyPath,privateKeyPath,outputPath,...extra]=
  process.argv.slice(2);
if(!encryptedPath||!wrappedKeyPath||!privateKeyPath||!outputPath||extra.length)
  throw new Error('USAGE: open-prospective-cohort-bundle.mjs <bundle.enc> <wrapped-key.enc> <private-key.pem> <output.tar.gz>');
const result=await openProspectiveCohortForRecipient({
  encryptedPath:resolve(encryptedPath),
  wrappedKeyPath:resolve(wrappedKeyPath),
  privateKeyPem:await readFile(resolve(privateKeyPath)),
  outputPath:resolve(outputPath)
});
console.log(JSON.stringify({
  status:'PROSPECTIVE_COHORT_OPENED_FOR_RECIPIENT',
  ...result
},null,2));
