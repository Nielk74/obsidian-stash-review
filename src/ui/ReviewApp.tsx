import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {AlertCircle, Archive, ArrowDownToLine, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Code2, FileCode2, FolderGit2, FolderTree, GitBranch, GitCommitHorizontal, GitPullRequest, Layers, Link, List, ListFilter, LoaderCircle, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, Plus, RefreshCw, Search, Settings2, ShieldCheck, SplitSquareHorizontal, Trash2, Undo2, WrapText, X} from 'lucide-react';
import type {Annotation, DiffFile, DiffLayer, Repository, ReviewHost, ReviewTarget, ReviewSummary, Stash, StashMetadata} from '../types';
import {emptyMetadata} from '../types';
import {AnnotationThread} from './AnnotationThread';
import {DiffView, type AnnotationSelection} from './DiffView';
import {DeferredBlock} from './DeferredBlock';
import {FileTree} from './FileTree';
import {Modal} from './Modal';
import {errorText, fileId, relativeDate, stashTitle, uniqueId} from './format';
import {createReviewLink, markdownEmbed, markdownLink} from '../markdown';
import {reviewedPaths as layerReviewedPaths, withReviewedPath} from '../review-store';
import {ChangeSearch} from './ChangeSearch';
import {MarkdownText} from './MarkdownText';
import {ReviewLibraryControls} from './ReviewLibraryControls';
import {annotationSearchText, findChanges, indexChanges, type ChangeMatch} from './change-search';

function useDebounced(value:string):string {
  const [settled,setSettled]=useState(value);
  useEffect(()=>{const timer=window.setTimeout(()=>setSettled(value),100);return ()=>window.clearTimeout(timer);},[value]);
  return settled;
}

type Dialog = 'repository' | 'create' | 'apply' | 'drop' | 'details' | null;
interface DroppedStash {repository: Repository; stash: Stash}

