"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import type Artplayer from 'artplayer';
import {Play, RefreshCw, Video} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {Recording, RecordingCatalog} from '@/lib/recording-catalog';

type Playback = {time:number; rate:number; playing:boolean};
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
  const container=useRef<HTMLDivElement>(null);
  const player=useRef<Artplayer|null>(null);
  const playback=useRef<Playback>(initialPlayback());
  const pending=useRef<Playback|null>(null);

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
          fullscreen:true,fullscreenWeb:true,pip:true,hotkey:true,playsInline:true,
          miniProgressBar:true,mutex:true,screenshot:false,moreVideoAttr:{preload:'metadata'}});
        player.current=instance;
        const active=()=>!disposed && player.current===instance;
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
      if(instance){if(player.current===instance)player.current=null;instance.destroy(true);}
    };
  },[mediaUrl]);

  function choose(item:Recording) {
    if(item.id===selection?.recordingId || !item.views.length)return;
    playback.current=initialPlayback(); pending.current=null;
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
          {recording.views.length>1 && <label className="flex items-center gap-2 text-sm">视角<select aria-label="播放视角" value={view.id} onChange={event=>changeView(event.target.value)} className="rounded-md border bg-background px-2 py-1.5">
            {recording.views.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>}
          <label className="flex items-center gap-2 text-sm">倍速<select aria-label="播放速度" value={rate} onChange={event=>{const next=Number(event.target.value);setRate(next);playback.current.rate=next;if(player.current)player.current.video.playbackRate=next;}} className="rounded-md border bg-background px-2 py-1.5">
            {[0.5,0.75,1,1.25,1.5,1.75,2].map(value=><option key={value} value={value}>{value}×</option>)}
          </select></label>
          <Button type="button" variant="ghost" size="sm" onClick={retryPlayback}><RefreshCw/>重新加载</Button>
        </div>
        <div ref={container} aria-label={`${recording.title}播放器`} className="aspect-video w-full overflow-hidden rounded-md bg-black"/>
        {mediaError && <p role="alert" className="mt-3 text-sm text-destructive">无法播放：链接可能已过期、网络暂时不可用，或浏览器不支持原片格式。请点击“重新加载”重试。</p>}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">播放归档原片。可拖动进度、倍速、画中画或全屏；聚焦播放器后，空格暂停，方向键快进快退。切换视角保留当前进度和倍速。</p>
      </> : <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-muted-foreground"><Video className="size-9"/><p>{loading?'正在读取课程录像…':'在左侧选择一场录像开始播放。'}</p></div>}
    </section>
  </div>;
}
