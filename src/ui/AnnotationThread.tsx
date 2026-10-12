import {useState} from 'react';
import {Check, CheckCheck, CornerDownRight, MessageSquare, MoreHorizontal, Pencil, Trash2, Undo2} from 'lucide-react';
import type {Annotation, ReviewHost} from '../types';
import {relativeDate, uniqueId} from './format';
import {MarkdownText} from './MarkdownText';

export function AnnotationThread({annotation, onUpdate, onDelete, showLocation = false, onLocation, markdownRenderer,markdownSourcePath}: {
  annotation: Annotation;
  onUpdate: (annotation: Annotation) => void;
  onDelete: (id: string) => void;
  showLocation?: boolean;
  onLocation?: () => void;
  markdownRenderer?: ReviewHost['renderMarkdown'];
  markdownSourcePath?:string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.body);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(!annotation.resolved);
  const update = (patch: Partial<Annotation>) => onUpdate({...annotation, ...patch, updatedAt: new Date().toISOString()});
  const toggleResolve = () => {update({resolved: !annotation.resolved}); setExpanded(annotation.resolved);};
  return <div className={`sr-thread ${annotation.resolved ? 'sr-thread-resolved' : ''}`} data-annotation-id={annotation.id}>
    {showLocation && <button className="sr-thread-location" type="button" onClick={onLocation}><MessageSquare size={13}/><span>{annotation.path}</span><code>{annotation.side === 'old' ? 'L' : 'R'}{annotation.startLine}{annotation.endLine !== annotation.startLine ? `–${annotation.endLine}` : ''}</code><span className="sr-layer-label">{annotation.layer}</span></button>}
    <div className="sr-thread-top"><div className="sr-avatar">Y</div><strong>You</strong><time title={new Date(annotation.createdAt).toLocaleString()}>{relativeDate(annotation.createdAt)}</time>{annotation.resolved && <span className="sr-resolved-label"><CheckCheck size={12}/>Resolved</span>}<div className="sr-thread-tools">
      {annotation.resolved && <button className="sr-text-button" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse' : 'View thread'}</button>}
      <button className="sr-icon-button" type="button" aria-label="Annotation actions" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={16}/></button>
      {menu && <div className="sr-menu"><button type="button" onClick={() => {setEditing(true); setExpanded(true); setDraft(annotation.body); setMenu(false);}}><Pencil size={14}/>Edit annotation</button><button type="button" className="sr-danger-text" onClick={() => {setConfirmDelete(true); setExpanded(true); setMenu(false);}}><Trash2 size={14}/>Delete annotation</button></div>}
    </div></div>
    {expanded && <>
      {editing ? <form onSubmit={event => {event.preventDefault(); if (draft.trim()) {update({body: draft.trim()}); setEditing(false);}}}><textarea aria-label="Edit annotation text" value={draft} onChange={event => setDraft(event.target.value)} rows={3} autoFocus/><div className="sr-form-actions"><button className="sr-button sr-button-small" type="button" onClick={() => setEditing(false)}>Cancel edit</button><button className="sr-button sr-button-primary sr-button-small" type="submit" disabled={!draft.trim()}>Save changes</button></div></form> : <MarkdownText source={annotation.body} renderer={markdownRenderer} sourcePath={markdownSourcePath} className="sr-thread-body"/>}
      {annotation.replies.map(item => <div className="sr-reply" key={item.id}><CornerDownRight size={14}/><div><div className="sr-reply-meta"><strong>You</strong><time title={new Date(item.createdAt).toLocaleString()}>{relativeDate(item.createdAt)}</time></div><MarkdownText source={item.body} renderer={markdownRenderer} sourcePath={markdownSourcePath}/></div></div>)}
      {confirmDelete ? <div className="sr-inline-confirm"><span>Delete this annotation and its replies?</span><button className="sr-text-button" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="sr-button sr-button-danger sr-button-small" type="button" onClick={() => onDelete(annotation.id)}>Delete annotation</button></div> : <div className="sr-thread-footer"><button className="sr-text-button" type="button" onClick={() => setReplying(!replying)}><MessageSquare size={13}/>Reply</button><button className="sr-text-button" type="button" onClick={toggleResolve}>{annotation.resolved ? <Undo2 size={13}/> : <Check size={13}/>} {annotation.resolved ? 'Reopen thread' : 'Resolve thread'}</button></div>}
      {replying && <form className="sr-reply-form" onSubmit={event => {event.preventDefault(); if (!reply.trim()) return; update({replies: [...annotation.replies, {id: uniqueId(), body: reply.trim(), createdAt: new Date().toISOString()}]}); setReply(''); setReplying(false);}}><textarea aria-label="Reply text" rows={2} placeholder="Add a follow-up…" value={reply} onChange={event => setReply(event.target.value)} autoFocus/><div className="sr-form-actions"><button type="button" className="sr-button sr-button-small" onClick={() => setReplying(false)}>Cancel reply</button><button type="submit" className="sr-button sr-button-primary sr-button-small" disabled={!reply.trim()}>Save reply</button></div></form>}
    </>}
  </div>;
}
