import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {
  encryptProspectiveBundleFile,
  decryptProspectiveBundleFile
} from '../core/neural-closure-secure-bundle.mjs';

test('prospective bundle encryption streams and round-trips a multi-megabyte payload',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-secure-bundle-'));
  const source=join(directory,'cohort.tar.gz');
  const encrypted=join(directory,'cohort.enc');
  const decrypted=join(directory,'cohort.restored.tar.gz');
  const marker=Buffer.from('RADARX_PRIVATE_OUTCOME_LABELS_MUST_NOT_BE_VISIBLE');
  const payload=Buffer.concat([
    marker,
    Buffer.alloc(2*1024*1024,0x5a),
    Buffer.from(JSON.stringify({rows:777,locked:true}))
  ]);
  const key=randomBytes(32);
  try{
    await writeFile(source,payload);
    const seal=await encryptProspectiveBundleFile(source,encrypted,key);
    assert.equal(seal.algorithm,'AES-256-GCM');
    assert.equal(seal.authenticated,true);
    assert.equal(seal.streaming,true);
    assert.equal(seal.atomic_publish,true);
    const encryptedBytes=await readFile(encrypted);
    assert.equal(encryptedBytes.includes(marker),false,
      'the encrypted artifact must not expose recognizable label content');
    const open=await decryptProspectiveBundleFile(encrypted,decrypted,key);
    assert.equal(open.authenticated,true);
    assert.deepEqual(await readFile(decrypted),payload);
    assert.ok((await stat(encrypted)).size>payload.length);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test('prospective bundle decryption rejects a wrong key and publishes no plaintext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-secure-wrong-key-'));
  const source=join(directory,'source.bin');
  const encrypted=join(directory,'source.enc');
  const output=join(directory,'must-not-exist.bin');
  try{
    await writeFile(source,Buffer.from('locked labels and realized returns'));
    await encryptProspectiveBundleFile(source,encrypted,Buffer.alloc(32,7));
    await assert.rejects(
      decryptProspectiveBundleFile(encrypted,output,Buffer.alloc(32,8)),
      /authenticate|state|tag/i
    );
    assert.deepEqual((await readdir(directory)).sort(),['source.bin','source.enc']);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test('prospective bundle decryption rejects tampered ciphertext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-secure-tamper-'));
  const source=join(directory,'source.bin');
  const encrypted=join(directory,'source.enc');
  const tampered=join(directory,'tampered.enc');
  const output=join(directory,'must-not-exist.bin');
  const key=randomBytes(32);
  try{
    await writeFile(source,Buffer.from('first-touch outcomes are sealed'));
    await encryptProspectiveBundleFile(source,encrypted,key);
    const bytes=await readFile(encrypted);
    bytes[bytes.length-20]^=0x01;
    await writeFile(tampered,bytes);
    await assert.rejects(decryptProspectiveBundleFile(tampered,output,key));
    assert.ok(!(await readdir(directory)).includes('must-not-exist.bin'));
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test('prospective bundle encryption rejects non-256-bit keys before creating output',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-secure-invalid-key-'));
  const source=join(directory,'source.bin');
  const encrypted=join(directory,'source.enc');
  try{
    await writeFile(source,Buffer.from('locked'));
    await assert.rejects(
      encryptProspectiveBundleFile(source,encrypted,Buffer.alloc(31)),
      /32_BYTES/
    );
    assert.deepEqual(await readdir(directory),['source.bin']);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});


test('prospective bundle decryption rejects a tampered authentication tag and publishes no plaintext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-secure-tag-tamper-'));
  const source=join(directory,'source.bin');
  const encrypted=join(directory,'source.enc');
  const tampered=join(directory,'tampered.enc');
  const output=join(directory,'must-not-exist.bin');
  const key=randomBytes(32);
  try{
    await writeFile(source,Buffer.from('authenticated prospective cohort payload'));
    await encryptProspectiveBundleFile(source,encrypted,key);
    const bytes=await readFile(encrypted);
    bytes[bytes.length-1]^=0x01;
    await writeFile(tampered,bytes);
    await assert.rejects(
      decryptProspectiveBundleFile(tampered,output,key),
      /authenticate|state|tag/i
    );
    assert.equal((await readdir(directory)).includes('must-not-exist.bin'),false);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});
