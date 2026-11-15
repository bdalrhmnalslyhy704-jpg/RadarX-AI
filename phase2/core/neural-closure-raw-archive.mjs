import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';

const ARCHIVE_SCHEMA='BINANCE_SPOT_RAW_KLINE_ARCHIVE_V1';

/**
 * Stream the canonical raw Binance kline envelope through gzip while hashing
 * both byte streams. This preserves the exact SHA-256 contract of
 * JSON.stringify({schema,symbol,interval,rows}) without constructing the full
 * JSON string, an equally large Buffer, or a synchronous compressed Buffer.
 *
 * The compressed archive is staged and renamed only after pipeline completion.
 */
export async function writeRawSpotKlineArchive({
  symbol,interval,rawRows,archiveDir
}={}){
  const normalizedSymbol=String(symbol||'').trim().toUpperCase();
  const normalizedInterval=String(interval||'').trim();
  if(!/^[A-Z0-9]+USDT$/.test(normalizedSymbol))
    throw new TypeError('NEURAL_RAW_ARCHIVE_SYMBOL_INVALID');
  if(!['1m','5m','15m'].includes(normalizedInterval))
    throw new TypeError('NEURAL_RAW_ARCHIVE_INTERVAL_INVALID');
  if(!Array.isArray(rawRows)||rawRows.some(row=>!Array.isArray(row)))
    throw new TypeError('NEURAL_RAW_ARCHIVE_ROWS_INVALID');
  if(typeof archiveDir!=='string'||!archiveDir.trim())
    throw new TypeError('NEURAL_RAW_ARCHIVE_DIRECTORY_REQUIRED');
  await mkdir(archiveDir,{recursive:true});

  const filename=normalizedSymbol+'.'+normalizedInterval+'.json.gz';
  const outputPath=join(archiveDir,filename);
  const temporaryPath=outputPath+'.tmp-'+process.pid+'-'+randomUUID();
  const rawHash=createHash('sha256');
  const compressedHash=createHash('sha256');
  let rawBytes=0,compressedBytes=0;
  const rawTap=new Transform({
    transform(chunk,encoding,callback){
      rawHash.update(chunk);
      rawBytes+=chunk.length;
      callback(null,chunk);
    }
  });
  const compressedTap=new Transform({
    transform(chunk,encoding,callback){
      compressedHash.update(chunk);
      compressedBytes+=chunk.length;
      callback(null,chunk);
    }
  });

  const emptyEnvelope=JSON.stringify({
    schema:ARCHIVE_SCHEMA,symbol:normalizedSymbol,
    interval:normalizedInterval,rows:[]
  });
  const prefix=emptyEnvelope.slice(0,-2);
  async function* canonicalChunks(){
    yield prefix;
    for(let index=0;index<rawRows.length;index++){
      const serialized=JSON.stringify(rawRows[index]);
      if(typeof serialized!=='string')
        throw new TypeError('NEURAL_RAW_ARCHIVE_ROW_NOT_JSON:'+index);
      yield (index===0?'':',')+serialized;
    }
    yield ']}';
  }

  try{
    await pipeline(
      Readable.from(canonicalChunks(),{objectMode:false}),
      rawTap,
      createGzip({level:9,chunkSize:64*1024}),
      compressedTap,
      createWriteStream(temporaryPath,{flags:'wx'})
    );
    await rename(temporaryPath,outputPath);
    return {
      file:filename,
      raw_sha256:rawHash.digest('hex'),
      compressed_sha256:compressedHash.digest('hex'),
      raw_bytes:rawBytes,
      compressed_bytes:compressedBytes,
      row_count:rawRows.length,
      streaming:true,
      atomic:true
    };
  }catch(error){
    await unlink(temporaryPath).catch(()=>{});
    throw error;
  }
}
