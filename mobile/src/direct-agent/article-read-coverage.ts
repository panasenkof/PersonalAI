/** 9B: Derived evidence for ONE agent turn. No new persistence, RAG or user memory.
 * A new turn must re-read canonical sources; workspace drafts do not certify reads. */
export type ArticleSelectionHandle = { id:string; version:number };
export type VerifiedArticleSpan = { startChar:number; endChar:number };
export type ArticleReadReceipt = {
  offset:number; content:string; totalChars:number; hasMore:boolean;
};
type Reading = {
  totalChars:number; ranges:VerifiedArticleSpan[];
  sawContent:boolean; linkOnly:boolean; unavailable:boolean;
};
export type ArticleCoverageStatus =
  "unread" | "partial_saved_note" | "complete_saved_note_text" |
  "link_only" | "empty_saved_note" | "not_available_or_stale";

const identity=(h:ArticleSelectionHandle)=>JSON.stringify([h.id,h.version]);

function unite(ranges:VerifiedArticleSpan[]):VerifiedArticleSpan[] {
  const sorted=[...ranges].sort((a,b)=>a.startChar-b.startChar||a.endChar-b.endChar);
  const result:VerifiedArticleSpan[]=[];
  for(const span of sorted) {
    const prev=result[result.length-1];
    if(prev && span.startChar<=prev.endChar)
      prev.endChar=Math.max(prev.endChar,span.endChar);
    else result.push({...span});
  }
  return result;
}
function nextUnread(ranges:VerifiedArticleSpan[],total:number):number|null {
  if(total===0)return null;
  let end=0;
  for(const span of ranges){
    if(span.startChar>end)return end;
    end=Math.max(end,span.endChar);
  }
  return end<total?end:null;
}

export function createArticleReadCoverage(){
  const byHandle=new Map<string,Reading>();
  const record=(handle:ArticleSelectionHandle,read:ArticleReadReceipt)=>{
    const key=identity(handle);
    const end=read.offset+read.content.length;
    if(!Number.isSafeInteger(read.offset)||read.offset<0 ||
      !Number.isSafeInteger(read.totalChars)||read.totalChars<0 ||
      end>read.totalChars || read.hasMore!==(end<read.totalChars))
      throw new Error("invalid_article_coverage_receipt");
    // Reading an already reached EOF returns no bytes, not evidence of text.
    if(read.content.length===0 && read.totalChars>0)return;
    const old=byHandle.get(key);
    if(old && !old.unavailable && old.totalChars!==read.totalChars){
      byHandle.delete(key); // Conflicting lengths in the same revision are not evidence.
      throw new Error("inconsistent_article_total_chars");
    }
    const ranges=unite([...(old&&!old.unavailable?old.ranges:[]),
      {startChar:read.offset,endChar:end}]);
    const isWhole=read.offset===0 && end===read.totalChars;
    byHandle.set(key,{totalChars:read.totalChars,ranges,
      sawContent:Boolean(read.content.trim()) || Boolean(old&&!old.unavailable&&old.sawContent),
      linkOnly:Boolean(old&&!old.unavailable&&old.linkOnly) ||
        (isWhole && /^https?:\/\/\S+$/iu.test(read.content.trim())),
      unavailable:false});
  };
  const unavailable=(handle:ArticleSelectionHandle)=>{
    byHandle.set(identity(handle),{totalChars:0,ranges:[],
      sawContent:false,linkOnly:false,unavailable:true});
  };
  const summary=(selected:ArticleSelectionHandle[])=>{
    const entries=selected.map((handle,selectedIndex)=>{
      const read=byHandle.get(identity(handle));
      if(!read)return {selectedIndex,status:"unread" as ArticleCoverageStatus,
        verifiedChars:0,ranges:[] as VerifiedArticleSpan[]};
      if(read.unavailable)return {selectedIndex,status:"not_available_or_stale" as ArticleCoverageStatus,
        verifiedChars:0,ranges:[] as VerifiedArticleSpan[]};
      const firstGap=nextUnread(read.ranges,read.totalChars);
      const complete=firstGap===null;
      const status:ArticleCoverageStatus=!complete?"partial_saved_note":
        !read.sawContent?"empty_saved_note":
        read.linkOnly?"link_only":"complete_saved_note_text";
      return {selectedIndex,status,totalChars:read.totalChars,
        verifiedChars:read.ranges.reduce((sum,r)=>sum+r.endChar-r.startChar,0),
        ranges:read.ranges.map(r=>({...r})),
        ...(!complete?{nextUnreadOffset:firstGap}:{}),
      };
    });
    const count=(status:ArticleCoverageStatus)=>entries.filter(e=>e.status===status).length;
    const fullyReadCount=count("complete_saved_note_text");
    const partialCount=count("partial_saved_note");
    const linkOnlyCount=count("link_only");
    const emptyCount=count("empty_saved_note");
    const unavailableCount=count("not_available_or_stale");
    const unreadCount=count("unread");
    return {scope:"current_agent_turn_verified_reads" as const,
      selectedCount:selected.length,checkedCount:selected.length-unreadCount,
      fullyReadCount,partialCount,linkOnlyCount,emptyCount,unavailableCount,
      unreadCount,readTextCount:fullyReadCount+partialCount,
      allSelectedHaveFullSavedNoteText:fullyReadCount===selected.length,
      originalWebPagesVerified:0, entries};
  };
  return {record,unavailable,summary};
}
