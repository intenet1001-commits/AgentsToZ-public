/** Read the exact reviewed lineage. This path must never claim, migrate, follow an alias or change local config. */
export async function readReviewedMemoryIdentity(sb:any,memoryId:string):Promise<{memoryId:string;repositoryKey:string|null}>{
 const alias=await sb.from('portmgr_project_memory_aliases').select('canonical_memory_id').eq('alias_memory_id',memoryId).maybeSingle();
 if(alias.error)throw Error('기억 계보를 확인하지 못했습니다. 기존 기억은 변경하지 않았습니다.');
 if(alias.data?.canonical_memory_id&&alias.data.canonical_memory_id!==memoryId)throw Error('기억 연결이 바뀌었습니다. 계보를 검토한 뒤 다시 비교하세요.');
 const registry=await sb.from('portmgr_project_memories').select('memory_id,canonical_repo_key').eq('memory_id',memoryId).maybeSingle();
 if(registry.error||registry.data?.memory_id!==memoryId)throw Error('검토한 기억의 등록 정보를 확인하지 못했습니다. 기존 기억은 변경하지 않았습니다.');
 return {memoryId,repositoryKey:typeof registry.data.canonical_repo_key==='string'?registry.data.canonical_repo_key:null};
}
