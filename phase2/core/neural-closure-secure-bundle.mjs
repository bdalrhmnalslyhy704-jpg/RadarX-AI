import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {appendFile,mkdir,open,rename,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';

const MAGIC=Buffer.from('RADARX_BUILD224_AES256_GCM_BUNDLE_V1\n','ascii');
const IV_BYTES=12;
const TAG_BYTES=16;

function normalizeKey(value){
  if(!Buffer.isBuffer(value)&&!(value instanceof Uint8Array))
    throw new TypeError('PROSPECTIVE_BUNDLE_ENCRYPTION_KEY_INVALID');
  const key=Buffer.from(value);
  if(key.length!==32)
    throw new TypeError('PROSPECTIVE_BUNDLE_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  return key;
}

function outputPaths(inputPath,outputPath){
  const source=resolve(inputPath);
  const target=resolve(outputPath);
  if(source===target)
    throw new TypeError('PROSPECTIVE_BUNDLE_INPUT_OUTPUT_MUST_DIFFER');
  return {
    source,target,
    temporary:target+'.'+randomBytes(8).toString('hex')+'.tmp'
  };
}

/**
 * Stream an entire prospective cohort bundle into an authenticated
 * AES-256-GCM envelope. The format is MAGIC || IV || CIPHERTEXT || TAG.
 * The destination is published atomically only after encryption completes.
 */
export async function encryptProspectiveBundleFile(inputPath,outputPath,keyValue){
  const key=normalizeKey(keyValue);
  const paths=outputPaths(inputPath,outputPath);
  const iv=randomBytes(IV_BYTES);
  let published=false;
  await mkdir(dirname(paths.target),{recursive:true});
  try{
    await writeFile(paths.temporary,Buffer.concat([MAGIC,iv]),{
      flag:'wx',mode:0o600
    });
    const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:TAG_BYTES});
    await pipeline(
      createReadStream(paths.source),
      cipher,
      createWriteStream(paths.temporary,{flags:'a',mode:0o600})
    );
    await appendFile(paths.temporary,cipher.getAuthTag());
    await rename(paths.temporary,paths.target);
    published=true;
    const outputStat=await stat(paths.target);
    return {
      algorithm:'AES-256-GCM',
      bytes:outputStat.size,
      authenticated:true,
      streaming:true,
      atomic_publish:true
    };
  }finally{
    if(!published)await rm(paths.temporary,{force:true}).catch(()=>{});
  }
}

/**
 * Decrypt an authenticated envelope to a temporary file. GCM may emit
 * provisional plaintext while streaming; it is never published unless
 * the final authentication tag verifies successfully.
 */
export async function decryptProspectiveBundleFile(inputPath,outputPath,keyValue){
  const key=normalizeKey(keyValue);
  const paths=outputPaths(inputPath,outputPath);
  const input=await open(paths.source,'r');
  let sourceStat,header,tag;
  try{
    sourceStat=await input.stat();
    const headerLength=MAGIC.length+IV_BYTES;
    if(sourceStat.size<=headerLength+TAG_BYTES)
      throw new Error('PROSPECTIVE_BUNDLE_ENVELOPE_TOO_SMALL');
    header=Buffer.alloc(headerLength);
    const headerRead=await input.read(header,0,headerLength,0);
    if(headerRead.bytesRead!==headerLength)
      throw new Error('PROSPECTIVE_BUNDLE_HEADER_TRUNCATED');
    tag=Buffer.alloc(TAG_BYTES);
    const tagRead=await input.read(tag,0,TAG_BYTES,sourceStat.size-TAG_BYTES);
    if(tagRead.bytesRead!==TAG_BYTES)
      throw new Error('PROSPECTIVE_BUNDLE_AUTH_TAG_TRUNCATED');
  }finally{
    await input.close();
  }
  if(!header.subarray(0,MAGIC.length).equals(MAGIC))
    throw new Error('PROSPECTIVE_BUNDLE_MAGIC_INVALID');
  const iv=header.subarray(MAGIC.length);
  const start=MAGIC.length+IV_BYTES;
  const end=sourceStat.size-TAG_BYTES-1;
  const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:TAG_BYTES});
  decipher.setAuthTag(tag);
  let published=false;
  await mkdir(dirname(paths.target),{recursive:true});
  try{
    await pipeline(
      createReadStream(paths.source,{start,end}),
      decipher,
      createWriteStream(paths.temporary,{flags:'wx',mode:0o600})
    );
    await rename(paths.temporary,paths.target);
    published=true;
    const outputStat=await stat(paths.target);
    return {
      algorithm:'AES-256-GCM',
      bytes:outputStat.size,
      authenticated:true,
      streaming:true,
      atomic_publish:true
    };
  }finally{
    if(!published)await rm(paths.temporary,{force:true}).catch(()=>{});
  }
}

export const PROSPECTIVE_BUNDLE_ENVELOPE_MAGIC=MAGIC.toString('ascii');
