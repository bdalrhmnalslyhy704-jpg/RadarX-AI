import {open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

/**
 * Write a JSON object containing one large array without serializing the full
 * document or array into a single JavaScript string.
 *
 * The output is staged beside the destination and atomically renamed only after
 * every row has serialized, the file has been flushed, and its handle closed.
 * A failed write removes the staging file and never exposes a partial dataset.
 */
export async function writeJsonObjectWithArrayStreaming(
  outputPath,document,arrayKey='rows',rowsOverride
){
  if(typeof outputPath!=='string'||!outputPath.trim())
    throw new TypeError('NEURAL_STREAM_OUTPUT_PATH_REQUIRED');
  if(!document||typeof document!=='object'||Array.isArray(document))
    throw new TypeError('NEURAL_STREAM_DOCUMENT_INVALID');
  if(typeof arrayKey!=='string'||!arrayKey)
    throw new TypeError('NEURAL_STREAM_ARRAY_KEY_INVALID');
  const rows=rowsOverride??document[arrayKey];
  if(!Array.isArray(rows))
    throw new TypeError('NEURAL_STREAM_ROWS_REQUIRED');
  const metadata={...document};
  delete metadata[arrayKey];
  const header=JSON.stringify(metadata,null,2);
  if(typeof header!=='string'||!header.startsWith('{')||!header.endsWith('}'))
    throw new TypeError('NEURAL_STREAM_METADATA_NOT_JSON_OBJECT');
  const temporaryPath=outputPath+'.tmp-'+process.pid+'-'+randomUUID();
  const handle=await open(temporaryPath,'wx');
  let closed=false;
  try{
    await handle.writeFile(
      header.slice(0,-1)+',\\n  '+JSON.stringify(arrayKey)+': [\\n',
      'utf8'
    );
    let batch='';
    const maximumBatchCharacters=1024*1024;
    for(let index=0;index<rows.length;index++){
      const serialized=JSON.stringify(rows[index]);
      if(typeof serialized!=='string')
        throw new TypeError('NEURAL_STREAM_ROW_NOT_SERIALIZABLE:'+index);
      const fragment=(index===0?'':',\\n')+'    '+serialized;
      if(batch.length>0&&batch.length+fragment.length>maximumBatchCharacters){
        await handle.writeFile(batch,'utf8');
        batch='';
      }
      batch+=fragment;
      if(batch.length>=maximumBatchCharacters){
        await handle.writeFile(batch,'utf8');
        batch='';
      }
    }
    if(batch)await handle.writeFile(batch,'utf8');
    await handle.writeFile('\\n  ]\\n}\\n','utf8');
    await handle.sync();
    await handle.close();
    closed=true;
    await rename(temporaryPath,outputPath);
    return {path:outputPath,row_count:rows.length,atomic:true,streamed:true};
  }catch(error){
    if(!closed){
      await handle.close().catch(()=>{});
      closed=true;
    }
    await unlink(temporaryPath).catch(()=>{});
    throw error;
  }
}
