/** Approval succeeds independently of the optional workroom grant. Retrying a failed grant
 * must not ask for another SAS or pretend the encrypted connection failed. */
export async function approveInternetSessionWithWorkroom<T>(approve:()=>Promise<T>,grant?:()=>Promise<unknown>):Promise<{status:T;workroomError:string|null}> {
 const status=await approve();
 try {if(grant)await grant();return {status,workroomError:null};}
 catch(error){return {status,workroomError:error instanceof Error?error.message:String(error)};}
}
