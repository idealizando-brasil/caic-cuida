import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const allowedRoles=["school_admin","director","coordinator","psychologist","social_worker","teacher"];
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
 try{
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token=req.headers.get("Authorization")?.replace("Bearer ","");
  if(!token)return json({error:"Não autorizado"},401);
  const {data:{user}}=await admin.auth.getUser(token);
  if(!user)return json({error:"Sessão inválida"},401);
  const body=await req.json();
  const schoolId=String(body.school_id||"");
  const [{data:callerProfile},{data:callerMembership}]=await Promise.all([
   admin.from("profiles").select("platform_admin").eq("id",user.id).single(),
   admin.from("school_memberships").select("role,active").eq("user_id",user.id).eq("school_id",schoolId).maybeSingle()
  ]);
  const isPlatformAdmin=Boolean(callerProfile?.platform_admin);
  const isSchoolDirector=callerMembership?.active===true&&callerMembership.role==="director";
  if(!isPlatformAdmin&&!isSchoolDirector)return json({error:"Somente a Direção da escola ou o Administrador da Matriz pode gerenciar usuários"},403);

  const {data:membership,error:membershipError}=await admin.from("school_memberships").select("id,user_id,school_id,role,active").eq("id",body.membership_id).eq("school_id",schoolId).single();
  if(membershipError||!membership)throw new Error("Usuário não encontrado nesta escola");
  const {data:targetProfile}=await admin.from("profiles").select("platform_admin").eq("id",membership.user_id).single();
  if(targetProfile?.platform_admin)throw new Error("A conta do Administrador da Matriz é protegida");
  if(membership.user_id===user.id)throw new Error("Você não pode alterar ou excluir a própria conta");

  async function ensureAnotherDirector(){
   const {count}=await admin.from("school_memberships").select("id",{count:"exact",head:true}).eq("school_id",schoolId).eq("role","director").eq("active",true).neq("id",membership.id);
   if((count||0)===0)throw new Error("A escola precisa manter pelo menos uma conta de Direção ativa");
  }

  if(body.action==="delete"){
   if(membership.role==="director"&&membership.active)await ensureAnotherDirector();
   // Remove somente o vínculo com a escola. A conta e os registros históricos
   // permanecem preservados para auditoria e para o futuro uso multiescolas.
   const {error:deleteMembershipError}=await admin.from("school_memberships").delete().eq("id",membership.id).eq("school_id",schoolId);
   if(deleteMembershipError)throw deleteMembershipError;
   return json({success:true});
  }

  if(body.action==="update"){
   const fullName=String(body.full_name||"").trim();
   const email=String(body.email||"").trim().toLowerCase();
   if(!fullName||!email||!allowedRoles.includes(body.role))throw new Error("Preencha nome, e-mail e função corretamente");
   if(membership.role==="director"&&membership.active&&body.role!=="director")await ensureAnotherDirector();
   const {error:authError}=await admin.auth.admin.updateUserById(membership.user_id,{email,email_confirm:true});
   if(authError)throw authError;
   const {error:profileError}=await admin.from("profiles").update({full_name:fullName,email}).eq("id",membership.user_id);
   if(profileError)throw profileError;
   const {error:roleError}=await admin.from("school_memberships").update({role:body.role}).eq("id",membership.id);
   if(roleError)throw roleError;
   return json({success:true});
  }

  throw new Error("Ação inválida");
 }catch(error){return json({error:error instanceof Error?error.message:"Erro interno"},400)}
});
