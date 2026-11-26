import {
  constants,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes
} from 'node:crypto';
import {lstat, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {
  encryptProspectiveBundleFile,
  decryptProspectiveBundleFile
} from './neural-closure-secure-bundle.mjs';

const KEY_ENVELOPE_MAGIC=Buffer.from(
  'RADARX_BUILD224_RSA_OAEP_SHA256_AES256_GCM_KEY_V1\\n','ascii'
);
const AES_KEY_BYTES=32;
const MIN_RSA_BITS=3072;
const OAEP_HASH='sha256';
const RSA_PADDING=constants.RSA_PKCS1_OAEP_PADDING;

function requireRsaKey(key,kind){
  if(!key||key.asymmetricKeyType!=='rsa'||
    Number(key.asymmetricKeyDetails?.modulusLength)<MIN_RSA_BITS){
    throw new TypeError('PROSPECTIVE_COHORT_'+kind+'_RSA_3072_OR_STRONGER_REQUIRED');
  }
  return key;
}
async function requireAbsent(path,code){
  try{
    await lstat(path);
    throw new Error(code);
  }catch(error){
    if(error?.code==='ENOENT')return;
    throw error;
  }
}
async function atomicWrite(path,bytes){
  const target=resolve(path);
  const temp=target+'.'+randomBytes(8).toString('hex')+'.tmp';
  let published=false;
  try{
    await writeFile(temp,bytes,{flag:'wx',mode:0o600});
    await rename(temp,target);
    published=true;
  }finally{
    if(!published)await rm(temp,{force:true}).catch(()=>{});
  }
}

/**
 * Seal a cohort tarball with a one-time AES-256-GCM key and wrap that key
 * to the data owner's RSA public key using RSA-OAEP-SHA256.
 * The AES key exists only in memory and is never written to logs or disk.
 */
export async function sealProspectiveCohortForRecipient({
  inputPath,encryptedPath,wrappedKeyPath,publicKeyPem
}={}){
  if(typeof inputPath!=='string'||!inputPath.trim()||
    typeof encryptedPath!=='string'||!encryptedPath.trim()||
    typeof wrappedKeyPath!=='string'||!wrappedKeyPath.trim()||
    encryptedPath===wrappedKeyPath)
    throw new TypeError('PROSPECTIVE_COHORT_SEAL_PATHS_INVALID');
  if(!publicKeyPem)throw new TypeError('PROSPECTIVE_COHORT_PUBLIC_KEY_REQUIRED');
  const publicKey=requireRsaKey(createPublicKey(publicKeyPem),'PUBLIC');
  const encryptedTarget=resolve(encryptedPath);
  const wrappedTarget=resolve(wrappedKeyPath);
  if(encryptedTarget===wrappedTarget)
    throw new TypeError('PROSPECTIVE_COHORT_OUTPUT_PATH_COLLISION');
  await requireAbsent(encryptedTarget,'PROSPECTIVE_COHORT_ENCRYPTED_OUTPUT_EXISTS');
  await requireAbsent(wrappedTarget,'PROSPECTIVE_COHORT_WRAPPED_KEY_OUTPUT_EXISTS');

  const aesKey=randomBytes(AES_KEY_BYTES);
  let encryptedPublished=false;
  let wrappedPublished=false;
  try{
    const wrapped=publicEncrypt({
      key:publicKey,padding:RSA_PADDING,oaepHash:OAEP_HASH
    },aesKey);
    if(wrapped.length!==Math.ceil(
      Number(publicKey.asymmetricKeyDetails.modulusLength)/8))
      throw new Error('PROSPECTIVE_COHORT_WRAPPED_KEY_LENGTH_INVALID');

    const encryption=await encryptProspectiveBundleFile(
      resolve(inputPath),encryptedTarget,aesKey
    );
    encryptedPublished=true;
    const envelope=Buffer.alloc(KEY_ENVELOPE_MAGIC.length+4+wrapped.length);
    KEY_ENVELOPE_MAGIC.copy(envelope,0);
    envelope.writeUInt32BE(wrapped.length,KEY_ENVELOPE_MAGIC.length);
    wrapped.copy(envelope,KEY_ENVELOPE_MAGIC.length+4);
    await atomicWrite(wrappedTarget,envelope);
    wrappedPublished=true;
    return {
      encryption_algorithm:'AES-256-GCM',
      key_wrapping_algorithm:'RSA-OAEP-SHA256',
      recipient_rsa_bits:Number(publicKey.asymmetricKeyDetails.modulusLength),
      authenticated:encryption.authenticated===true,
      streaming:encryption.streaming===true,
      atomic_publish:encryption.atomic_publish===true,
      encrypted_file:basename(encryptedTarget),
      wrapped_key_file:basename(wrappedTarget),
      wrapped_key_bytes:envelope.length
    };
  }catch(error){
    if(encryptedPublished)await rm(encryptedTarget,{force:true}).catch(()=>{});
    if(wrappedPublished)await rm(wrappedTarget,{force:true}).catch(()=>{});
    throw error;
  }finally{
    aesKey.fill(0);
  }
}

/**
 * Open the wrapped AES key with the owner's private key, then authenticate
 * and decrypt the AES-256-GCM bundle. No plaintext output is published unless
 * GCM authentication succeeds.
 */
export async function openProspectiveCohortForRecipient({
  encryptedPath,wrappedKeyPath,privateKeyPem,outputPath
}={}){
  if(typeof encryptedPath!=='string'||!encryptedPath.trim()||
    typeof wrappedKeyPath!=='string'||!wrappedKeyPath.trim()||
    typeof outputPath!=='string'||!outputPath.trim())
    throw new TypeError('PROSPECTIVE_COHORT_OPEN_PATHS_INVALID');
  if(!privateKeyPem)throw new TypeError('PROSPECTIVE_COHORT_PRIVATE_KEY_REQUIRED');
  const privateKey=requireRsaKey(createPrivateKey(privateKeyPem),'PRIVATE');
  const envelope=await readFile(resolve(wrappedKeyPath));
  const headerLength=KEY_ENVELOPE_MAGIC.length+4;
  if(envelope.length<=headerLength||
    !envelope.subarray(0,KEY_ENVELOPE_MAGIC.length).equals(KEY_ENVELOPE_MAGIC))
    throw new Error('PROSPECTIVE_COHORT_KEY_ENVELOPE_HEADER_INVALID');
  const wrappedLength=envelope.readUInt32BE(KEY_ENVELOPE_MAGIC.length);
  if(wrappedLength!==Math.ceil(
    Number(privateKey.asymmetricKeyDetails.modulusLength)/8)||
    envelope.length!==headerLength+wrappedLength)
    throw new Error('PROSPECTIVE_COHORT_KEY_ENVELOPE_LENGTH_INVALID');

  let aesKey;
  try{
    aesKey=privateDecrypt({
      key:privateKey,padding:RSA_PADDING,oaepHash:OAEP_HASH
    },envelope.subarray(headerLength));
    if(aesKey.length!==AES_KEY_BYTES)
      throw new Error('PROSPECTIVE_COHORT_UNWRAPPED_AES_KEY_LENGTH_INVALID');
    const opened=await decryptProspectiveBundleFile(
      resolve(encryptedPath),resolve(outputPath),aesKey
    );
    return {
      encryption_algorithm:'AES-256-GCM',
      key_wrapping_algorithm:'RSA-OAEP-SHA256',
      recipient_rsa_bits:Number(privateKey.asymmetricKeyDetails.modulusLength),
      authenticated:opened.authenticated===true,
      atomic_publish:opened.atomic_publish===true,
      plaintext_file:basename(resolve(outputPath))
    };
  }finally{
    aesKey?.fill(0);
  }
}

export const PROSPECTIVE_COHORT_KEY_ENVELOPE_MAGIC=
  KEY_ENVELOPE_MAGIC.toString('ascii');
