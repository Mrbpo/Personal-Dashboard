'use client';
import {useEffect,useState} from 'react';
import {Button} from './ui/button';
export function DeploymentSettings(){
  const [state,setState]=useState<any>({}),[tag,setTag]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [update,setUpdate]=useState<any>(null);
  useEffect(()=>{void fetch('/api/deployments').then(r=>r.json()).then(setState).catch(()=>setMessage('状态读取失败'));},[]);
  async function check(){setBusy(true);setUpdate(null);setMessage('');try{
    const response=await fetch('/api/deployments/check',{cache:'no-store'}),result=await response.json();
    if(!response.ok)throw new Error(result.error||'检查失败');setUpdate(result);
    if(result.latest)setTag(result.latest);
  }catch(error){setMessage(error instanceof Error?error.message:'检查失败');}finally{setBusy(false);}}
  return <section className="mt-6 rounded-3xl border bg-card p-6">
    <h2 className="font-semibold">系统更新 · GitHub Release</h2>
    <p className="my-3 text-sm">当前版本：{state.releaseVersion||'读取中'} · 提交：{state.version||'未知'} · {state.deployment?.status||'尚未云端部署'}</p>
    <p className="text-xs text-muted-foreground">仅正式 Release 部署。按版本号比较，不按发布时间判断；检查更新不会自动安装。</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <Button variant="outline" disabled={!state.configured||busy} onClick={check}>检查更新</Button>
      <input aria-label="已发布版本标签" value={tag} onChange={e=>setTag(e.target.value)} placeholder="v1.0.0" className="rounded border bg-background p-2 text-sm"/>
      <Button variant="outline" disabled={!state.configured||busy||!tag} onClick={async()=>{
        if(!confirm('请求部署正式版本 '+tag+'？测试成功后将更新服务器。'))return;
        setBusy(true);try{const r=await fetch('/api/deployments/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag})}),j=await r.json();setMessage(r.ok?'已请求 GitHub 验证并部署，请查看 Actions 和服务器状态。':j.error);}catch{setMessage('请求失败');}finally{setBusy(false);}
      }}>部署／重试指定版本</Button>
    </div>
    {update&&<p role="status" className="mt-3 text-sm">{({
      'update-available':'发现新版 '+update.latest+'，可请求部署',
      'up-to-date':'已是最新版','ahead':'当前版本高于最新正式发布，不建议降级','no-release':'仓库尚无可比较的正式版本'
    } as Record<string,string>)[update.status]} · 检查时间：{update.checkedAt}</p>}
    {message&&<p role="status" className="mt-3 text-sm">{message}</p>}
  </section>;
}
