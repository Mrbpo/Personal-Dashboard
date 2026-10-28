"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import type Artplayer from 'artplayer';
import {Play, RefreshCw, Video} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {Recording, RecordingCatalog} from '@/lib/recording-catalog';
import {attachSecondaryLayout,defaultSecondaryLayout,secondaryLayout,type SecondaryLayout} from '@/lib/recording-secondary-layout';
import {RecordingStudyGuide} from '@/components/recording-study-guide';
import './recording-player-layout.css';

type Playback = {time:number; rate:number; playing:boolean};
type SubtitleMode = 'bilingual'|'en'|'zh'|'off';
type SubtitleGeneration={configured:boolean;state:'idle'|'queued'|'running'|'deferred'|'failed'|'completed';requested:boolean;canRequest:boolean;retryAt:string|null;reasonCode:string|null};
type SubtitleInfo = {available:boolean;modes:Exclude<SubtitleMode,'off'>[];partial?:boolean;clipStartMs?:number;clipEndMs?:number;
  sourceMethod?:'local-asr'|'platform-caption';translated?:boolean;generation?:SubtitleGeneration};
const initialPlayback = ():Playback => ({time:0, rate:1, playing:false});
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

function duration(seconds:number|null) {
  if (seconds===null || !Number.isFinite(seconds) || seconds<0) return '';
  const minutes=Math.floor(seconds/60);
  return minutes>=60 ? `${Math.floor(minutes/60)}小时${minutes%60}分` : `${minutes}分钟`;
}
function published(value:number|null) {
  return value && Number.isFinite(value) ? new Date(value*1000).toLocaleDateString('zh-CN') : '';
}
function subtitleTime(milliseconds:number) {
  const seconds=Math.floor(milliseconds/1000);
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
}
function decodeWebVttEntities(text:string) {
  return text.replace(/&(amp|lt|gt);/g,entity=>entity==='&amp;'?'&':entity==='&lt;'?'<':'>');
}

