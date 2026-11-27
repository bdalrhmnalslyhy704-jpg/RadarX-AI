import {basename,resolve} from 'node:path';
import {
  encryptProspectiveBundleFile,
  decryptProspectiveBundleFile
} from '../core/neural-closure-secure-bundle.mjs';

const [operation,inputPath,outputPath,...extra]=process.argv.slice(2);
if(!['encrypt','decrypt'].includes(operation)||!inputPath||!outputPath||extra.length)
  throw new Error('USAGE: secure-prospective-cohort-bundle.mjs <encrypt|decrypt> <input> <output>');
const keyHex=process.env.RADARX_PROSPECTIVE_COHORT_ENCRYPTION_KEY_HEX;
if(typeof keyHex!=='string'||!/^[0-9a-fA-F]{64}$/.test(keyHex))
  throw new Error('RADARX_PROSPECTIVE_COHORT_ENCRYPTION_KEY_HEX_MUST_BE_CONFIGURED_AS_64_HEX_CHARACTERS');
const key=Buffer.from(keyHex,'hex');
const result=operation==='encrypt'
  ?await encryptProspectiveBundleFile(resolve(inputPath),resolve(outputPath),key)
  :await decryptProspectiveBundleFile(resolve(inputPath),resolve(outputPath),key);
console.log(JSON.stringify({
  status:operation==='encrypt'?'PROSPECTIVE_BUNDLE_ENCRYPTED':'PROSPECTIVE_BUNDLE_DECRYPTED',
  output:basename(resolve(outputPath)),
  ...result
},null,2));
