import {useState} from 'react';
import {Archive, ArrowUpRight, FolderGit2, Undo2} from 'lucide-react';
import type {Repository, ReviewHost, ReviewTarget, Stash} from '../types';
import {MAX_PACKAGE_BYTES} from '../review-portability';
import {Modal} from './Modal';
import {errorText, stashTitle} from './format';

export function ReviewLibraryControls({host,repository,stash,archived,onMode,onChanged,onError,placement}: {
  host:ReviewHost; repository?:Repository; stash?:Stash; archived:boolean;
  onMode:(archived:boolean)=>void; onChanged:(target?:ReviewTarget)=>Promise<void>; onError:(message:string)=>void;
  placement:'browser'|'actions';
}) {
  const [dialog,setDialog]=useState<'import'|'continue'|'relocate'|null>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [source,setSource]=useState(''), [destination,setDestination]=useState('');
  const [predecessors,setPredecessors]=useState<Stash[]>([]), [previous,setPrevious]=useState('');
  const [path,setPath]=useState('');
  const [captured,setCaptured]=useState<{repository:Repository;stash?:Stash}>();
  const action=async (run:()=>Promise<ReviewTarget|void>) => {
    setBusy(true); setError('');
    try {const target=await run(); await onChanged(target || undefined); setDialog(null);}
    catch (failure) {const message=errorText(failure); setError(message); if (!dialog) onError(message);}
    finally {setBusy(false);}
  };
  const openImport=() => {setSource('');setDestination('');setError('');setDialog('import');};
  const openContinue=async () => {
    if (!repository || !stash || !host.listArchivedReviews) return;
    setCaptured({repository,stash});setDialog('continue');setError('');setPrevious('');setPredecessors([]);setBusy(true);
    try {setPredecessors((await host.listArchivedReviews(repository)).filter(item=>item.hash!==stash.hash));}
    catch (failure) {setError(errorText(failure));} finally {setBusy(false);}
  };
  const exportData=async () => {
    if (!repository || !stash || !host.exportReviewData) return;
    setBusy(true);
    try {
      const source=await host.exportReviewData(repository,stash), url=URL.createObjectURL(new Blob([source],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`stash-review-${stash.hash.slice(0,8)}.json`;link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (failure) {onError(errorText(failure));} finally {setBusy(false);}
  };
  return <>
    {placement==='browser' ? <>
      {host.listArchivedReviews && <div className="sr-library-tabs" role="group" aria-label="Review library">
        <button type="button" aria-pressed={!archived} onClick={()=>onMode(false)}>Active stashes</button>
        <button type="button" aria-pressed={archived} onClick={()=>onMode(true)}>Archived reviews</button>
      </div>}
      <div className="sr-library-tools">{host.importReviewData && <button type="button" className="sr-text-button" onClick={openImport}>Import review data</button>}
        {repository && host.relocateRepository && <button type="button" className="sr-text-button" onClick={()=>{setCaptured({repository});setPath(repository.offline?'':repository.path);setError('');setDialog('relocate');}} title="Choose the new local folder">Relocate</button>}
      </div>
    </> : repository && stash && <>
      {host.archiveReview && (!archived || !repository.offline && stash.inStashList!==false) && <button type="button" disabled={busy} onClick={()=>void action(()=>host.archiveReview!(repository,stash,!archived))}><Archive size={14}/>{archived?'Restore to Active':'Archive review'}</button>}
      {archived && stash.inStashList!==true && stash.recoverable && !repository.offline && <button type="button" disabled={busy} onClick={()=>void action(()=>host.restoreDroppedStash(repository,stash))}><Undo2 size={14}/>Restore stash</button>}
      {host.continueReview && !repository.offline && !archived && <button type="button" disabled={busy} onClick={()=>void openContinue()}><FolderGit2 size={14}/>Continue from previous review</button>}
      {host.exportReviewData && <button type="button" disabled={busy} onClick={()=>void exportData()}><ArrowUpRight size={14}/>Export review data</button>}
    </>}
    {dialog && <Modal title={dialog==='import'?'Import review data':dialog==='continue'?'Continue from previous review':'Relocate repository'} busy={busy} onClose={()=>setDialog(null)}>
      <form onSubmit={event=>{event.preventDefault();void action(async()=>{
        if (dialog==='import') return host.importReviewData!(source,destination || undefined);
        if (dialog==='relocate' && captured) {await host.relocateRepository!(captured.repository.id,path.trim());return;}
        if (dialog==='continue' && captured?.stash) await host.continueReview!(captured.repository,captured.stash,previous);
      });}}>
        {dialog==='import' ? <><p className="sr-modal-description">Import saved code and notes. Your local Git stashes stay as they are.</p>
          <label className="sr-form-field">Review package<input type="file" aria-label="Review data file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>MAX_PACKAGE_BYTES){setSource('');setError('Review packages must be at most 32 MiB.');return;}void file.text().then(setSource).catch(failure=>setError(errorText(failure)));}}/></label>
          <label className="sr-form-field">Destination<select aria-label="Import destination" value={destination} onChange={event=>setDestination(event.target.value)}><option value="">Saved review library</option>{repository && !repository.offline && <option value={repository.id}>{repository.name} (local repository)</option>}</select></label>
        </> : dialog==='continue' ? <><p className="sr-modal-description">Choose the original review explicitly. Notes and viewed flags transfer only where files match exactly in that diff layer. Other notes remain on the original review.</p>
          <label className="sr-form-field">Original review<select aria-label="Original review" value={previous} onChange={event=>setPrevious(event.target.value)} disabled={busy}><option value="">Choose an archived review</option>{predecessors.map(item=><option key={item.hash} value={item.hash}>{stashTitle(item)} · {item.hash.slice(0,8)}</option>)}</select></label>
        </> : <><p className="sr-modal-description">Choose the new folder for {captured?.repository.name}. Existing notes and links keep their repository identity.</p>
          <label className="sr-form-field">New repository path<input aria-label="New repository path" value={path} onChange={event=>setPath(event.target.value)} autoFocus/></label></>}
        {error && <div className="sr-form-error" role="alert">{error}</div>}
        <div className="sr-modal-actions"><button type="button" className="sr-button" onClick={()=>setDialog(null)} disabled={busy}>Cancel</button><button type="submit" className="sr-button sr-button-primary" disabled={busy || (dialog==='import'?!source:dialog==='continue'?!previous:!path.trim())}>{dialog==='import'?'Import review':dialog==='continue'?'Continue review':'Relocate repository'}</button></div>
      </form>
    </Modal>}
  </>;
}
