import {apiError,apiOwner,boundedForm} from '@/lib/api-guard';
import {getDocument,listFileCourseIds,listFileDocuments,MAX_LIBRARY_BYTES,normalizeFolderPath,readBlob,saveDocument} from '@/lib/library';
import {listCourseSettings} from '@/lib/repository';
import {assertRecordingOwner,buildRecordingCatalog,readRecordingManifest} from '@/lib/recording-catalog';
import {recordingTargetConfig} from '@/lib/recording-storage';
import {guideFiles,readGuideManifest,type GuideFormat} from '@/lib/recording-guide';
import {readRecordingSubtitles,subtitleMetadata} from '@/lib/recording-subtitles';
import {validateAttachment} from '@/lib/tutor';
import {enqueue} from '@/lib/jobs';
import {documentFolders,filesApi,type FileNode} from '@/lib/course-file-tree';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
async function recordingIndex(owner:string){
  assertRecordingOwner(owner);
  return buildRecordingCatalog(await readRecordingManifest(),recordingTargetConfig());
}

export async function GET(request:Request){
  try {
    const owner=await apiOwner(request), query=new URL(request.url).searchParams;
    const document=query.get('document'), lecture=query.get('lecture'), course=query.get('courseId');
    if([document,lecture,course].filter(x=>x!==null).length>1) return json({error:'请选择一个目录或文件'},400);
    if(document!==null){
      if(!/^[a-f0-9]{64}$/.test(document))return json({error:'文件不存在'},404);
      const file=await getDocument(owner,document).catch(error=>{
        if(error instanceof Error&&error.message==='资料不存在')return null;
        throw error;
      });
      if(!file)return json({error:'文件不存在'},404);
      const name=encodeURIComponent(file.original_name||file.name).replace(/'/g,'%27');
      return new Response(await readBlob(file.hash),{headers:{...headers,'Content-Type':'application/octet-stream',
        'Content-Disposition':"attachment; filename*=UTF-8''"+name}});
    }
    if(lecture!==null){
      if(!/^[a-f0-9]{64}$/.test(lecture))return json({error:'课次不存在'},404);
      const {catalog,objects}=await recordingIndex(owner);
      const recording=catalog.recordings.find(row=>row.id===lecture);
      if(!recording)return json({error:'课次不存在'},404);
      const entries:FileNode[]=[], warnings=new Set<string>();
      for(const view of recording.views){
        const base='/api/recordings/'+view.id;
        entries.push({id:'video:'+view.id,kind:'file',name:view.label+(view.mime==='video/webm'?'.webm':'.mp4'),
          bytes:view.bytes,storage:'r2',downloadUrl:base+'/play?download=1'});
        const obj=objects.get(view.id)!;
        const sub=subtitleMetadata(await readRecordingSubtitles(obj).catch(()=>{
          warnings.add(view.label+'的字幕暂时无法读取');return null;
        }),obj.durationSeconds);
        if(sub.available){
          const mode=sub.translatedCues?'bilingual':'en';
          entries.push({id:'captions:'+view.id,kind:'file',name:view.label+(sub.translatedCues?'·中英字幕':'·英文字幕')+'.vtt',
            storage:'server',downloadUrl:base+'/subtitles?mode='+mode+'&download=1'});
        }
      }
      if(recording.guideViewId){
        const object=objects.get(recording.guideViewId)!;
        const readGuide=(edition?:string)=>readGuideManifest(object,edition).catch(()=>{
          warnings.add('部分讲义暂时无法读取');return null;
        });
        const current=await readGuide();
        const reviewed=current?.schemaVersion===2?await readGuide('reviewed'):null;
        for(const guide of [current,reviewed]){
          if(!guide)continue;
          const automatic=guide.schemaVersion===2;
          const qualifier=automatic?'version='+guide.version:'edition=reviewed';
          for(const format of Object.keys(guide.files) as GuideFormat[]){
            const file=guide.files[format as keyof typeof guide.files];
            entries.push({id:'guide:'+object.id+':'+qualifier+':'+format,kind:'file',
              name:(automatic?'讲义':'校订样例')+' · '+guideFiles[format].name,bytes:file.bytes,
              storage:automatic?'r2-archive':'server',downloadUrl:'/api/recordings/'+object.id+'/guide?'+qualifier+'&format='+format+'&download=1'});
          }
        }
      }
      return json({entries,warning:[...warnings].join('；')||undefined});
    }
    let warning:string|undefined;
    const index=await recordingIndex(owner).catch(error=>{
      if(!(error instanceof Error&&error.message==='FORBIDDEN'))warning='录像目录暂时无法读取';
      return null;
    });
    const recordings=index?.catalog.recordings??[];
    if(course!==null){
      const entries:FileNode[]=[];
      const lectures=recordings.filter(row=>row.courseId===course).map(row=>({
        id:row.id,name:row.title,kind:'lecture' as const,publishedAt:row.publishedAt,childrenUrl:filesApi+'?lecture='+row.id,
      }));
      if(lectures.length)entries.push({id:'recordings',name:'课程录像',kind:'folder',children:lectures});
      const docs=documentFolders(await listFileDocuments(owner,course));
      if(docs.length)entries.push({id:'documents',name:'课程资料',kind:'folder',children:docs});
      return json({entries,warning});
    }
    const [courses,ids]=await Promise.all([listCourseSettings(),listFileCourseIds(owner)]);
    const names=new Map(courses.map(c=>[c.id,c.name||c.code]));
    const available=new Set([...courses.filter(c=>c.enabled).map(c=>c.id),...ids,...recordings.map(r=>r.courseId),'']);
    const entries=[...available].sort().map(id=>({id,kind:'course',name:id?(names.get(id)||id):'未分课程',
      childrenUrl:filesApi+'?courseId='+encodeURIComponent(id)}));
    return json({entries,warning});
  } catch(error){return apiError(error);}
}

export async function POST(request:Request){
  try{
    const owner=await apiOwner(request);
    const form=await boundedForm(request,MAX_LIBRARY_BYTES+1024*1024);
    const file=form.get('file'),course=String(form.get('courseId')||''),folder=String(form.get('folderPath')||'上传');
    if(!(file instanceof File)||!file.size||file.size>MAX_LIBRARY_BYTES)return json({error:'请选择不超过 50 MiB 的非空文件'},400);
    if(!file.name.trim()||file.name.length>160||/[\\/\u0000-\u001f\u007f]/u.test(file.name)||['.','..'].includes(file.name))
      return json({error:'文件名无效'},400);
    if(folder.length>1000||normalizeFolderPath(folder)!==folder||/[\u0000-\u001f\u007f]/u.test(folder))
      return json({error:'请使用相对目录，例如 习题/第1周'},400);
    if(course&&!(await listCourseSettings()).some(c=>c.id===course&&c.enabled))return json({error:'请选择已启用的课程'},400);
    const bytes=new Uint8Array(await file.arrayBuffer());
    const indexed=/\.(pdf|docx?|txt|md|png|jpe?g|webp)$/i.test(file.name);
    const mime=indexed?validateAttachment(file.name,bytes,MAX_LIBRARY_BYTES).mime:'application/octet-stream';
    const id=await saveDocument(owner,course,'upload',folder+'/'+file.name,file.name,mime,bytes,folder,undefined,indexed?'index':'store');
    if(indexed)await enqueue('index',{owner,id},'index:'+id);
    return json({id,name:file.name,courseId:course,folderPath:folder,downloadUrl:filesApi+'?document='+id},201);
  } catch(error){return apiError(error);}
}
