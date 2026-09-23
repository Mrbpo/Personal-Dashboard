import {apiOwner,apiError} from '@/lib/api-guard';
import {getPageAnnotationScene,putPageAnnotationScene,MAX_SCENE_BYTES} from '@/lib/pdf-annotation-scenes';

function pageFrom(request:Request){return Number(new URL(request.url).searchParams.get('page'));}

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const owner=await apiOwner(request),{id}=await params;
    return Response.json(await getPageAnnotationScene(owner,id,pageFrom(request)),{headers:{'Cache-Control':'no-store'}});
  }catch(error){return apiError(error);}
}

export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const owner=await apiOwner(request),{id}=await params;
    if(Number(request.headers.get('content-length')||0)>MAX_SCENE_BYTES+1024)throw new Error('绘图数据超出限制');
    const reader=request.body?.getReader();
    if(!reader)throw new Error('请求为空');
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_SCENE_BYTES+1024){await reader.cancel();throw new Error('绘图数据超出限制');}chunks.push(value);}
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const saved=await putPageAnnotationScene(owner,id,pageFrom(request),payload?.revision,payload?.scene);
    if(!saved)return Response.json({error:'另一窗口已修改此页绘图，请刷新后重试'},{status:409});
    return Response.json(saved,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return apiError(error);}
}
