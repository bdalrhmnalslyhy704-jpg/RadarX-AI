import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const ARCHIVE_NAME_PATTERN=/^[A-Z0-9_-]+\.(?:1m|5m|15m)\.json\.gz$/;

async function digestStream(stream,code) {
  const hash=createHash('sha256');
  let bytes=0;
  try{
    for await(const chunk of stream){
      hash.update(chunk);
      bytes+=chunk.length;
    }
  }catch(error){
    throw new Error(code+':'+String(error?.message||error));
  }
  return {sha256:hash.digest('hex'),bytes};
}

/**
 * Verify every archived Binance raw-kline file against both hashes and byte
 * counts emitted by the collector. Files are streamed sequentially so memory
 * usage remains bounded even for large 180-day archives.
 */
export async function verifyBinanceRawArchives({
  archiveDirectory,archiveRecords,expectedCount
}={}) {
  if(typeof archiveDirectory!=='string'||!archiveDirectory.trim())
    throw new TypeError('RAW_ARCHIVE_DIRECTORY_REQUIRED');
  if(!Array.isArray(archiveRecords)||archiveRecords.length===0)
    throw new TypeError('RAW_ARCHIVE_MANIFEST_REQUIRED');
  if(!Number.isInteger(expectedCount)||expectedCount<1||
    archiveRecords.length!==expectedCount)
    throw new Error('RAW_ARCHIVE_MANIFEST_COUNT_MISMATCH');

  const root=resolve(archiveDirectory);
  const seen=new Set();
  const verified=[];
  let totalCompressedBytes=0,totalRawBytes=0,totalRows=0;

  for(const record of archiveRecords){
    const file=String(record?.file||'');
    if(!ARCHIVE_NAME_PATTERN.test(file)||seen.has(file))
      throw new Error('RAW_ARCHIVE_FILENAME_INVALID_OR_DUPLICATE:'+file);
    seen.add(file);

    const expectedCompressedBytes=Number(record?.compressed_bytes);
    const expectedRawBytes=Number(record?.raw_bytes);
    const expectedRows=Number(record?.row_count);
    const expectedCompressedSha=String(record?.compressed_sha256||'').toLowerCase();
    const expectedRawSha=String(record?.raw_sha256||'').toLowerCase();
    if(!Number.isSafeInteger(expectedCompressedBytes)||expectedCompressedBytes<1||
      !Number.isSafeInteger(expectedRawBytes)||expectedRawBytes<1||
      !Number.isSafeInteger(expectedRows)||expectedRows<1||
      !SHA256_PATTERN.test(expectedCompressedSha)||!SHA256_PATTERN.test(expectedRawSha))
      throw new Error('RAW_ARCHIVE_RECORD_INVALID:'+file);

    const path=resolve(root,file);
    if(!path.startsWith(root+sep))
      throw new Error('RAW_ARCHIVE_PATH_ESCAPE:'+file);

    let info;
    try{info=await lstat(path);}
    catch(error){
      throw new Error('RAW_ARCHIVE_MISSING:'+file+':'+String(error?.message||error));
    }
    if(info.isSymbolicLink()||!info.isFile())
      throw new Error('RAW_ARCHIVE_NOT_REGULAR_FILE:'+file);
    if(info.size!==expectedCompressedBytes)
      throw new Error('RAW_ARCHIVE_COMPRESSED_SIZE_MISMATCH:'+file);

    const compressed=await digestStream(createReadStream(path),
      'RAW_ARCHIVE_COMPRESSED_READ_FAILED:'+file);
    if(compressed.bytes!==expectedCompressedBytes||
      compressed.sha256!==expectedCompressedSha)
      throw new Error('RAW_ARCHIVE_COMPRESSED_SHA_MISMATCH:'+file);

    const raw=await digestStream(createReadStream(path).pipe(createGunzip()),
      'RAW_ARCHIVE_GZIP_OR_CONTENT_READ_FAILED:'+file);
    if(raw.bytes!==expectedRawBytes||raw.sha256!==expectedRawSha)
      throw new Error('RAW_ARCHIVE_CONTENT_SHA_MISMATCH:'+file);

    totalCompressedBytes+=compressed.bytes;
    totalRawBytes+=raw.bytes;
    totalRows+=expectedRows;
    verified.push({file,row_count:expectedRows,
      compressed_bytes:compressed.bytes,raw_bytes:raw.bytes,
      compressed_sha256:compressed.sha256,raw_sha256:raw.sha256});
  }

  return {
    schema:'RADARX_BINANCE_RAW_ARCHIVE_GUARD_V1',
    verified_count:verified.length,
    total_rows:totalRows,
    total_compressed_bytes:totalCompressedBytes,
    total_raw_bytes:totalRawBytes,
    files:verified
  };
}
