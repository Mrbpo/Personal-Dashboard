import {S3Client,GetObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import type {RecordingObject} from './recording-catalog.ts';

export function recordingTargetConfig(){
 const endpoint=process.env.RECORDINGS_S3_ENDPOINT,bucket=process.env.RECORDINGS_S3_BUCKET;
 if(!endpoint||!bucket)throw new Error('录像播放器尚未配置私有存储访问');
 let parsed:URL;try{parsed=new URL(endpoint);}catch{throw new Error('录像存储地址配置无效');}
 if(parsed.protocol!=='https:'||!(/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(parsed.hostname))||
  parsed.username||parsed.password||parsed.search||parsed.hash||parsed.port||!['','/'].includes(parsed.pathname))
  throw new Error('录像存储地址配置无效');
 return {bucket,endpointHost:parsed.hostname,endpoint:parsed.origin};
}

export function recordingStorageConfig(){
 const target=recordingTargetConfig();
 const accessKeyId=process.env.RECORDINGS_S3_ACCESS_KEY_ID,secretAccessKey=process.env.RECORDINGS_S3_SECRET_ACCESS_KEY;
 const sessionToken=process.env.RECORDINGS_S3_SESSION_TOKEN;
 if(!accessKeyId||!secretAccessKey)throw new Error('录像播放器尚未配置私有存储访问');
 return {...target,credentials:{accessKeyId,secretAccessKey,...(sessionToken?{sessionToken}:{})}};
}

export async function recordingPlaybackUrl(object:RecordingObject){
 const config=recordingStorageConfig();
 const client=new S3Client({region:'auto',endpoint:config.endpoint,forcePathStyle:true,credentials:config.credentials,
  maxAttempts:1,requestHandler:{requestTimeout:15000,connectionTimeout:5000}});
 try{
  const head=await client.send(new HeadObjectCommand({Bucket:config.bucket,Key:object.key}));
  if(head.ContentLength!==object.bytes||head.ETag!==object.etag)throw new Error('录像对象已变化，请更新归档后重试');
  const expiresIn=Math.min(21600,Math.max(3600,Math.ceil(object.durationSeconds??0)+1800));
  return await getSignedUrl(client,new GetObjectCommand({Bucket:config.bucket,Key:object.key,
   ResponseContentType:object.mime,ResponseContentDisposition:'inline',ResponseCacheControl:'private, no-store'}),{expiresIn});
 }finally{client.destroy();}
}
