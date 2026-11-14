import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm,writeFile,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { verifyBinanceRawArchives } from '../core/neural-closure-archive-guardian.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture({file='BTCUSDT.15m.json.gz',rawOverride=null,compressedOverride=null}={}) {
  const directory=await mkdtemp(join(tmpdir(),'radarx-archive-guard-'));
  const raw=rawOverride??Buffer.from(JSON.stringify({
    schema:'BINANCE_SPOT_RAW_KLINE_ARCHIVE_V1',
    symbol:'BTCUSDT',interval:'15m',rows:[[1,'100','101','99','100','10']]
  }));
  const compressed=compressedOverride??gzipSync(raw,{level:9});
  await writeFile(join(directory,file),compressed);
  return {
    directory,file,raw,compressed,
    record:{
      file,row_count:1,raw_bytes:raw.length,compressed_bytes:compressed.length,
      raw_sha256:sha256(raw),compressed_sha256:sha256(compressed)
    },
    cleanup:()=>rm(directory,{recursive:true,force:true})
  };
}

test('verifies exact compressed and decompressed SHA-256 values and byte counts',async()=>{
  const f=await fixture();
  try{
    const report=await verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record],expectedCount:1
    });
    assert.equal(report.schema,'RADARX_BINANCE_RAW_ARCHIVE_GUARD_V1');
    assert.equal(report.verified_count,1);
    assert.equal(report.total_rows,1);
    assert.equal(report.total_raw_bytes,f.raw.length);
    assert.equal(report.total_compressed_bytes,f.compressed.length);
    assert.equal(report.files[0].raw_sha256,f.record.raw_sha256);
    assert.equal(report.files[0].compressed_sha256,f.record.compressed_sha256);
  }finally{await f.cleanup();}
});

test('rejects a compressed archive whose bytes changed after collection',async()=>{
  const f=await fixture();
  try{
    const changed=Buffer.from(f.compressed);
    changed[changed.length-1]^=1;
    await writeFile(join(f.directory,f.file),changed);
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record],expectedCount:1
    }),/RAW_ARCHIVE_COMPRESSED_SHA_MISMATCH|RAW_ARCHIVE_GZIP_OR_CONTENT_READ_FAILED/);
  }finally{await f.cleanup();}
});

test('rejects corrupt gzip even when the compressed hash and size are self-consistent',async()=>{
  const broken=Buffer.from('not a gzip stream');
  const f=await fixture({compressedOverride:broken});
  try{
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record],expectedCount:1
    }),/RAW_ARCHIVE_GZIP_OR_CONTENT_READ_FAILED/);
  }finally{await f.cleanup();}
});

test('rejects a missing archive and a symlink in place of a regular archive',async()=>{
  const f=await fixture();
  try{
    await rm(join(f.directory,f.file));
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record],expectedCount:1
    }),/RAW_ARCHIVE_MISSING/);
    await symlink('/etc/passwd',join(f.directory,f.file));
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record],expectedCount:1
    }),/RAW_ARCHIVE_NOT_REGULAR_FILE/);
  }finally{await f.cleanup();}
});

test('rejects duplicate, path-traversal and mismatched manifests before reading files',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record,f.record],expectedCount:2
    }),/RAW_ARCHIVE_FILENAME_INVALID_OR_DUPLICATE/);
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,
      archiveRecords:[{...f.record,file:'../BTCUSDT.15m.json.gz'}],
      expectedCount:1
    }),/RAW_ARCHIVE_FILENAME_INVALID_OR_DUPLICATE/);
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[f.record],expectedCount:2
    }),/RAW_ARCHIVE_MANIFEST_COUNT_MISMATCH/);
  }finally{await f.cleanup();}
});

test('rejects an archive whose decompressed bytes do not match the recorded raw digest',async()=>{
  const wrongRaw=Buffer.from('another valid gzip payload');
  const f=await fixture();
  try{
    const compressed=gzipSync(wrongRaw,{level:9});
    await writeFile(join(f.directory,f.file),compressed);
    const mismatched={...f.record,
      compressed_bytes:compressed.length,
      compressed_sha256:sha256(compressed)
    };
    await assert.rejects(()=>verifyBinanceRawArchives({
      archiveDirectory:f.directory,archiveRecords:[mismatched],expectedCount:1
    }),/RAW_ARCHIVE_CONTENT_SHA_MISMATCH/);
  }finally{await f.cleanup();}
});
