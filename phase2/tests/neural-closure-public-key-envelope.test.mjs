import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  openProspectiveCohortForRecipient,
  sealProspectiveCohortForRecipient
} from '../core/neural-closure-public-key-envelope.mjs';

const validPair=generateKeyPairSync('rsa',{modulusLength:3072});
const wrongPair=generateKeyPairSync('rsa',{modulusLength:3072});
const keyPem=key=>key.export({type:'pkcs8',format:'pem'});
const publicPem=key=>key.export({type:'spki',format:'pem'});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'radarx-recipient-envelope-'));
  const input=join(directory,'cohort.tar.gz');
  const encrypted=join(directory,'cohort.enc');
  const wrapped=join(directory,'cohort.key.enc');
  const output=join(directory,'cohort.restored.tar.gz');
  const marker=Buffer.from('RADARX_LOCKED_COHORT_LABEL_SENTINEL');
  const payload=Buffer.concat([marker,randomBytes(2*1024*1024)]);
  await writeFile(input,payload);
  return {directory,input,encrypted,wrapped,output,marker,payload};
}
async function cleanup(f){await rm(f.directory,{recursive:true,force:true});}
async function seal(f,pub=publicPem(validPair.publicKey)){
  return sealProspectiveCohortForRecipient({
    inputPath:f.input,encryptedPath:f.encrypted,wrappedKeyPath:f.wrapped,
    publicKeyPem:pub
  });
}

test('RSA-OAEP-SHA256 wrapped AES-256-GCM cohort round-trips without exposing key or labels',async()=>{
  const f=await fixture();
  try{
    const sealed=await seal(f);
    assert.equal(sealed.encryption_algorithm,'AES-256-GCM');
    assert.equal(sealed.key_wrapping_algorithm,'RSA-OAEP-SHA256');
    assert.equal(sealed.recipient_rsa_bits,3072);
    assert.equal(sealed.authenticated,true);
    assert.equal(sealed.atomic_publish,true);
    const ciphertext=await readFile(f.encrypted);
    const wrapped=await readFile(f.wrapped);
    assert.equal(ciphertext.includes(f.marker),false);
    assert.equal(wrapped.includes(f.marker),false);
    assert.notEqual(wrapped.length,32);
    const opened=await openProspectiveCohortForRecipient({
      encryptedPath:f.encrypted,wrappedKeyPath:f.wrapped,
      privateKeyPem:keyPem(validPair.privateKey),outputPath:f.output
    });
    assert.equal(opened.authenticated,true);
    assert.deepEqual(await readFile(f.output),f.payload);
  }finally{await cleanup(f);}
});

test('wrong recipient private key fails without publishing plaintext',async()=>{
  const f=await fixture();
  try{
    await seal(f);
    await assert.rejects(()=>openProspectiveCohortForRecipient({
      encryptedPath:f.encrypted,wrappedKeyPath:f.wrapped,
      privateKeyPem:keyPem(wrongPair.privateKey),outputPath:f.output
    }));
    assert.equal((await readdir(f.directory)).includes('cohort.restored.tar.gz'),false);
  }finally{await cleanup(f);}
});

test('tampered wrapped key envelope is rejected before plaintext publication',async()=>{
  const f=await fixture();
  try{
    await seal(f);
    const bytes=await readFile(f.wrapped);
    bytes[bytes.length-1]^=0x01;
    await writeFile(f.wrapped,bytes);
    await assert.rejects(()=>openProspectiveCohortForRecipient({
      encryptedPath:f.encrypted,wrappedKeyPath:f.wrapped,
      privateKeyPem:keyPem(validPair.privateKey),outputPath:f.output
    }));
    assert.equal((await readdir(f.directory)).includes('cohort.restored.tar.gz'),false);
  }finally{await cleanup(f);}
});

test('tampered AES-GCM ciphertext fails authentication and publishes no plaintext',async()=>{
  const f=await fixture();
  try{
    await seal(f);
    const bytes=await readFile(f.encrypted);
    bytes[Math.floor(bytes.length/2)]^=0x01;
    const tampered=join(f.directory,'tampered.enc');
    await writeFile(tampered,bytes);
    await assert.rejects(()=>openProspectiveCohortForRecipient({
      encryptedPath:tampered,wrappedKeyPath:f.wrapped,
      privateKeyPem:keyPem(validPair.privateKey),outputPath:f.output
    }));
    assert.equal((await readdir(f.directory)).includes('cohort.restored.tar.gz'),false);
  }finally{await cleanup(f);}
});

test('recipient public keys weaker than RSA-3072 are rejected',async()=>{
  const f=await fixture();
  const weak=generateKeyPairSync('rsa',{modulusLength:2048});
  try{
    await assert.rejects(()=>seal(f,publicPem(weak.publicKey)),
      /RSA_3072_OR_STRONGER_REQUIRED/);
    assert.equal((await readdir(f.directory)).includes('cohort.enc'),false);
  }finally{await cleanup(f);}
});