export function RecordingPlayer() {
  const [catalog,setCatalog]=useState<RecordingCatalog>({courses:[],recordings:[],unavailableEntries:0});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [course,setCourse]=useState('');
  const [query,setQuery]=useState('');
  const [selection,setSelection]=useState<{recordingId:string;viewId:string}|null>(null);
  const [reload,setReload]=useState(0);
  const [rate,setRate]=useState(1);
  const [mediaError,setMediaError]=useState(false);
  const [subtitleMode,setSubtitleMode]=useState<SubtitleMode>('bilingual');
  const [subtitleMetadata,setSubtitleMetadata]=useState<{viewId:string;info:SubtitleInfo|null;status:'loading'|'ready'|'error'}|null>(null);
  const [subtitleError,setSubtitleError]=useState(false);
  const [subtitleRefresh,setSubtitleRefresh]=useState(0);
  const [subtitleSubmit,setSubtitleSubmit]=useState({viewId:'',busy:false,error:''});
  const submittingSubtitle=useRef(false);
  const [playerRevision,setPlayerRevision]=useState(0);
  const [captionSize,setCaptionSize]=useState(20);
  const [showSecondary,setShowSecondary]=useState(true);
  const [secondaryViewId,setSecondaryViewId]=useState('');
  const secondaryPlacement=useRef<SecondaryLayout>({...defaultSecondaryLayout});
  const secondaryReset=useRef<(()=>void)|null>(null);
  const container=useRef<HTMLDivElement>(null);
  const player=useRef<Artplayer|null>(null);
  const playback=useRef<Playback>(initialPlayback());
  const pending=useRef<Playback|null>(null);
  const subtitleRequest=useRef(0);
  const subtitleQueue=useRef<Promise<void>>(Promise.resolve());
  useEffect(()=>{
    try{const saved=localStorage.getItem('recording-secondary-layout-v1');if(saved&&saved.length<512)secondaryPlacement.current=secondaryLayout(JSON.parse(saved));}catch{/* Storage may be unavailable. */}
  },[]);
  useEffect(()=>{
    if(player.current)player.current.template.$player.dataset.captionSize=String(captionSize);
  },[captionSize,playerRevision]);

  useEffect(()=>{
    const controller=new AbortController();
    async function load() {
      setLoading(true); setError('');
      try {
        const response=await fetch('/api/recordings',{cache:'no-store',signal:controller.signal});
        if (!response.ok) {
          if(response.status===401) throw new Error('请先登录后查看课程录像。');
          if(response.status===503) {
            const failure=await response.json().catch(()=>null) as {error?:unknown}|null;
            throw new Error(typeof failure?.error==='string'?failure.error:'录像归档或播放服务尚未配置，请联系管理员。');
          }
          throw new Error('无法读取录像列表，请稍后重试。');
        }
        const data=await response.json() as RecordingCatalog;
        if(controller.signal.aborted)return;
        setCatalog(data);
        setSelection(previous=>{
          if(previous && data.recordings.some(item=>item.id===previous.recordingId && item.views.some(view=>view.id===previous.viewId))) return previous;
          const first=data.recordings.find(item=>item.views.length);
          playback.current=initialPlayback(); pending.current=null;
          return first ? {recordingId:first.id,viewId:first.views[0].id} : null;
        });
      } catch (reason) {
        if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'无法读取录像列表。');
      } finally {if(!controller.signal.aborted)setLoading(false);}
    }
    void load();
    return ()=>controller.abort();
  },[refresh]);

  const recording=catalog.recordings.find(item=>item.id===selection?.recordingId);
  const view=recording?.views.find(item=>item.id===selection?.viewId);
  const normalized=query.trim().toLocaleLowerCase();
  const visible=catalog.recordings.filter(item=>(!course || item.courseId===course) &&
    (!normalized || `${item.title} ${catalog.courses.find(candidate=>candidate.id===item.courseId)?.name??''}`.toLocaleLowerCase().includes(normalized)));
  const currentCourse=catalog.courses.find(item=>item.id===recording?.courseId)?.name;
  const mediaUrl=view?`/api/recordings/${encodeURIComponent(view.id)}/play?reload=${reload}`:'';
  const viewId=view?.id??'';
  const subtitleBase=viewId?`/api/recordings/${encodeURIComponent(viewId)}/subtitles`:'';
  const subtitleState=subtitleMetadata?.viewId===viewId?subtitleMetadata:null;
  const subtitleInfo=subtitleState?.info;
  const subtitleComplete=!!subtitleInfo?.available&&!subtitleInfo.partial&&!!subtitleInfo.translated;
  const generation=subtitleInfo?.generation;
  const secondaryViews=recording?.views.filter(item=>item.id!==viewId)??[];
  const secondaryView=secondaryViews.find(item=>item.id===secondaryViewId)??secondaryViews[0];
  const secondaryLabel=secondaryView?.label??'';
  const secondaryUrl=secondaryView?`/api/recordings/${encodeURIComponent(secondaryView.id)}/play?reload=${reload}`:'';

  useEffect(()=>{
    if(!mediaUrl || !container.current)return;
    let disposed=false;
    let instance:Artplayer|undefined;
    const desired={...(pending.current??playback.current)};
    pending.current=null;
    async function mount() {
      try {
        const {default:Artplayer}=await import('artplayer');
        if(disposed || !container.current)return;
        // A failed/expired URL is retried only by the visible reload button.
        Artplayer.RECONNECT_TIME_MAX=0;
        Artplayer.LOG_VERSION=false;
        instance=new Artplayer({container:container.current,url:mediaUrl,lang:'zh-cn',
          autoplay:false,autoPlayback:false,autoMini:false,setting:true,playbackRate:true,
          fullscreen:true,fullscreenWeb:true,pip:false,hotkey:true,playsInline:true,
          miniProgressBar:true,mutex:true,screenshot:false,moreVideoAttr:{preload:'metadata',disablePictureInPicture:true},
          subtitle:{escape:true,style:{lineHeight:'1.4',fontWeight:'500'}},
          cssVar:{'--art-subtitle-font-size':'clamp(16px, 2.2vw, 25px)','--art-subtitle-gap':'3px'}});
        player.current=instance;
        instance.template.$player.classList.add('recording-player-root');
        const active=()=>!disposed && player.current===instance;
        instance.subtitle.show=false;
        const decodedCues=new WeakSet<VTTCue>();
        instance.on('subtitleBeforeUpdate',(value:unknown)=>{
          // Native cue.text keeps VTT entities; ArtPlayer then HTML-escapes the text.
          // 5.4.0 emits an array here although its declaration describes one cue.
          if(!Array.isArray(value))return;
          for(const cue of value as VTTCue[])if(!decodedCues.has(cue)){
            decodedCues.add(cue);cue.text=decodeWebVttEntities(cue.text);
          }
        });
        subtitleQueue.current=Promise.resolve();
        setPlayerRevision(value=>value+1);
        instance.on('video:loadedmetadata',()=>{
          if(!active() || !instance)return;
          const element=instance.video;
          element.playbackRate=desired.rate;
          if(desired.time>0)element.currentTime=Number.isFinite(element.duration)?Math.min(desired.time,Math.max(0,element.duration-0.1)):desired.time;
          playback.current={...desired}; setRate(desired.rate);
          if(desired.playing)void element.play().catch(()=>{if(active())playback.current.playing=false;});
        });
        instance.on('video:error',()=>{if(active())setMediaError(true);});
        instance.on('video:timeupdate',()=>{if(active() && instance)playback.current.time=instance.video.currentTime;});
        instance.on('video:play',()=>{if(active())playback.current.playing=true;});
        instance.on('video:pause',()=>{if(active())playback.current.playing=false;});
        instance.on('video:ratechange',()=>{if(active() && instance){playback.current.rate=instance.video.playbackRate;setRate(instance.video.playbackRate);}});
      } catch {if(!disposed)setMediaError(true);}
    }
    void mount();
    return ()=>{
      disposed=true;
      if(instance){
        if(player.current===instance)player.current=null;
        if(instance.subtitle.url.startsWith('blob:'))URL.revokeObjectURL(instance.subtitle.url);
        instance.destroy(true);
      }
    };
  },[mediaUrl]);

  useEffect(()=>{
    const instance=player.current;
    if(!instance || !showSecondary || !secondaryUrl)return;
    const root=instance.template.$player,main=instance.video;
    const overlay=document.createElement('div');overlay.className='recording-secondary';
    overlay.setAttribute('aria-label',`副画面 · ${secondaryLabel}`);
    const secondary=document.createElement('video');secondary.className='recording-secondary-video';
    secondary.muted=true;secondary.defaultMuted=true;secondary.playsInline=true;
    secondary.preload='metadata';secondary.disablePictureInPicture=true;
    const bar=document.createElement('div');bar.className='recording-secondary-bar';
    const label=document.createElement('span');label.textContent=`副画面 · ${secondaryLabel}`;
    const close=document.createElement('button');close.type='button';close.textContent='关闭';close.setAttribute('aria-label','关闭副画面');
    const closeSecondary=(event:Event)=>{event.stopPropagation();setShowSecondary(false);};
    close.addEventListener('click',closeSecondary);bar.append(label,close);
    const unavailable=document.createElement('p');unavailable.className='recording-secondary-error';unavailable.hidden=true;
    unavailable.textContent='副画面暂不可用，主画面仍可播放。';
    const resize=document.createElement('button');resize.type='button';resize.className='recording-secondary-resize';
    resize.textContent='↘';resize.setAttribute('aria-label','调整副画面大小');
    overlay.append(secondary,bar,unavailable,resize);root.append(overlay);
    const placement=attachSecondaryLayout(root,main,overlay,bar,resize,()=>secondaryPlacement.current,(next,persist)=>{
      secondaryPlacement.current=next;
      if(persist)try{localStorage.setItem('recording-secondary-layout-v1',JSON.stringify(next));}catch{/* Keep the in-memory layout. */}
    });
    secondaryReset.current=placement.reset;
    let disposed=false,playBlocked=false;
    function synchronize(forceSeek=false) {
      if(disposed)return;
      if(main.paused || main.ended)secondary.pause();
      if(secondary.readyState<1)return;
      secondary.playbackRate=main.playbackRate;
      const end=Number.isFinite(secondary.duration)?Math.max(0,secondary.duration-0.05):Infinity;
      const target=Math.min(main.currentTime,end);
      if(forceSeek || Math.abs(secondary.currentTime-target)>0.5)secondary.currentTime=target;
      if(main.currentTime>=end || main.paused || main.ended){secondary.pause();return;}
      if(secondary.paused && !playBlocked)void secondary.play().catch(reason=>{
        if(!disposed && !(reason instanceof DOMException && reason.name==='AbortError'))playBlocked=true;
      });
    }
    const onPlay=()=>{playBlocked=false;synchronize();};
    const onPause=()=>secondary.pause();
    const onSeek=()=>synchronize(true);
    const onProgress=()=>synchronize();
    const onError=()=>{if(!disposed){secondary.pause();unavailable.hidden=false;}};
    main.addEventListener('play',onPlay);main.addEventListener('pause',onPause);main.addEventListener('ended',onPause);
    main.addEventListener('seeking',onSeek);main.addEventListener('seeked',onSeek);
    main.addEventListener('ratechange',onProgress);main.addEventListener('timeupdate',onProgress);
    secondary.addEventListener('loadedmetadata',onSeek);secondary.addEventListener('error',onError);
    secondary.src=secondaryUrl;
    return ()=>{
      disposed=true;
      main.removeEventListener('play',onPlay);main.removeEventListener('pause',onPause);main.removeEventListener('ended',onPause);
      main.removeEventListener('seeking',onSeek);main.removeEventListener('seeked',onSeek);
      main.removeEventListener('ratechange',onProgress);main.removeEventListener('timeupdate',onProgress);
      secondary.removeEventListener('loadedmetadata',onSeek);secondary.removeEventListener('error',onError);
      close.removeEventListener('click',closeSecondary);
      placement.dispose();if(secondaryReset.current===placement.reset)secondaryReset.current=null;
      secondary.pause();secondary.removeAttribute('src');secondary.load();overlay.remove();
    };
  },[secondaryUrl,secondaryLabel,showSecondary,playerRevision]);

  useEffect(()=>{
    if(!viewId || !subtitleBase)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const stopAt=Date.now()+15*60*1000;
    setSubtitleMetadata(current=>current?.viewId===viewId?current:{viewId,info:null,status:'loading'});
    async function loadMetadata() {
      try {
        const response=await fetch(subtitleBase,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('字幕信息暂不可用');
        const info=await response.json() as SubtitleInfo;
        if(!controller.signal.aborted){
          setSubtitleMetadata(current=>current?.viewId===viewId&&JSON.stringify(current.info)===JSON.stringify(info)&&current.status==='ready'?current:{viewId,info,status:'ready'});
          if(Date.now()<stopAt&&(info.generation?.state==='running'||info.generation?.state==='queued'&&info.generation.requested))timer=setTimeout(()=>void loadMetadata(),5000);
        }
      } catch {if(!controller.signal.aborted)setSubtitleMetadata({viewId,info:null,status:'error'});}
    }
    void loadMetadata();
    return ()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[viewId,subtitleBase,reload,subtitleRefresh]);

  async function generateSubtitles(){
    if(!viewId||submittingSubtitle.current||!generation?.canRequest)return;
    const requestedView=viewId;
    submittingSubtitle.current=true;setSubtitleSubmit({viewId:requestedView,busy:true,error:''});
    try{
      const response=await fetch(subtitleBase,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const result=await response.json();
      if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'字幕请求未能提交');
      setSubtitleMetadata(current=>current?.viewId===requestedView&&current.info?{...current,info:{...current.info,generation:result.generation}}:current);
      setSubtitleRefresh(value=>value+1);
    }catch(reason){setSubtitleSubmit({viewId:requestedView,busy:false,error:reason instanceof Error?reason.message:'字幕请求未能提交'});}
    finally{submittingSubtitle.current=false;setSubtitleSubmit(current=>current.viewId===requestedView?{...current,busy:false}:current);}
  }

  useEffect(()=>{
    const instance=player.current;
    const request=++subtitleRequest.current;
    const controller=new AbortController();
    let disposed=false;
    const active=()=>!disposed && !controller.signal.aborted && player.current===instance &&
      !instance?.isDestroy && subtitleRequest.current===request;
    setSubtitleError(false);
    if(instance)instance.subtitle.show=false;
    if(instance && subtitleMode!=='off' && subtitleInfo?.available && subtitleInfo.modes.includes(subtitleMode)) {
      async function applySubtitle() {
        let inputUrl:string|undefined;
        try {
          // Check HTTP status ourselves: ArtPlayer's subtitle fetch does not reject HTTP errors.
          const response=await fetch(`${subtitleBase}?mode=${subtitleMode}`,{cache:'no-store',signal:controller.signal});
          if(!response.ok)throw new Error('字幕加载失败');
          const text=await response.text();
          if(!active())return;
          inputUrl=URL.createObjectURL(new Blob([text],{type:'text/vtt'}));
          const url=inputUrl;
          // ArtPlayer cannot abort switch(). Serialize it and hide any superseded result.
          const job=subtitleQueue.current.catch(()=>undefined).then(async()=>{
            if(!active() || !instance)return;
            const result=await instance.subtitle.switch(url,{type:'vtt',escape:true});
            if(active())instance.subtitle.show=true;
            else if(result?.startsWith('blob:'))URL.revokeObjectURL(result);
          });
          subtitleQueue.current=job;
          await job;
        } catch {if(active())setSubtitleError(true);}
        finally {if(inputUrl)URL.revokeObjectURL(inputUrl);}
      }
      void applySubtitle();
    }
    return ()=>{disposed=true;controller.abort();};
  },[subtitleBase,subtitleInfo,subtitleMode,playerRevision]);

  function choose(item:Recording) {
    if(item.id===selection?.recordingId || !item.views.length)return;
    playback.current=initialPlayback(); pending.current=null;
    setSecondaryViewId('');
    setSelection({recordingId:item.id,viewId:item.views[0].id});
    setRate(1); setMediaError(false); setReload(0);
  }
  const snapshot=useCallback(()=>{
    const element=player.current?.video;
    return element && element.readyState>=1 ? {time:element.currentTime,rate:element.playbackRate,playing:!element.paused && !element.ended} : {...playback.current};
  },[]);
  function changeView(id:string) {
    if(!recording || id===selection?.viewId)return;
    pending.current=snapshot();
    setMediaError(false); setSelection({recordingId:recording.id,viewId:id});
  }
  function retryPlayback() {
    pending.current=snapshot();
    setMediaError(false); setReload(value=>value+1);
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
    <aside aria-label="课程录像列表" className="flex min-w-0 flex-col rounded-lg border bg-card p-4 lg:max-h-[calc(100dvh-15rem)] lg:min-h-[520px]">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="font-medium">课程录像</h2>
        <Button type="button" variant="ghost" size="icon-sm" disabled={loading} aria-label="刷新录像列表" onClick={()=>setRefresh(value=>value+1)}><RefreshCw className={loading?'animate-spin':''}/></Button>
      </div>
      <label className="text-sm" htmlFor="recording-course">课程</label>
      <select id="recording-course" value={course} onChange={event=>setCourse(event.target.value)} className={`${fieldClass} mt-1`}>
        <option value="">全部课程</option>
        {catalog.courses.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <label className="mt-3 text-sm" htmlFor="recording-search">搜索录像</label>
      <input id="recording-search" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="标题或课程" className={`${fieldClass} mt-1`}/>
      <p className="my-3 text-xs text-muted-foreground" aria-live="polite">{loading?'正在读取…':`${visible.length} 场录像`}</p>
      {!loading && !error && catalog.unavailableEntries>0 && <p className="mb-3 text-xs leading-5 text-muted-foreground">另有 {catalog.unavailableEntries} 路录像尚不可播放，暂未列入。</p>}
      {error && <div role="alert" className="mb-3 text-sm text-destructive">{error}<Button className="mt-2" type="button" variant="outline" size="sm" onClick={()=>setRefresh(value=>value+1)}>重新读取</Button></div>}
      <ul className="max-h-72 space-y-2 overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
        {visible.map(item=><li key={item.id}><button type="button" onClick={()=>choose(item)} aria-pressed={item.id===recording?.id}
          className={`w-full rounded-md border p-3 text-left text-sm transition-colors ${item.id===recording?.id?'border-primary bg-primary/10':'border-transparent hover:bg-muted'}`}>
          <span className="flex items-start gap-2"><Play className="mt-0.5 size-4 shrink-0"/><span className="break-words font-medium">{item.title}</span></span>
          <span className="mt-2 block text-xs text-muted-foreground">{catalog.courses.find(candidate=>candidate.id===item.courseId)?.name??item.courseId}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{[published(item.publishedAt),duration(item.durationSeconds),item.views.length>1?`${item.views.length} 个视角`:''].filter(Boolean).join(' · ')}</span>
        </button></li>)}
      </ul>
      {!loading && !error && !visible.length && <p className="py-6 text-sm text-muted-foreground">{catalog.recordings.length?'没有符合筛选条件的录像。':'还没有可播放的归档录像。'}</p>}
    </aside>
    <section aria-label="录像播放器" className="min-w-0 rounded-lg border bg-card p-4 md:p-5">
      {recording && view ? <>
        <p className="text-sm text-muted-foreground">{currentCourse??recording.courseId}</p>
        <h2 className="mt-1 break-words text-lg font-medium">{recording.title}</h2>
        <div className="my-4 flex flex-wrap items-center gap-3">
          {recording.views.length>1 && <label className="flex items-center gap-2 text-sm">主画面<select aria-label="播放视角" value={view.id} onChange={event=>changeView(event.target.value)} className="rounded-md border bg-background px-2 py-1.5">
            {recording.views.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>}
          <label className="flex items-center gap-2 text-sm">倍速<select aria-label="播放速度" value={rate} onChange={event=>{const next=Number(event.target.value);setRate(next);playback.current.rate=next;if(player.current)player.current.video.playbackRate=next;}} className="rounded-md border bg-background px-2 py-1.5">
            {[0.5,0.75,1,1.25,1.5,1.75,2].map(value=><option key={value} value={value}>{value}×</option>)}
          </select></label>
          <label className="flex items-center gap-2 text-sm">字幕<select aria-label="字幕语言" value={subtitleMode} onChange={event=>setSubtitleMode(event.target.value as SubtitleMode)} className="rounded-md border bg-background px-2 py-1.5">
            <option value="bilingual" disabled={!subtitleInfo?.modes.includes('bilingual')}>双语</option>
            <option value="en" disabled={!subtitleInfo?.modes.includes('en')}>English</option>
            <option value="zh" disabled={!subtitleInfo?.modes.includes('zh')}>中文</option>
            <option value="off">关闭</option>
          </select></label>
          {subtitleState?.status==='ready'&&!subtitleComplete&&<Button type="button" variant="outline" size="sm"
            disabled={!generation?.canRequest||subtitleSubmit.viewId===viewId&&subtitleSubmit.busy} onClick={()=>void generateSubtitles()}
            title={generation?.state==='queued'&&generation.canRequest?'已在自动队列，点击优先处理这段录像':undefined}>
            {subtitleSubmit.viewId===viewId&&subtitleSubmit.busy?'正在提交…':generation?.state==='running'?'字幕生成中…':generation?.state==='queued'&&generation.requested?'字幕已排队':generation?.state==='deferred'?'字幕等待资源／额度':generation?.state==='failed'?'字幕待检查':!generation?.configured?'字幕后台未启用':subtitleInfo?.available?'补全字幕':'生成字幕'}
          </Button>}
          <label className="flex items-center gap-2 text-sm">全屏字幕区<select aria-label="全屏字幕区比例" value={captionSize} onChange={event=>setCaptionSize(Number(event.target.value))} className="rounded-md border bg-background px-2 py-1.5">
            {[20,25,30].map(value=><option key={value} value={value}>{value}%</option>)}
          </select></label>
          {secondaryView && <>
            <Button type="button" variant="outline" size="sm" onClick={()=>setShowSecondary(value=>!value)}>{showSecondary?'关闭小窗':secondaryLabel.includes('摄像头')?'显示摄像头':'显示副画面'}</Button>
            {showSecondary && <>
              <label className="flex items-center gap-2 text-sm">副画面<select aria-label="副画面视角" value={secondaryView.id} onChange={event=>setSecondaryViewId(event.target.value)} className="rounded-md border bg-background px-2 py-1.5">
                {secondaryViews.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
              </select></label>
              <Button type="button" variant="outline" size="sm" onClick={()=>{setSecondaryViewId(view.id);changeView(secondaryView.id);}}>交换主副画面</Button>
              <Button type="button" variant="ghost" size="sm" onClick={()=>secondaryReset.current?.()}>重置小窗位置</Button>
            </>}
          </>}
          <Button type="button" variant="ghost" size="sm" onClick={retryPlayback}><RefreshCw/>重新加载</Button>
        </div>
        <div ref={container} aria-label={`${recording.title}播放器`} className="aspect-video w-full overflow-hidden rounded-md bg-black"/>
        {mediaError && <p role="alert" className="mt-3 text-sm text-destructive">无法播放：链接可能已过期、网络暂时不可用，或浏览器不支持原片格式。请点击“重新加载”重试。</p>}
        <div className="mt-3 text-xs leading-5 text-muted-foreground" aria-live="polite">
          {subtitleSubmit.viewId===viewId&&subtitleSubmit.error&&<p role="alert">{subtitleSubmit.error}</p>}
          {generation?.state==='failed'&&<p>字幕任务需检查上次失败记录，暂不自动重试；已有字幕和视频保留。</p>}
          {generation?.state==='deferred'&&<p>字幕任务等待资源或运行额度恢复，进度已保存。</p>}
          {generation?.state==='queued'&&generation.requested&&<p>已优先排队，将在当前转写任务完成后处理。</p>}
          {subtitleState?.status==='ready'&&!subtitleComplete&&<button type="button" className="underline" onClick={()=>setSubtitleRefresh(value=>value+1)}>刷新字幕状态</button>}
          {(!subtitleState || subtitleState.status==='loading') && <p>正在查找字幕…</p>}
          {(subtitleState?.status==='error' || subtitleError) && <p>字幕暂时无法读取，可重新加载重试；视频仍可播放。</p>}
          {subtitleState?.status==='ready' && !subtitleInfo?.available && <p>这段录像暂未生成字幕。</p>}
          {subtitleInfo?.available && <>
            <p>{subtitleInfo.sourceMethod==='local-asr'?'英文字幕为自动转写。':'原字幕来自课程平台。'}{subtitleInfo.translated?'中文为机器翻译。':''}请结合原声核对。</p>
            {subtitleInfo.partial && <p>当前字幕仅覆盖 {subtitleTime(subtitleInfo.clipStartMs??0)}–{subtitleTime(subtitleInfo.clipEndMs??0)}，其余时段暂无字幕。</p>}
            {subtitleMode!=='off' && !subtitleInfo.modes.includes(subtitleMode) && <p>当前语言暂无字幕，请选择已有语言。</p>}
          </>}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">播放归档原片。可拖动进度、倍速或全屏；副画面始终静音并跟随主画面进度。聚焦播放器后，空格暂停，方向键快进快退。</p>
        <RecordingStudyGuide key={view.id} viewId={view.id}/>
      </> : <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-muted-foreground"><Video className="size-9"/><p>{loading?'正在读取课程录像…':'在左侧选择一场录像开始播放。'}</p></div>}
    </section>
  </div>;
}