export function ReviewApp({host, target, embedded = false}: {host: ReviewHost; target?: ReviewTarget; embedded?: boolean}) {
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '') + '-';
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryKey, setRepositoryKey] = useState('');
  const [repositoriesLoading, setRepositoriesLoading] = useState(true);
  const [resolvedRepositoryTarget, setResolvedRepositoryTarget] = useState('');
  const [resolvedTarget, setResolvedTarget] = useState(target);
  const [repositoryError, setRepositoryError] = useState('');
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [stashError, setStashError] = useState('');
  const [selectedHash, setSelectedHash] = useState(target?.stashHash ?? '');
  const [selectedStashRef, setSelectedStashRef] = useState('');
  const [search, setSearch] = useState('');
  const [archiveMode,setArchiveMode]=useState(false);
  const [archivePage,setArchivePage]=useState(0);
  const [changeQuery,setChangeQuery]=useState('');
  const [changeActive,setChangeActive]=useState(-1);
  const [changeTarget,setChangeTarget]=useState<ChangeMatch|null>(null);
  const [ignoreWhitespace,setIgnoreWhitespace]=useState(false);
  const [annotationQuery,setAnnotationQuery]=useState('');
  const settledChangeQuery=useDebounced(changeQuery), settledAnnotationQuery=useDebounced(annotationQuery);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [metadata, setMetadata] = useState<StashMetadata>(emptyMetadata);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved');
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [canonicalFiles,setCanonicalFiles]=useState<DiffFile[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [loadedDiffKey, setLoadedDiffKey] = useState('');
  const [layer, setLayer] = useState<DiffLayer>(target?.layer ?? 'all');
  const [context, setContext] = useState(host.settings.contextLines);
  const [mode, setMode] = useState<'unified' | 'split'>(host.settings.defaultView);
  const [activeFile, setActiveFile] = useState(target?.file ?? '');
  const [requestedFile, setRequestedFile] = useState(target?.file ?? '');
  const [fileSearch, setFileSearch] = useState('');
  const [fileLayout, setFileLayout] = useState<'tree' | 'list'>('tree');
  const [fileScope, setFileScope] = useState<'all' | 'single'>(target?.file || embedded ? 'single' : 'all');
  const [hideViewed, setHideViewed] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [fullFiles, setFullFiles] = useState<Set<string>>(new Set());
  const [contextLoading, setContextLoading] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [tab, setTab] = useState<'files' | 'annotations'>('files');
  const [annotationFilter, setAnnotationFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [repositoryPath, setRepositoryPath] = useState('');
  const [newStashMessage, setNewStashMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [restoreIndex, setRestoreIndex] = useState(false);
  const [details, setDetails] = useState({title: '', description: '', tags: ''});
  const [notice, setNotice] = useState<{message: string; error?: boolean} | null>(null);
  const [dropped, setDropped] = useState<DroppedStash | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fileNavigatorOpen, setFileNavigatorOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [compact, setCompact] = useState(embedded);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [wrapCode, setWrapCode] = useState(embedded);
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const stashRequest = useRef(0);
  const repositoryRequest = useRef(0);
  const diffRequest = useRef(0);
  const pendingSaves = useRef(new Map<string, Promise<void>>());
  const metadataCache = useRef(new Map<string, StashMetadata>());
  const summaryCache=useRef(new Map<string,ReviewSummary>());
  const saveVersions = useRef(new Map<string, number>());
  const saveFailures = useRef(new Set<string>());
  const appRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stashToggleRef = useRef<HTMLButtonElement>(null);
  const fileToggleRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<Dialog>(null);
  const fileRequests = useRef(new Map<string, Promise<{oldContent: string; newContent: string; truncated?: boolean}>>());
  const [annotationTarget, setAnnotationTarget] = useState<Annotation | null>(null);
  const [dialogTarget, setDialogTarget] = useState<{repository: Repository; stash?: Stash; title: string} | null>(null);
  const metadataRef = useRef(metadata);
  const selectedRef = useRef('');
  const targetResolving = !!target && (resolvedRepositoryTarget !== target.repositoryId || resolvedTarget !== target);
  const repository = targetResolving ? undefined : repositories.find(item => item.path === repositoryKey);
  const stash = repository ? stashes.find(item => item.hash === selectedHash && item.ref === selectedStashRef) ?? stashes.find(item => item.hash === selectedHash) : undefined;
  const reviewKey = repository && stash ? `${repository.id}\0${stash.hash}` : '';
  selectedRef.current = reviewKey;
  dialogRef.current = dialog;
  metadataRef.current = metadata;
  const detailsVisible = !compact || detailsExpanded;

  useEffect(() => {
    const element = appRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCompact(embedded || entry.contentRect.height < 720 || entry.contentRect.width <= 900));
    observer.observe(element);
    return () => observer.disconnect();
  }, [embedded]);

  useEffect(() => {
    setResolvedTarget(target);
    if (!target) return;
    setSelectedHash(target.stashHash); setSelectedStashRef(''); setLayer(target.layer ?? 'all');
    setActiveFile(target.file ?? ''); setRequestedFile(target.file ?? '');
    if (target.file || embedded) setFileScope('single');
    setSearch(''); setPinnedOnly(false); setSidebarOpen(false); setFileNavigatorOpen(false);
  }, [target, embedded]);

  useEffect(() => host.subscribeMetadata?.((repositoryId, hash) => {
    const key = `${repositoryId}\0${hash}`;
    summaryCache.current.delete(key);
    if (pendingSaves.current.has(key) && !host.updateMetadata) return;
    const updated = host.getMetadata(repositoryId, hash);
    metadataCache.current.set(key, updated);
    setMetadataRevision(value => value + 1);
    if (selectedRef.current === key) {metadataRef.current = updated; setMetadata(updated);}
  }), [host]);

  const cachedMetadata = useCallback((repositoryId: string, hash: string) => {
    const key = `${repositoryId}\0${hash}`;
    let value = metadataCache.current.get(key);
    if (!value) {value = host.getMetadata(repositoryId, hash); metadataCache.current.set(key, value);}
    return value;
  }, [host]);
  const cachedSummary=useCallback((id:string,hash:string):ReviewSummary=>{
    const key=`${id}\0${hash}`;let summary=summaryCache.current.get(key);
    if (!summary) {const meta=host.getReviewSummary?.(id,hash) ?? cachedMetadata(id,hash);summary='openAnnotations' in meta ? meta : {...meta,openAnnotations:meta.annotations.filter(note=>!note.resolved).length};summaryCache.current.set(key,summary);}return summary;
  },[host,cachedMetadata]);

  const announce = useCallback((message: string, error = false) => setNotice({message, error}), []);
  const loadRepositories = useCallback(async () => {
    const request = ++repositoryRequest.current;
    setRepositoriesLoading(true); setRepositoryError('');
    if (target) setRepositoryKey('');
    try {
      const result = await host.listRepositories();
      if (request !== repositoryRequest.current) return;
      setRepositories(result);
      setRepositoryKey(previous => target ? result.find(item => item.id === target.repositoryId)?.path ?? '' : result.some(item => item.path === previous) ? previous : result[0]?.path ?? '');
    } catch (error) {if (request === repositoryRequest.current) setRepositoryError(errorText(error));}
    finally {if (request === repositoryRequest.current) {setResolvedRepositoryTarget(target?.repositoryId ?? ''); setRepositoriesLoading(false);}}
  }, [host, target?.repositoryId]);

  useEffect(() => {void loadRepositories(); return () => {repositoryRequest.current++;};}, [loadRepositories]);

  const loadStashes = useCallback(async (showLoading = true) => {
    if (!repository) return;
    const request = ++stashRequest.current;
    if (showLoading) setStashesLoading(true);
    setStashError('');
    try {
      let result = archiveMode && host.listArchivedReviews ? await host.listArchivedReviews(repository) : await host.listStashes(repository);
      if (!archiveMode && host.listArchivedReviews && target?.repositoryId===repository.id && !result.some(item=>item.hash===target.stashHash)) {
        const linked=(await host.listArchivedReviews(repository)).find(item=>item.hash===target.stashHash);
        if (linked) {result=[linked,...result];setArchiveMode(true);}
      }
      if (request !== stashRequest.current) return;
      if (dialogRef.current && !showLoading) return result;
      setStashes(result);
      setSelectedHash(previous => result.some(item => item.hash === previous) ? previous : target?.repositoryId === repository.id ? target.stashHash : result[0]?.hash ?? '');
      return result;
    } catch (error) {if (request === stashRequest.current) setStashError(errorText(error));}
    finally {if (request === stashRequest.current) setStashesLoading(false);}
  }, [host, repository?.id, repository?.path, archiveMode, target?.repositoryId, target?.stashHash]);

  useEffect(() => {
    setStashes([]); setSelectedHash(target?.repositoryId === repository?.id ? target?.stashHash ?? '' : ''); setSelectedStashRef(''); setSearch(''); setPinnedOnly(false); setStashError('');
    void loadStashes();
    return () => {stashRequest.current++;};
  }, [repositoryKey, loadStashes]);

  useEffect(() => {
    if (!repository || host.settings.refreshInterval <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && !busy && !dialogRef.current) void loadStashes(false);
    }, host.settings.refreshInterval * 1000);
    return () => window.clearInterval(timer);
  }, [host, repository?.id, repository?.path, loadStashes, busy]);

  useEffect(() => {
    const value = repository && stash ? cachedMetadata(repository.id, stash.hash) : emptyMetadata();
    setMetadata(value); metadataRef.current = value; setSaveState(pendingSaves.current.has(reviewKey) ? 'saving' : saveFailures.current.has(reviewKey) ? 'failed' : 'saved');
    setSelection(null); setTab('files'); setFullFiles(new Set()); setCollapsedFiles(new Set(layerReviewedPaths(value,layer))); setFileSearch(''); setHideViewed(false); setMoreOpen(false); setAnnotationTarget(null); setChangeQuery(''); setChangeTarget(null); setAnnotationQuery('');
  }, [host, repository?.id, repository?.path, stash?.hash, reviewKey]);

  useEffect(()=>{setCollapsedFiles(new Set(layerReviewedPaths(metadataRef.current,layer)));setChangeTarget(null);setChangeActive(-1);},[layer]);
  useEffect(()=>{setArchivePage(0);},[search,pinnedOnly,archiveMode,repositoryKey]);

  useEffect(() => {
    const request = ++diffRequest.current;
    setSelection(null); setFullFiles(new Set()); setContextLoading(new Set()); fileRequests.current.clear();
    if (!repository || !stash) {setFiles([]);setCanonicalFiles([]); setDiffLoading(false); setDiffError(''); return;}
    setDiffLoading(true); setDiffError('');
    const identity = `${repository.path}\0${stash.hash}\0${layer}\0${context}\0${reload}`;
    host.getDiff(repository, stash, layer, context).then(result => {
      if (request !== diffRequest.current) return;
      setFiles(result);setCanonicalFiles(result); setLoadedDiffKey(identity); setActiveFile(previous => result.some(file => file.path === previous) ? previous : result[0]?.path ?? '');
    }).catch(error => {if (request === diffRequest.current) {setFiles([]);setCanonicalFiles([]); setDiffError(errorText(error));}})
      .finally(() => {if (request === diffRequest.current) setDiffLoading(false);});
    return () => {diffRequest.current++;};
  }, [host, repository?.id, repository?.path, stash?.hash, layer, context, reload]);

  const persist = useCallback((change: (previous: StashMetadata) => StashMetadata, target?: {repository: Repository; stash: Stash}) => {
    const targetRepository = target?.repository ?? repository;
    const targetStash = target?.stash ?? stash;
    if (!targetRepository || !targetStash) return Promise.resolve();
    const key = `${targetRepository.id}\0${targetStash.hash}`;
    const current = selectedRef.current === key ? metadataRef.current : metadataCache.current.get(key) ?? host.getMetadata(targetRepository.id, targetStash.hash);
    let next: StashMetadata;
    let saving: Promise<void>;
    try {
      if (host.updateMetadata) ({metadata: next, saved: saving} = host.updateMetadata(targetRepository.id, targetStash.hash, change));
      else {next = change(current); saving = host.saveMetadata(targetRepository.id, targetStash.hash, next);}
    } catch (error) {next = change(current); saving = Promise.reject(error);}
    metadataCache.current.set(key, next);
    summaryCache.current.delete(key);
    if (selectedRef.current === key) {metadataRef.current = next; setMetadata(next); setSaveState('saving');}
    const version = (saveVersions.current.get(key) ?? 0) + 1;
    saveVersions.current.set(key, version); saveFailures.current.delete(key);
    pendingSaves.current.set(key, saving);
    void saving.then(() => {
      if (saveVersions.current.get(key) !== version) return;
      pendingSaves.current.delete(key);
      if (host.updateMetadata) {
        const latest = host.getMetadata(targetRepository.id, targetStash.hash);
        metadataCache.current.set(key, latest);
        if (selectedRef.current === key) {metadataRef.current = latest; setMetadata(latest);}
      }
      if (selectedRef.current === key) setSaveState('saved');
    }).catch(error => {
      if (saveVersions.current.get(key) === version) {
        pendingSaves.current.delete(key); saveFailures.current.add(key);
        if (selectedRef.current === key) setSaveState('failed');
      }
      announce(`Could not save review: ${errorText(error)}`, true);
    });
    return saving;
  }, [host, repository?.id, repository?.path, stash?.hash, announce]);

  const visibleStashes = useMemo(() => stashes.filter(item => {
    const meta = item.hash === selectedHash ? metadata : cachedSummary(repository?.id ?? '', item.hash);
    const text = [meta.title, stashTitle(item), item.branch, item.ref, item.hash, meta.description, ...meta.tags].join(' ').toLowerCase();
    return (!pinnedOnly || meta.pinned) && text.includes(search.toLowerCase().trim());
  }), [stashes, selectedHash, metadata, cachedSummary, metadataRevision, repositoryKey, pinnedOnly, search]);
  const pageStashes=archiveMode ? visibleStashes.slice(archivePage*50,(archivePage+1)*50) : visibleStashes;
  const viewedFiles=useMemo(()=>layerReviewedPaths(metadata,layer),[metadata,layer]);
  const reviewedPaths = useMemo(() => new Set(viewedFiles), [viewedFiles]);
  const searchEnabled=!!settledChangeQuery;
  const changeIndex=useMemo(()=>searchEnabled?indexChanges(canonicalFiles):{rows:[]},[canonicalFiles,searchEnabled]);
  const changeMatches=useMemo(()=>findChanges(changeIndex,settledChangeQuery),[changeIndex,settledChangeQuery]);
  const visibleChangeMatches=useMemo(()=>{
    const result=new Map<string,ChangeMatch[]>(), marked=changeMatches.slice(0,200);
    if (changeTarget && !marked.some(match=>match===changeTarget)) marked.push(changeTarget);
    for (const match of marked) {const group=result.get(match.path) ?? [];group.push(match);result.set(match.path,group);}return result;
  },[changeMatches,changeTarget]);
  const annotationIndex=useMemo(()=>new Map(metadata.annotations.map(annotation=>[annotation.id,annotationSearchText(annotation)])),[metadata.annotations]);
  useEffect(()=>{setChangeActive(-1);setChangeTarget(null);},[settledChangeQuery]);
  const navigateChange=(step:number)=>{
    if (!changeMatches.length || selection) return;
    const index=(changeActive+step+changeMatches.length)%changeMatches.length, match=changeMatches[index];
    setChangeActive(index);setChangeTarget(match);setFileSearch('');setHideViewed(false);setIgnoreWhitespace(false);setActiveFile(match.path);setRequestedFile('');setTab('files');
    setCollapsedFiles(previous=>{const next=new Set(previous);next.delete(match.path);return next;});
  };
  useEffect(()=>{
    if (!changeTarget || diffLoading) return;
    const frame=window.requestAnimationFrame(()=>{
      const article=appRef.current?.querySelector(`#${fileId(changeTarget.path,idPrefix)}`);
      article?.querySelector(`[data-side="${changeTarget.side}"][data-line-number="${changeTarget.line}"]`)?.scrollIntoView({block:'center'});
    });return ()=>window.cancelAnimationFrame(frame);
  },[changeTarget,files,diffLoading,idPrefix]);
  const navigableFiles = useMemo(() => hideViewed ? files.filter(file => !reviewedPaths.has(file.path)) : files, [files, hideViewed, reviewedPaths]);
  const filteredFiles = useMemo(() => {
    const query = fileSearch.toLowerCase().trim();
    return navigableFiles.filter(file => file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query));
  }, [navigableFiles, fileSearch]);
  const focusedFile = requestedFile ? filteredFiles.find(file => file.path === requestedFile) : filteredFiles.find(file => file.path === activeFile) ?? filteredFiles[0];
  const displayedFiles = useMemo(() => fileScope === 'single' ? focusedFile ? [focusedFile] : [] : filteredFiles, [fileScope, focusedFile, filteredFiles]);
  const focusedFileIndex = focusedFile ? filteredFiles.indexOf(focusedFile) : -1;
  const allCollapsed = displayedFiles.length > 0 && displayedFiles.every(file => collapsedFiles.has(file.path));
  const totals = files.reduce((result, file) => ({additions: result.additions + file.additions, deletions: result.deletions + file.deletions}), {additions: 0, deletions: 0});
  const reviewedCount = files.filter(file => reviewedPaths.has(file.path)).length;
  const openAnnotations = metadata.annotations.filter(annotation => !annotation.resolved).length;
  const visibleAnnotations = metadata.annotations.filter(annotation => (annotationFilter === 'all' || (annotationFilter === 'resolved' ? annotation.resolved : !annotation.resolved)) && annotationIndex.get(annotation.id)?.includes(settledAnnotationQuery.toLowerCase()));
  const title = stash ? metadata.title || stashTitle(stash) : '';
  const diffIdentity = `${repository?.path}\0${stash?.hash}\0${layer}\0${context}\0${reload}`;

  const chooseStash = useCallback((hash: string, ref?: string) => {if (dialogRef.current) return; setSelectedHash(hash); setSelectedStashRef(ref ?? ''); setRequestedFile(''); setSidebarOpen(false); setSelection(null);}, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!appRef.current?.contains(target) || dialog) return;
      if (event.key === 'Escape') {
        if (sidebarOpen) {setSidebarOpen(false); stashToggleRef.current?.focus();}
        else if (fileNavigatorOpen) {setFileNavigatorOpen(false); fileToggleRef.current?.focus();}
        else if (moreOpen) setMoreOpen(false);
        else return;
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"]') || !window.getSelection()?.isCollapsed) return;
      if (event.key === '/') {event.preventDefault(); setSidebarCollapsed(false); setSidebarOpen(true); window.setTimeout(() => searchRef.current?.focus(), 0); return;}
      if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key) || !visibleStashes.length) return;
      if (target?.closest('.sr-file-tree, .sr-diff-scroll, .sr-annotations-panel') || embedded) return;
      event.preventDefault();
      const current = visibleStashes.findIndex(item => item.hash === selectedHash && item.ref === stash?.ref);
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(visibleStashes.length - 1, current + step));
      chooseStash(visibleStashes[next].hash, visibleStashes[next].ref);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, visibleStashes, selectedHash, stash?.ref, chooseStash, sidebarOpen, fileNavigatorOpen, moreOpen, embedded]);

  const refreshRepositoryStatus = async () => {
    try {setRepositories(await host.listRepositories());} catch (error) {announce(`Could not refresh repository status: ${errorText(error)}`, true);}
  };
  const refresh = async () => {host.invalidateReads?.();await loadStashes(); await refreshRepositoryStatus(); setReload(value => value + 1);};
  const libraryChanged=async (destination?:ReviewTarget)=>{
    host.invalidateReads?.();setMoreOpen(false);setArchivePage(0);setMetadataRevision(value=>value+1);metadataCache.current.clear();summaryCache.current.clear();
    await refreshRepositoryStatus();
    if (destination) {setArchiveMode(true);setSelectedHash(destination.stashHash);setSelectedStashRef('');await host.openReview?.(destination);}
    else {await loadStashes();if(repository && stash)setMetadata(host.getMetadata(repository.id,stash.hash));}
    setReload(value=>value+1);
  };
  const openDialog = (next: Dialog) => {dialogRef.current = next; setDialogTarget(repository ? {repository, stash, title} : null); setDialogError(''); setDialog(next); setMoreOpen(false);};
  const closeDialog = useCallback(() => {dialogRef.current = null; setDialog(null); setDialogTarget(null); setDialogError('');}, []);
  const editDetails = () => {setDetails({title: metadata.title || title, description: metadata.description, tags: metadata.tags.join(', ')}); openDialog('details');};
  const runAction = async (action: () => Promise<void>) => {
    setBusy(true); setDialogError('');
    try {await action(); closeDialog();} catch (error) {setDialogError(errorText(error));}
    finally {setBusy(false);}
  };
  const jumpToFile = useCallback((path: string) => {
    setActiveFile(path); setRequestedFile(''); setTab('files'); setSelection(null); setFileNavigatorOpen(false);
    setCollapsedFiles(previous => {const next = new Set(previous); next.delete(path); return next;});
    window.setTimeout(() => appRef.current?.querySelector<HTMLElement>(`#${fileId(path, idPrefix)}`)?.scrollIntoView({behavior: 'smooth', block: 'start'}), 0);
  }, [idPrefix]);
  const toggleFileCollapsed = (path: string) => {
    setCollapsedFiles(previous => {const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next;});
  };
  const toggleAllCollapsed = () => {
    setCollapsedFiles(previous => {const next = new Set(previous); for (const file of displayedFiles) {if (allCollapsed) next.delete(file.path); else next.add(file.path);} return next;});
  };
  const getSource = useCallback((file: DiffFile) => {
    if (!repository || !stash) return Promise.reject(new Error('No stash selected.'));
    const key = `${diffRequest.current}\0${file.path}`;
    const existing = fileRequests.current.get(key);
    if (existing) return existing;
    const request = host.getFileContents(repository, stash, file, layer);
    fileRequests.current.set(key, request);
    void request.catch(() => fileRequests.current.delete(key));
    return request;
  }, [host, repository?.id, repository?.path, stash?.hash, layer]);

  // Read the selected file once, without expanding the diff, so multi-line syntax
  // tokens retain their original source context rather than restarting in each hunk.
  useEffect(() => {
    if (loadedDiffKey !== diffIdentity || diffLoading) return;
    const file = files.find(item => item.path === focusedFile?.path);
    if (!file || file.binary || file.oldContent !== undefined && file.newContent !== undefined) return;
    const request = diffRequest.current;
    let cancelled = false;
    void getSource(file).then(contents => {
      if (!cancelled && request === diffRequest.current) setFiles(previous => previous.map(item => item.path === file.path ? {...item, ...contents} : item));
    }).catch(() => { /* The hunk-based highlighter remains available; context has an explicit retry action. */ });
    return () => {cancelled = true;};
  }, [focusedFile?.path, loadedDiffKey, diffIdentity, diffLoading, getSource]);

  const loadFullContext = async (file: DiffFile) => {
    if (!repository || !stash) return;
    setIgnoreWhitespace(false);
    setCollapsedFiles(previous => {const next = new Set(previous); next.delete(file.path); return next;});
    if (fullFiles.has(file.path)) {setFullFiles(previous => {const next = new Set(previous); next.delete(file.path); return next;}); return;}
    if (file.oldContent !== undefined && file.newContent !== undefined) {setFullFiles(previous => new Set(previous).add(file.path)); return;}
    const request = diffRequest.current;
    setContextLoading(previous => new Set(previous).add(file.path));
    try {
      const contents = await getSource(file);
      if (request !== diffRequest.current) return;
      setFiles(previous => previous.map(item => item.path === file.path ? {...item, ...contents} : item));
      if (!contents.truncated) setFullFiles(previous => new Set(previous).add(file.path));
      else announce('This file exceeds the full-context size limit. Review the available diff.');
    } catch (error) {announce(`Could not load file context: ${errorText(error)}`, true);}
    finally {if (request === diffRequest.current) setContextLoading(previous => {const next = new Set(previous); next.delete(file.path); return next;});}
  };
  useEffect(() => {
    if (!annotationTarget || annotationTarget.layer !== layer || loadedDiffKey !== diffIdentity || diffLoading || !repository || !stash) return;
    const file = files.find(item => item.path === annotationTarget.path);
    if (!file) {
      if (!diffError) {announce('The annotated file is unavailable in this diff layer. Its note is preserved.'); setAnnotationTarget(null);}
      return;
    }
    const anchor = annotationTarget;
    const request = diffRequest.current;
    let cancelled = false;
    const reveal = async () => {
      const visible = file.hunks.some(hunk => hunk.lines.some(line => (anchor.side === 'old' ? line.oldLine : line.newLine) === anchor.endLine));
      if (!visible && !fullFiles.has(file.path)) {
        setContextLoading(previous => new Set(previous).add(file.path));
        try {
          const contents = file.oldContent !== undefined && file.newContent !== undefined
            ? {oldContent: file.oldContent, newContent: file.newContent, truncated: file.truncated}
            : await getSource(file);
          if (cancelled || request !== diffRequest.current) return;
          if (contents.truncated) {announce('The annotation is outside the available context for this large file. Its note remains in Annotations.'); setAnnotationTarget(null); return;}
          setFiles(previous => previous.map(item => item.path === file.path ? {...item, ...contents} : item));
          setFullFiles(previous => new Set(previous).add(file.path));
          return;
        } catch (error) {if (!cancelled) {announce(`Could not reveal annotation: ${errorText(error)}`, true); setAnnotationTarget(null);}}
        finally {if (!cancelled && request === diffRequest.current) setContextLoading(previous => {const next = new Set(previous); next.delete(file.path); return next;});}
      } else {
        window.requestAnimationFrame(() => {
          if (cancelled) return;
          const thread = Array.from(appRef.current?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? []).find(element => element.dataset.annotationId === anchor.id);
          (thread ?? appRef.current?.querySelector<HTMLElement>(`#${fileId(file.path, idPrefix)}`))?.scrollIntoView({behavior: 'smooth', block: 'center'});
          thread?.classList.add('sr-thread-highlight');
          window.setTimeout(() => thread?.classList.remove('sr-thread-highlight'), 1600);
          setAnnotationTarget(null);
        });
      }
    };
    void reveal();
    return () => {cancelled = true;};
  }, [annotationTarget, layer, diffLoading, loadedDiffKey, diffIdentity, files, fullFiles, host, repository?.id, repository?.path, stash?.hash, diffError, announce, getSource]);

  const selectLine = (file: DiffFile, side: 'old' | 'new', line: number, extend: boolean) => {
    setSelection(previous => extend && previous?.path === file.path && previous.side === side && previous.layer === layer
      ? {...previous, startLine: Math.min(previous.startLine, line), endLine: Math.max(previous.endLine, line)}
      : {path: file.path, side, startLine: line, endLine: line, layer});
  };
  const saveAnnotation = (body: string) => {
    if (!selection) return;
    const now = new Date().toISOString();
    const file=files.find(file=>file.path===selection.path), source=selection.side==='old'?file?.oldContent:file?.newContent;
    const excerpt=source!==undefined && !file?.truncated ? {text:source.split('\n').slice(selection.startLine-1,selection.endLine).join('\n'),startLine:selection.startLine} : undefined;
    const annotation: Annotation = {...selection, id: uniqueId(), body, createdAt: now, updatedAt: now, resolved: false, replies: [],excerpt};
    void persist(previous => ({...previous, annotations: [...previous.annotations, annotation]}));
    setSelection(null);
  };
  const updateAnnotation = (annotation: Annotation) => {void persist(previous => ({...previous, annotations: previous.annotations.map(item => item.id === annotation.id ? annotation : item)}));};
  const deleteAnnotation = (id: string) => {void persist(previous => ({...previous, annotations: previous.annotations.filter(item => item.id !== id)}));};
  const exportReview = async () => {
    if (!repository || !stash) return;
    setMoreOpen(false);
    const snapshot = structuredClone(metadataRef.current);
    const pending = pendingSaves.current.get(reviewKey);
    try {await pending; const path = await host.exportReview(repository, stash, snapshot); announce(`Review exported to ${path}`); host.notify(`Review exported to ${path}`);}
    catch (error) {announce(`Could not export review: ${errorText(error)}`, true);}
  };
  const currentTarget = (): ReviewTarget | undefined => repository && stash ? {repositoryId: repository.id, stashHash: stash.hash, layer, ...(fileScope === 'single' && focusedFile ? {file: focusedFile.path} : {})} : undefined;
  const copyMarkdown = async (embed: boolean) => {
    const destination = currentTarget();
    if (!destination) return;
    setMoreOpen(false);
    try {
      const link = createReviewLink(host.vaultName ?? '', destination);
      await navigator.clipboard.writeText(embed ? markdownEmbed(link) : markdownLink(title, link));
      announce(embed ? 'Markdown embed copied. Paste it into an Obsidian note.' : 'Markdown link copied. Paste it into an Obsidian note.');
    } catch (error) {announce(`Could not copy Markdown: ${errorText(error)}`, true);}
  };
  const copySource = async (file: DiffFile) => {
    try {
      const contents = await getSource(file);
      if (contents.truncated) throw new Error('This file exceeds the full-source size limit. Select the visible code to copy it.');
      await navigator.clipboard.writeText(file.status === 'deleted' ? contents.oldContent : contents.newContent);
      announce(`Copied ${file.status === 'deleted' ? 'original' : 'stashed'} code from ${file.path}.`);
    } catch (error) {announce(`Could not copy code: ${errorText(error)}`, true);}
  };
  const undoDrop = async () => {
    if (!dropped) return;
    setBusy(true);
    try {await host.restoreDroppedStash(dropped.repository, dropped.stash); setDropped(null); if (repositoryKey === dropped.repository.path) {await loadStashes(); setSelectedHash(dropped.stash.hash);} announce('Stash restored.');}
    catch (error) {announce(`Could not restore stash: ${errorText(error)}`, true);}
    finally {setBusy(false);}
  };

  const modalRepository = dialogTarget?.repository ?? repository;
  const modalStash = dialogTarget?.stash ?? stash;
  const modalTitle = dialogTarget?.title ?? title;
  const linkedRepositoryMissing = !!target && !repositoriesLoading && !repositories.some(item => item.id === target.repositoryId);
  const linkedStashMissing = !!target && !stashesLoading && !!repository && selectedHash === target.stashHash && !stash && !stashError;

  const diffViews = useMemo(() => stash ? displayedFiles.map(file => <DeferredBlock key={`${stash.hash}-${layer}-${file.path}`} height={collapsedFiles.has(file.path) ? 80 : Math.max(170, (file.additions + file.deletions + file.hunks.length * 8) * 22 + 80)} force={displayedFiles.length <= 50 || file.path === focusedFile?.path || annotationTarget?.path === file.path || selection?.path === file.path || changeTarget?.path === file.path} render={() => <DiffView key={file.path} file={file} defer={displayedFiles.length > 50 && file.path !== focusedFile?.path && file.path !== changeTarget?.path} idPrefix={idPrefix} mode={mode} layer={layer} fullContext={fullFiles.has(file.path)} contextLoading={contextLoading.has(file.path)} reviewed={reviewedPaths.has(file.path)} collapsed={collapsedFiles.has(file.path)} onToggleCollapsed={() => toggleFileCollapsed(file.path)} annotations={metadata.annotations} selection={selection} revealAnnotation={annotationTarget} revealSearch={changeTarget} searchMatches={visibleChangeMatches.get(file.path)} ignoreWhitespace={ignoreWhitespace} markdownRenderer={host.renderMarkdown} markdownSourcePath={host.markdownSourcePath} onToggleFull={() => void loadFullContext(file)} onCopySource={() => void copySource(file)} onReviewed={() => {const reviewed = reviewedPaths.has(file.path); setCollapsedFiles(previous => {const next = new Set(previous); if (reviewed) next.delete(file.path); else next.add(file.path); return next;}); void persist(previous => withReviewedPath(previous,layer,file.path,!layerReviewedPaths(previous,layer).includes(file.path)));}} onSelectLine={(side, line, extend) => selectLine(file, side, line, extend)} onSaveAnnotation={saveAnnotation} onCancelAnnotation={() => setSelection(null)} onUpdateAnnotation={updateAnnotation} onDeleteAnnotation={deleteAnnotation}/>}/>) : [], [displayedFiles, focusedFile?.path, stash?.hash, idPrefix, mode, layer, fullFiles, contextLoading, reviewedPaths, collapsedFiles, metadata.annotations, viewedFiles, selection, annotationTarget, changeTarget, visibleChangeMatches, ignoreWhitespace, host.renderMarkdown, host.markdownSourcePath, getSource, persist, announce]);

  const stashCards = useMemo(() => pageStashes.map(item => {
          const meta = item.hash === selectedHash ? {...metadata,openAnnotations} : cachedSummary(repository?.id ?? '', item.hash);
          const count = meta.openAnnotations;
          return <DeferredBlock key={`${item.hash}-${item.ref}`} height={84} force={pageStashes.length <= 100 || item.hash === selectedHash && stash?.ref === item.ref} render={() => <button className={`sr-stash-card ${item.hash === selectedHash && stash?.ref === item.ref ? 'sr-selected' : ''}`} type="button" key={`${item.hash}-${item.ref}`} onClick={() => chooseStash(item.hash, item.ref)} disabled={!!dialog} aria-current={item.hash === selectedHash && stash?.ref === item.ref ? 'true' : undefined} aria-label={`Open stash ${meta.title || stashTitle(item)}`}>
            <div className="sr-stash-card-top"><code>{item.ref}</code><time title={new Date(item.createdAt).toLocaleString()}>{relativeDate(item.createdAt)}</time>{meta.pinned && <Pin size={12} className="sr-pinned-icon"/>}</div>
            <strong>{meta.title || stashTitle(item)}</strong><div className="sr-stash-card-bottom"><span><GitBranch size={12}/>{item.branch || 'Unknown branch'}</span>{count > 0 && <span title={`${count} open annotations`}><MessageSquare size={12}/>{count}</span>}</div>
            {meta.tags.length > 0 && <div className="sr-stash-tags">{meta.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{meta.tags.length > 3 && <span>+{meta.tags.length - 3}</span>}</div>}
          </button>}/>;
        }), [pageStashes, selectedHash, metadata, cachedMetadata, repository?.id, stash?.ref, dialog, chooseStash]);

  return <div ref={appRef} className={`sr-app ${sidebarOpen ? 'sr-sidebar-open' : ''} ${sidebarCollapsed ? 'sr-sidebar-collapsed' : ''} ${compact ? 'sr-compact' : ''} ${!detailsVisible ? 'sr-details-hidden' : ''} ${wrapCode ? 'sr-wrap-code' : ''} ${embedded ? 'sr-embedded' : ''}`}>
    {sidebarOpen && <button className="sr-drawer-scrim" type="button" aria-label="Dismiss stash sidebar" onClick={() => {setSidebarOpen(false); stashToggleRef.current?.focus();}}/>}
    <aside className="sr-sidebar" aria-label="Stash workspace">
      <div className="sr-brand"><GitPullRequest size={18}/><strong>Stash Review</strong><button className="sr-icon-button sr-mobile-close" aria-label="Close stash sidebar" type="button" onClick={() => setSidebarOpen(false)}><X size={16}/></button></div>
      <div className="sr-repository-picker"><FolderGit2 size={16}/><select aria-label="Repository" value={repositoryKey} onChange={event => setRepositoryKey(event.target.value)} disabled={repositoriesLoading || busy || !!dialog}><option value="" disabled>{repositoriesLoading ? 'Loading repositories…' : 'Choose a repository'}</option>{repositories.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select><ChevronDown size={14}/><button type="button" className="sr-icon-button" aria-label="Add repository" title="Add repository" onClick={() => openDialog('repository')}><Plus size={16}/></button></div>
      {repository && <div className="sr-repository-branch" title={repository.path}><GitBranch size={12}/><span>{repository.branch || 'Detached HEAD'}</span><span className={`sr-worktree-dot ${repository.dirty ? 'sr-dirty' : ''}`}/><span>{repository.dirty ? 'Working changes' : 'Clean'}</span></div>}
      <ReviewLibraryControls host={host} repository={repository} archived={archiveMode} onMode={setArchiveMode} onChanged={libraryChanged} onError={message=>announce(message,true)} placement="browser"/><div className="sr-stash-toolbar"><h2>Stashes <span>{stashes.length}</span></h2><div><button type="button" className={`sr-icon-button ${pinnedOnly ? 'sr-active' : ''}`} aria-label="Show pinned stashes" aria-pressed={pinnedOnly} title="Show pinned stashes" onClick={() => setPinnedOnly(!pinnedOnly)}><Pin size={15}/></button><button type="button" className="sr-icon-button" aria-label="Refresh stashes" title="Refresh stashes" onClick={() => void refresh()} disabled={!repository || stashesLoading}><RefreshCw size={15} className={stashesLoading ? 'sr-spin' : ''}/></button></div></div>
      <div className="sr-search"><Search size={15}/><input ref={searchRef} type="search" aria-label="Search stashes" placeholder="Search stashes…" value={search} onChange={event => setSearch(event.target.value)}/><kbd>/</kbd></div>
      <div className="sr-stash-list" aria-label="Stashes">
        {repositoryError ? <div className="sr-sidebar-message sr-error"><AlertCircle size={20}/><strong>Cannot load repositories</strong><p>{repositoryError}</p><button className="sr-button sr-button-small" onClick={() => void loadRepositories()} type="button">Retry repositories</button></div> : stashError ? <div className="sr-sidebar-message sr-error"><AlertCircle size={20}/><strong>Cannot read stashes</strong><p>{stashError}</p><button className="sr-button sr-button-small" onClick={() => void loadStashes()} type="button">Retry stashes</button></div> : repositoriesLoading || (stashesLoading && !stashes.length) ? <div className="sr-sidebar-message"><LoaderCircle size={20} className="sr-spin"/><p>Finding your unfinished work…</p></div> : !visibleStashes.length ? <div className="sr-sidebar-message"><Archive size={26}/><strong>{!repository ? 'Connect a repository' : search || pinnedOnly ? 'No matching stashes' : 'A clean slate'}</strong><p>{!repository ? 'Choose a local Git repository to begin.' : search || pinnedOnly ? 'Try a different search or clear the pinned filter.' : 'Stash your working changes to give them a place to land.'}</p>{(search || pinnedOnly) && <button className="sr-text-button" type="button" onClick={() => {setSearch(''); setPinnedOnly(false);}}>Clear filters</button>}</div> : stashCards}
      </div>
      {archiveMode && visibleStashes.length>50 && <div className="sr-archive-pages"><button type="button" aria-label="Previous archive page" disabled={!archivePage} onClick={()=>setArchivePage(page=>page-1)}>Previous</button><span>{archivePage+1}/{Math.ceil(visibleStashes.length/50)}</span><button type="button" aria-label="Next archive page" disabled={(archivePage+1)*50>=visibleStashes.length} onClick={()=>setArchivePage(page=>page+1)}>Next</button></div>}<div className="sr-sidebar-footer"><button type="button" className="sr-button sr-create-button" onClick={() => {setNewStashMessage(''); openDialog('create');}} disabled={!repository || repository.offline || busy}><Plus size={16}/>Create stash</button><div><span><kbd>j</kbd><kbd>k</kbd> to browse</span><button className="sr-icon-button" type="button" aria-label="Open Stash Review settings" title="Settings" onClick={() => host.openSettings()}><Settings2 size={15}/></button></div></div>
    </aside>
    <main className="sr-main">
      <div className="sr-topbar"><div><button className="sr-icon-button sr-sidebar-toggle" type="button" aria-label={sidebarCollapsed ? 'Expand stash sidebar' : 'Collapse stash sidebar'} title={sidebarCollapsed ? 'Expand stash sidebar' : 'Collapse stash sidebar'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</button><button ref={stashToggleRef} className="sr-icon-button sr-mobile-menu" type="button" aria-label="Toggle stash sidebar" aria-expanded={sidebarOpen} onClick={() => {setSidebarOpen(!sidebarOpen); setFileNavigatorOpen(false);}}><Menu size={17}/></button><FolderGit2 size={15}/><span className="sr-topbar-project">{repository?.name || 'Workspace'}</span><span className="sr-breadcrumb-separator">/</span><span>Stashes</span>{stash && <><span className="sr-breadcrumb-separator">/</span><code>{stash.ref}</code></>}</div><span className="sr-local-badge"><span/>Local review</span>{embedded && host.openReview && <button className="sr-text-button" type="button" onClick={() => {const destination = currentTarget(); if (destination) void host.openReview!(destination).catch(error => announce(errorText(error), true));}}><ArrowUpRight size={14}/>Open full review</button>}</div>
      {notice && <div className={`sr-notice ${notice.error ? 'sr-notice-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertCircle size={15}/> : <CheckCircle2 size={15}/>}<span>{notice.message}</span><button className="sr-icon-button" aria-label="Dismiss notification" type="button" onClick={() => setNotice(null)}><X size={14}/></button></div>}
      {dropped && <div className="sr-undo-notice" role="status"><ShieldCheck size={16}/><span>“{stashTitle(dropped.stash)}” was removed from the stash list. Its backup is preserved.</span><button type="button" className="sr-text-button" onClick={() => void undoDrop()} disabled={busy}><Undo2 size={14}/>Undo drop</button><button className="sr-icon-button" type="button" aria-label="Dismiss undo notification" onClick={() => setDropped(null)}><X size={14}/></button></div>}
      {!stash ? <div className="sr-workspace-empty">{repositoriesLoading || stashesLoading || targetResolving ? <><LoaderCircle size={28} className="sr-spin"/><h1>Loading stash review…</h1></> : <><Archive size={36}/><h1>{linkedRepositoryMissing ? 'Linked repository unavailable' : linkedStashMissing ? 'Linked stash unavailable' : repository ? 'No stash selected' : 'Connect a Git repository'}</h1><p>{linkedRepositoryMissing ? 'Configure the original repository in Stash Review settings, then retry.' : linkedStashMissing ? 'The linked stash was removed or is unavailable in this repository. Its saved review notes are preserved.' : 'Review stashed changes, browse files, and leave notes on the code.'}</p>{linkedRepositoryMissing || linkedStashMissing ? <button className="sr-button" type="button" onClick={() => void (linkedRepositoryMissing ? loadRepositories() : refresh())}>Retry linked review</button> : <button className="sr-button sr-button-primary" type="button" onClick={() => openDialog(repository ? 'create' : 'repository')}><Plus size={16}/>{repository ? 'Create your first stash' : 'Connect a repository'}</button>}</>}</div> : <>
        <header className="sr-review-header"><div className="sr-review-kicker"><span className="sr-stash-pill"><Archive size={12}/>{repository?.offline ? 'Saved review · repository offline' : stash.archived ? 'Archived review' : 'Saved stash'}</span><span>Created {relativeDate(stash.createdAt)}</span><span className={`sr-save-status sr-save-${saveState}`}>{saveState === 'saving' ? <LoaderCircle size={12} className="sr-spin"/> : saveState === 'failed' ? <AlertCircle size={12}/> : <Check size={12}/>} {saveState === 'saving' ? 'Saving review…' : saveState === 'failed' ? 'Review not saved' : 'Review saved'}</span>{saveState === 'failed' && <button className="sr-text-button" type="button" onClick={() => void persist(previous => previous)}>Retry save</button>}</div>
          <div className="sr-review-title-row"><h1 title={title}>{title}<span className="sr-title-ref" aria-hidden="true">{stash.ref}</span></h1><div className="sr-review-actions"><button className={`sr-icon-button sr-pin-button ${metadata.pinned ? 'sr-active' : ''}`} type="button" aria-label={metadata.pinned ? 'Unpin stash' : 'Pin stash'} title={metadata.pinned ? 'Unpin stash' : 'Pin stash'} onClick={() => void persist(previous => ({...previous, pinned: !previous.pinned}))}><Pin size={16}/></button><button className="sr-button sr-button-primary" type="button" onClick={() => {setRestoreIndex(false); openDialog('apply');}} disabled={busy || repository?.offline || stash.archived && !stash.recoverable}><ArrowDownToLine size={15}/>Apply stash</button><div className="sr-more-wrap"><button className="sr-icon-button" type="button" aria-label="More stash actions" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><MoreHorizontal size={18}/></button>{moreOpen && <div className="sr-menu sr-stash-menu"><button type="button" onClick={editDetails}><Settings2 size={14}/>Edit stash details</button><button type="button" onClick={() => void copyMarkdown(false)}><Link size={14}/>Copy Markdown link</button><button type="button" onClick={() => void copyMarkdown(true)}><Code2 size={14}/>Copy Markdown embed</button><button type="button" onClick={() => void exportReview()}><ArrowUpRight size={14}/>Export review</button><ReviewLibraryControls host={host} repository={repository} stash={stash} archived={!!stash.archived} onMode={setArchiveMode} onChanged={libraryChanged} onError={message=>announce(message,true)} placement="actions"/><button type="button" className="sr-danger-text" disabled={repository?.offline || stash.archived} onClick={() => openDialog('drop')}><Trash2 size={14}/>Drop stash</button></div>}</div></div></div>
          {metadata.continuedFrom && <div className="sr-continuation"><span>Continued from {metadata.continuedFrom.slice(0,8)} · unmatched notes stay on the original review.</span><button type="button" className="sr-text-button" onClick={()=>void host.openReview?.({repositoryId:repository!.id,stashHash:metadata.continuedFrom!})}>Open original review</button></div>}<div className="sr-review-meta"><span><GitBranch size={13}/>{stash.branch || 'Unknown branch'}</span><span><GitCommitHorizontal size={15}/><code title={stash.hash}>{stash.hash.slice(0, 8)}</code></span><span title={`Base commit ${stash.baseHash}`}>on <code>{stash.baseHash.slice(0, 8)}</code></span><button className="sr-text-button" type="button" onClick={editDetails}>Edit details</button>{metadata.tags.map(tag => <span className="sr-tag" key={tag}>{tag}</span>)}</div>
          {detailsVisible && metadata.description && <MarkdownText className="sr-review-description" source={metadata.description} renderer={host.renderMarkdown} sourcePath={host.markdownSourcePath}/>}
          <div className="sr-review-summary">{compact && <button className="sr-text-button sr-details-toggle" type="button" aria-expanded={detailsVisible} onClick={() => setDetailsExpanded(!detailsExpanded)}>{detailsVisible ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} {detailsVisible ? 'Hide stash details' : 'Show stash details'}</button>}<div className="sr-summary-changes"><strong>{files.length}</strong> changed file{files.length === 1 ? '' : 's'}<span className="sr-additions">+{totals.additions}</span><span className="sr-deletions">−{totals.deletions}</span><span className="sr-change-bar" aria-hidden="true">{Array.from({length: 10}, (_, index) => <i key={index} className={index < Math.round(totals.additions / Math.max(1, totals.additions + totals.deletions) * 10) ? 'sr-change-add' : 'sr-change-delete'}/>)}</span></div><div className="sr-review-progress"><div><i style={{width: `${files.length ? reviewedCount / files.length * 100 : 0}%`}}/></div><span>{reviewedCount}/{files.length} viewed</span>{files.length > 0 && reviewedCount === files.length && <CheckCircle2 size={14}/>}</div></div>
        </header>
        <div className="sr-review-tabs"><div role="tablist" aria-label="Review sections"><button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'sr-active-tab' : ''} onClick={() => setTab('files')}><FileCode2 size={15}/>Files changed<span>{files.length}</span></button><button type="button" role="tab" aria-selected={tab === 'annotations'} className={tab === 'annotations' ? 'sr-active-tab' : ''} onClick={() => setTab('annotations')}><MessageSquare size={15}/>Annotations<span>{metadata.annotations.length}</span>{openAnnotations > 0 && <i className="sr-open-dot"/>}</button></div><span className="sr-review-tip">{reviewedCount} of {files.length} files viewed</span></div>
        {tab === 'annotations' ? <section className="sr-annotations-panel" aria-label="Stash annotations"><div className="sr-annotations-heading"><div><h2>Annotations</h2><p>{openAnnotations} open · {metadata.annotations.filter(annotation => annotation.resolved).length} resolved</p></div><input type="search" aria-label="Search annotations" placeholder="Search notes and replies…" value={annotationQuery} onChange={event=>setAnnotationQuery(event.target.value)}/><select aria-label="Filter annotations" value={annotationFilter} onChange={event => setAnnotationFilter(event.target.value as 'all' | 'open' | 'resolved')}><option value="all">All annotations</option><option value="open">Open threads</option><option value="resolved">Resolved threads</option></select></div>{!visibleAnnotations.length ? <div className="sr-panel-empty"><MessageSquare size={30}/><h3>{metadata.annotations.length ? 'No matching threads' : 'Leave a note for your future self.'}</h3><p>{metadata.annotations.length ? 'Choose another filter to see your annotations.' : 'Hover a code line and click + to annotate it. Shift-click to select a range.'}</p><button className="sr-button" type="button" onClick={() => setTab('files')}>Review files</button></div> : <div className="sr-annotation-list">{visibleAnnotations.map(annotation => <DeferredBlock key={annotation.id} height={200} force={visibleAnnotations.length <= 50} render={() => <AnnotationThread key={annotation.id} annotation={annotation} onUpdate={updateAnnotation} onDelete={deleteAnnotation} markdownRenderer={host.renderMarkdown} markdownSourcePath={host.markdownSourcePath} showLocation onLocation={() => {setIgnoreWhitespace(false); setAnnotationTarget(annotation); setLayer(annotation.layer); setFileSearch(''); setHideViewed(false); setCollapsedFiles(previous => {const next = new Set(previous); next.delete(annotation.path); return next;}); setActiveFile(annotation.path); setRequestedFile(''); setTab('files');}}/>}/> )}</div>}</section> : <>
          <div className="sr-diff-toolbar">
            <div className="sr-diff-toolbar-primary">
              <button ref={fileToggleRef} className="sr-icon-button sr-file-nav-toggle" type="button" aria-label="Toggle file navigator" aria-expanded={fileNavigatorOpen} onClick={() => setFileNavigatorOpen(!fileNavigatorOpen)}><FolderTree size={17}/></button>
              <div className="sr-layer-control" role="group" aria-label="Change layer">{(['all', 'staged', 'unstaged'] as DiffLayer[]).map(value => <button type="button" key={value} className={layer === value ? 'sr-active' : ''} aria-pressed={layer === value} onClick={() => setLayer(value)}>{value === 'all' && <Layers size={13}/>} {value === 'all' ? 'All changes' : value === 'staged' ? 'Staged' : 'Unstaged'}</button>)}</div>
              <div className="sr-file-scope-control" role="group" aria-label="File review mode"><button type="button" aria-pressed={fileScope === 'all'} className={fileScope === 'all' ? 'sr-active' : ''} onClick={() => {setRequestedFile(''); setFileScope('all');}}>All files</button><button type="button" aria-pressed={fileScope === 'single'} className={fileScope === 'single' ? 'sr-active' : ''} onClick={() => setFileScope('single')}>Single file</button></div>
            </div>
            <div className="sr-diff-options"><label className="sr-noise-control"><input type="checkbox" aria-label="Ignore whitespace changes" checked={ignoreWhitespace} disabled={!!selection} onChange={event=>setIgnoreWhitespace(event.target.checked)}/>Ignore whitespace</label><button className={`sr-icon-button ${wrapCode ? 'sr-active' : ''}`} type="button" aria-label="Wrap code lines" title="Wrap code lines" aria-pressed={wrapCode} onClick={() => setWrapCode(!wrapCode)}><WrapText size={16}/></button><label>Context<select aria-label="Diff context lines" value={context} onChange={event => setContext(Number(event.target.value))}>{Array.from(new Set([3, 5, 10, 20, host.settings.contextLines])).sort((a, b) => a - b).map(value => <option key={value} value={value}>{value} lines</option>)}</select></label><div className="sr-view-control" role="group" aria-label="Diff view"><button className={mode === 'unified' ? 'sr-active' : ''} type="button" aria-label="Unified diff" aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}><ListFilter size={14}/><span>Unified</span></button><button className={mode === 'split' ? 'sr-active' : ''} type="button" aria-label="Split diff" aria-pressed={mode === 'split'} onClick={() => setMode('split')}><SplitSquareHorizontal size={14}/><span>Split</span></button></div><button className="sr-icon-button" type="button" aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'} title={allCollapsed ? 'Expand all files' : 'Collapse all files'} disabled={!displayedFiles.length} onClick={toggleAllCollapsed}>{allCollapsed ? <ChevronRight size={16}/> : <ChevronDown size={16}/>}</button></div>
          </div>
          <ChangeSearch query={changeQuery} onQuery={setChangeQuery} count={changeMatches.length} active={changeActive} onPrevious={()=>navigateChange(-1)} onNext={()=>navigateChange(1)} blocked={!!selection}/><div className={`sr-review-body ${fileNavigatorOpen ? 'sr-file-navigator-open' : ''}`}>
            <>{fileNavigatorOpen && <button className="sr-drawer-scrim sr-file-scrim" type="button" aria-label="Dismiss file navigator" onClick={() => {setFileNavigatorOpen(false); fileToggleRef.current?.focus();}}/>}</><nav className="sr-file-navigator" aria-label="Changed files">
              <div className="sr-files-heading"><strong>Changed files <span>{filteredFiles.length}</span></strong><div className="sr-file-layout-control" role="group" aria-label="File navigator layout"><button className={`sr-icon-button ${fileLayout === 'tree' ? 'sr-active' : ''}`} type="button" aria-label="Show file tree" title="Tree view" aria-pressed={fileLayout === 'tree'} onClick={() => setFileLayout('tree')}><FolderTree size={15}/></button><button className={`sr-icon-button ${fileLayout === 'list' ? 'sr-active' : ''}`} type="button" aria-label="Show flat file list" title="List view" aria-pressed={fileLayout === 'list'} onClick={() => setFileLayout('list')}><List size={15}/></button></div><button className="sr-icon-button sr-file-nav-close" type="button" aria-label="Close file navigator" onClick={() => setFileNavigatorOpen(false)}><X size={15}/></button></div>
              <div className="sr-file-search"><Search size={14}/><input aria-label="Filter changed files" type="search" placeholder="Filter files…" value={fileSearch} onChange={event => setFileSearch(event.target.value)}/>{fileSearch && <button className="sr-icon-button" type="button" aria-label="Clear changed file search" onClick={() => setFileSearch('')}><X size={13}/></button>}</div>
              <label className="sr-hide-viewed"><input type="checkbox" aria-label="Hide viewed files" checked={hideViewed} onChange={event => setHideViewed(event.target.checked)}/><span>Hide viewed files</span></label>
              <FileTree files={navigableFiles} activePath={focusedFile?.path ?? ''} reviewedFiles={viewedFiles} query={fileSearch} onSelect={jumpToFile} layout={fileLayout} scopeKey={reviewKey} revealKey={annotationTarget?.id ?? ''}/>
              <div className="sr-file-nav-footer"><span>{reviewedCount}/{files.length} viewed</span><span className="sr-additions">+{totals.additions}</span><span className="sr-deletions">−{totals.deletions}</span></div>
            </nav>
            <div className="sr-diff-workspace">
              {fileScope === 'single' && focusedFile && filteredFiles.length > 0 && <div className="sr-file-stepper"><span title={focusedFile?.path}>{focusedFile?.path}</span><div><span>{focusedFileIndex + 1} / {filteredFiles.length}</span><button className="sr-icon-button" type="button" aria-label="Previous changed file" title="Previous file" disabled={focusedFileIndex <= 0} onClick={() => jumpToFile(filteredFiles[focusedFileIndex - 1].path)}><ChevronLeft size={16}/></button><button className="sr-icon-button" type="button" aria-label="Next changed file" title="Next file" disabled={focusedFileIndex >= filteredFiles.length - 1} onClick={() => jumpToFile(filteredFiles[focusedFileIndex + 1].path)}><ChevronRight size={16}/></button></div></div>}
              <section className="sr-diff-scroll" aria-label="Code diff" tabIndex={0}>{diffLoading ? <div className="sr-panel-empty"><LoaderCircle size={26} className="sr-spin"/><h3>Reading the changes…</h3><p>Loading stashed files.</p></div> : diffError ? <div className="sr-panel-empty sr-error"><AlertCircle size={28}/><h3>Could not load this diff</h3><p>{diffError}</p><button className="sr-button" type="button" onClick={() => setReload(value => value + 1)}>Retry diff</button></div> : !displayedFiles.length ? <div className="sr-panel-empty"><CheckCircle2 size={28}/><h3>{requestedFile && !fileSearch && !hideViewed ? 'Linked file unavailable' : fileSearch ? 'No matching files' : hideViewed && files.length ? 'All files viewed' : `No ${layer === 'all' ? '' : `${layer} `}changes`}</h3><p>{requestedFile && !fileSearch && !hideViewed ? 'This path is not present in the selected diff layer. Choose another file or show all files.' : fileSearch ? 'Try another file name or clear the filter.' : hideViewed && files.length ? 'Show viewed files to continue reviewing this stash.' : layer === 'staged' ? 'This stash has no changes saved in the index.' : layer === 'unstaged' ? 'All saved changes were staged.' : 'This stash does not contain a text change in this view.'}</p>{fileSearch && <button className="sr-button" type="button" onClick={() => setFileSearch('')}>Clear file filter</button>}{hideViewed && <button className="sr-button" type="button" onClick={() => setHideViewed(false)}>Show viewed files</button>}</div> : diffViews}</section>
            </div>
          </div>
        </>}
      </>}
      <footer className="sr-statusbar"><span><span className="sr-status-dot"/>Local annotations</span><span>{host.settings.refreshInterval > 0 ? `Refreshes every ${host.settings.refreshInterval}s` : 'Manual refresh'}{stash && <> · <code>{stash.hash.slice(0, 8)}</code></>}</span></footer>
    </main>
    {dialog === 'repository' && <Modal title="Connect a repository" onClose={closeDialog} busy={busy}><form onSubmit={event => {event.preventDefault(); void runAction(async () => {const added = await host.addRepository(repositoryPath.trim()); const result = await host.listRepositories(); setRepositories(result.some(item => item.path === added.path) ? result : [...result, added]); setRepositoryKey(added.path); setRepositoryPath(''); announce(`Connected ${added.name}.`);});}}><p className="sr-modal-description">Use the absolute path to a local Git repository. It can live inside your vault or elsewhere on your computer.</p><label className="sr-form-field">Repository path<input aria-label="Repository path" value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} placeholder="/Users/you/projects/my-project" autoFocus required disabled={busy}/></label><div className="sr-modal-tip"><FolderGit2 size={16}/><span>Your repository stays on this computer. Reviews are stored with your plugin data.</span></div>{dialogError && <div className="sr-form-error" role="alert">{dialogError}</div>}<div className="sr-modal-actions"><button type="button" className="sr-button" onClick={closeDialog} disabled={busy}>Cancel</button><button type="submit" className="sr-button sr-button-primary" disabled={!repositoryPath.trim() || busy}>{busy && <LoaderCircle size={14} className="sr-spin"/>}Connect repository</button></div></form></Modal>}
    {dialog === 'create' && modalRepository && <Modal title="Create a stash" onClose={closeDialog} busy={busy}><form onSubmit={event => {event.preventDefault(); void runAction(async () => {await host.createStash(dialogTarget?.repository ?? modalRepository, newStashMessage.trim(), includeUntracked); const result = await loadStashes(); if (result?.[0]) {setSelectedHash(result[0].hash); setSelectedStashRef(result[0].ref);} await refreshRepositoryStatus(); announce('Working changes saved as a stash.');});}}><p className="sr-modal-description">Save your current working changes in <strong>{modalRepository.name}</strong>, and make room for the next idea.</p><label className="sr-form-field">Stash message<input aria-label="Stash message" value={newStashMessage} onChange={event => setNewStashMessage(event.target.value)} placeholder="What were you working on?" autoFocus disabled={busy}/></label><label className="sr-checkbox-field"><input type="checkbox" checked={includeUntracked} onChange={event => setIncludeUntracked(event.target.checked)} disabled={busy}/><span><strong>Include untracked files</strong><small>Save new files alongside your tracked changes.</small></span></label><div className="sr-modal-tip"><Archive size={16}/><span>Git moves these changes out of your working tree. Ignored files stay in place.</span></div>{dialogError && <div className="sr-form-error" role="alert">{dialogError}</div>}<div className="sr-modal-actions"><button className="sr-button" type="button" onClick={closeDialog} disabled={busy}>Cancel</button><button className="sr-button sr-button-primary" type="submit" disabled={busy}>{busy && <LoaderCircle size={14} className="sr-spin"/>}Create stash</button></div></form></Modal>}
    {dialog === 'apply' && modalRepository && modalStash && <Modal title="Apply this stash?" onClose={closeDialog} busy={busy}><form onSubmit={event => {event.preventDefault(); void runAction(async () => {await host.applyStash(dialogTarget?.repository ?? modalRepository, dialogTarget?.stash ?? modalStash, restoreIndex); await loadStashes(); await refreshRepositoryStatus(); announce('Stash applied to your working tree. The stash is still saved.');});}}><p className="sr-modal-description">Bring <strong>{modalTitle}</strong> into the working tree of <strong>{dialogTarget?.repository.name ?? modalRepository.name}</strong>.</p><label className="sr-checkbox-field"><input type="checkbox" checked={restoreIndex} onChange={event => setRestoreIndex(event.target.checked)} disabled={busy}/><span><strong>Restore staged changes</strong><small>Also recreate which changes were saved in the index.</small></span></label><div className="sr-modal-tip sr-safe-tip"><ShieldCheck size={18}/><span><strong>This keeps your stash.</strong> If changes conflict, Git leaves the conflict in your working tree for you to resolve.</span></div>{dialogError && <div className="sr-form-error" role="alert">{dialogError}</div>}<div className="sr-modal-actions"><button className="sr-button" type="button" onClick={closeDialog} disabled={busy}>Cancel</button><button className="sr-button sr-button-primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={14} className="sr-spin"/> : <ArrowDownToLine size={14}/>}Apply changes</button></div></form></Modal>}
    {dialog === 'drop' && modalRepository && modalStash && <Modal title="Drop this stash?" onClose={closeDialog} busy={busy}><form onSubmit={event => {event.preventDefault(); void runAction(async () => {const targetRepository = modalRepository; const targetStash = modalStash; await host.dropStash(targetRepository, targetStash); setDropped({repository: targetRepository, stash: targetStash}); await loadStashes(); announce('Stash removed. You can undo this using its preserved backup.');});}}><p className="sr-modal-description">Remove <strong>{modalTitle}</strong> from the stash list in <strong>{dialogTarget?.repository.name ?? modalRepository.name}</strong>.</p><div className="sr-modal-tip"><ShieldCheck size={18}/><span>A backup is preserved before removal. You can use <strong>Undo drop</strong> afterward; your review notes remain saved.</span></div>{dialogError && <div className="sr-form-error" role="alert">{dialogError}</div>}<div className="sr-modal-actions"><button className="sr-button" type="button" onClick={closeDialog} disabled={busy}>Keep stash</button><button className="sr-button sr-button-danger" type="submit" disabled={busy}>{busy ? <LoaderCircle size={14} className="sr-spin"/> : <Trash2 size={14}/>}Drop stash</button></div></form></Modal>}
    {dialog === 'details' && modalStash && <Modal title="Edit stash details" onClose={closeDialog} busy={busy}><form onSubmit={event => {event.preventDefault(); void runAction(async () => {await persist(previous => ({...previous, title: details.title.trim(), description: details.description.trim(), tags: [...new Set(details.tags.split(',').map(tag => tag.trim()).filter(Boolean))]}), dialogTarget?.stash ? {repository: dialogTarget.repository, stash: dialogTarget.stash} : undefined);});}}><p className="sr-modal-description">Give this work a name and a little context for when you come back.</p><label className="sr-form-field">Title<input aria-label="Stash title" value={details.title} onChange={event => setDetails({...details, title: event.target.value})} placeholder={stashTitle(modalStash)} autoFocus disabled={busy}/></label><label className="sr-form-field">Description<textarea aria-label="Stash description" rows={4} value={details.description} onChange={event => setDetails({...details, description: event.target.value})} placeholder="Where you left off, what to try next…" disabled={busy}/></label><label className="sr-form-field">Tags<input aria-label="Stash tags" value={details.tags} onChange={event => setDetails({...details, tags: event.target.value})} placeholder="experiment, next-up, needs-review" disabled={busy}/><small>Separate tags with commas.</small></label>{dialogError && <div className="sr-form-error" role="alert">{dialogError}</div>}<div className="sr-modal-actions"><button className="sr-button" type="button" onClick={closeDialog} disabled={busy}>Cancel</button><button className="sr-button sr-button-primary" type="submit" disabled={busy}>{busy && <LoaderCircle size={14} className="sr-spin"/>}Save details</button></div></form></Modal>}
  </div>;
}
