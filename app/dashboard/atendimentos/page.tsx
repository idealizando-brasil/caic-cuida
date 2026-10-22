"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, ClipboardPlus, History, Search, ShieldCheck, UserRound, X } from "lucide-react";
import AppShell from "@/components/app-shell";
import { createClient } from "@/lib/supabase/client";
import { canRegisterAttendance, continuityOptions, type ContinuityOption } from "./flow-rules";
import "./attendances.css";

type School={id:string;name:string};
type Student={id:string;full_name:string;classes:{name:string}|null};
type Appointment={id:string;school_id:string;student_id:string;referral_id:string;professional_id:string;starts_at:string;status:string;appointment_type:string;students:{full_name:string;classes:{name:string}|null}|null};
type PrivateDemand={demand:string};
type Attendance={
 id:string;student_id:string;appointment_id:string|null;guidance_referrals:string;occurred_at:string;created_at:string;
 is_retroactive:boolean;attendance_area:string|null;attendance_type:string|null;record_origin:string|null;
 requires_current_follow_up:boolean;students:{full_name:string;classes:{name:string}|null}|null;
 profiles:{full_name:string|null;email:string}|null;attendance_private_demands:PrivateDemand|PrivateDemand[]|null;
};

const dateFmt=new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"America/Fortaleza"});
const areaLabels:Record<string,string>={psychology:"Psicologia",social_work:"Assistência Social",joint:"Atendimento conjunto"};
const typeLabels:Record<string,string>={listening:"Escuta",guidance:"Orientação",family_contact:"Contato com responsável",family_visit:"Visita familiar",network_coordination:"Articulação com a rede",other:"Outro"};
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Fortaleza"}).format(new Date());

export default function Atendimentos(){
 const [supabase]=useState(()=>createClient());
 const router=useRouter();
 const [email,setEmail]=useState("");
 const [school,setSchool]=useState<School|null>(null);
 const [role,setRole]=useState("");
 const [userId,setUserId]=useState("");
 const [appointments,setAppointments]=useState<Appointment[]>([]);
 const [students,setStudents]=useState<Student[]>([]);
 const [records,setRecords]=useState<Attendance[]>([]);
 const [selected,setSelected]=useState<Appointment|null>(null);
 const [retroOpen,setRetroOpen]=useState(false);
 const [retroStudent,setRetroStudent]=useState<Student|null>(null);
 const [studentSearch,setStudentSearch]=useState("");
 const [occurredDate,setOccurredDate]=useState(today());
 const [occurredTime,setOccurredTime]=useState("08:00");
 const [attendanceArea,setAttendanceArea]=useState("joint");
 const [attendanceType,setAttendanceType]=useState("listening");
 const [recordOrigin,setRecordOrigin]=useState("historical_record");
 const [requiresFollowUp,setRequiresFollowUp]=useState(false);
 const [demand,setDemand]=useState("");
 const [guidance,setGuidance]=useState("");
 const [continuity,setContinuity]=useState<ContinuityOption>("conclude");
 const [returnDate,setReturnDate]=useState("");
 const [returnTime,setReturnTime]=useState("08:00");
 const [returnDuration,setReturnDuration]=useState("50");
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);

 const load=useCallback(async()=>{
  const {data:{user}}=await supabase.auth.getUser();
  if(!user){router.replace("/login");return;}
  setEmail(user.email||"");setUserId(user.id);
  const {data:m}=await supabase.from("school_memberships").select("school_id,role,schools(id,name)").eq("user_id",user.id).eq("active",true).limit(1).single();
  const raw=m?.schools as unknown;
  const current=(Array.isArray(raw)?raw[0]:raw) as School|undefined;
  if(!current)return;
  setSchool(current);setRole(String(m?.role||""));
  const [{data:a},{data:s},{data:r}]=await Promise.all([
   supabase.from("appointments").select("id,school_id,student_id,referral_id,professional_id,starts_at,status,appointment_type,students(full_name,classes(name))").eq("school_id",current.id).eq("status","scheduled").order("starts_at"),
   supabase.from("students").select("id,full_name,classes(name)").eq("school_id",current.id).eq("active",true).order("full_name"),
   supabase.from("attendances").select("id,student_id,appointment_id,guidance_referrals,occurred_at,created_at,is_retroactive,attendance_area,attendance_type,record_origin,requires_current_follow_up,students(full_name,classes(name)),profiles!attendances_author_id_fkey(full_name,email),attendance_private_demands(demand)").eq("school_id",current.id).order("occurred_at",{ascending:false})
  ]);
  setAppointments((a||[]) as unknown as Appointment[]);
  setStudents((s||[]) as unknown as Student[]);
  setRecords((r||[]) as unknown as Attendance[]);
 },[router,supabase]);

 useEffect(()=>{load();},[load]);
 const canRegister=canRegisterAttendance(role);
 const eligible=appointments.filter(a=>a.professional_id===userId);
 const studentResults=useMemo(()=>{
  const q=studentSearch.trim().toLocaleLowerCase("pt-BR");
  if(q.length<2)return [];
  return students.filter(s=>s.full_name.toLocaleLowerCase("pt-BR").includes(q)||(s.classes?.name||"").toLocaleLowerCase("pt-BR").includes(q)).slice(0,12);
 },[studentSearch,students]);

 function resetFields(){
  setDemand("");setGuidance("");setContinuity("conclude");setReturnDate("");setReturnTime("08:00");setReturnDuration("50");
 }
 function closeScheduled(){setSelected(null);resetFields();}
 function closeRetro(){
  setRetroOpen(false);setRetroStudent(null);setStudentSearch("");setOccurredDate(today());setOccurredTime("08:00");
  setAttendanceArea("joint");setAttendanceType("listening");setRecordOrigin("historical_record");setRequiresFollowUp(false);resetFields();
 }
 function privateText(record:Attendance){
  const value=record.attendance_private_demands;
  return Array.isArray(value)?value[0]?.demand:value?.demand;
 }

 async function save(ev:FormEvent){
  ev.preventDefault();
  if(!school||!selected||!canRegister||!demand.trim()||!guidance.trim())return;
  if(continuity==="return_scheduled"&&!returnDate)return;
  setBusy(true);setMessage("");
  const {data:attendance,error}=await supabase.from("attendances").insert({
   school_id:school.id,student_id:selected.student_id,referral_id:selected.referral_id,appointment_id:selected.id,
   author_id:userId,guidance_referrals:guidance.trim(),occurred_at:selected.starts_at,is_retroactive:false,
   record_origin:"scheduled",attendance_area:role==="psychologist"?"psychology":"social_work",attendance_type:"listening"
  }).select("id").single();
  if(error||!attendance){setMessage("Não foi possível registrar o atendimento. Confira se o agendamento continua válido.");setBusy(false);return;}
  const {error:privateError}=await supabase.from("attendance_private_demands").insert({attendance_id:attendance.id,school_id:school.id,author_id:userId,demand:demand.trim()});
  if(privateError){setMessage("O atendimento foi criado, mas houve falha ao salvar a Escuta Ativa. Não prossiga e comunique a administração do sistema.");setBusy(false);return;}
  await supabase.from("appointments").update({status:"completed"}).eq("id",selected.id);
  if(continuity==="conclude")await supabase.from("referrals").update({status:"completed"}).eq("id",selected.referral_id);
  if(continuity==="return_pending")await supabase.from("referrals").update({status:"awaiting_schedule"}).eq("id",selected.referral_id);
  if(continuity==="return_scheduled"){
   const start=new Date(`${returnDate}T${returnTime}:00-03:00`),end=new Date(start.getTime()+Number(returnDuration)*60000);
   const {error:returnError}=await supabase.from("appointments").insert({school_id:school.id,student_id:selected.student_id,referral_id:selected.referral_id,professional_id:userId,starts_at:start.toISOString(),ends_at:end.toISOString(),kind:"Retorno",status:"scheduled",location:"Sala da Equipe Multiprofissional",appointment_type:"return"});
   if(returnError){await supabase.from("referrals").update({status:"awaiting_schedule"}).eq("id",selected.referral_id);setMessage("Atendimento registrado. O retorno ficou pendente de agendamento porque a data não pôde ser salva.");}
   else{await supabase.from("referrals").update({status:"scheduled"}).eq("id",selected.referral_id);setMessage("Atendimento registrado e retorno incluído na Agenda.");}
  }
  if(continuity!=="return_scheduled")setMessage(continuity==="conclude"?"Atendimento registrado e acompanhamento concluído.":"Atendimento registrado. Retorno aguardando definição de data.");
  closeScheduled();await load();setBusy(false);
 }

 async function saveRetroactive(ev:FormEvent){
  ev.preventDefault();
  if(!school||!retroStudent||!canRegister||!occurredDate||!demand.trim()||!guidance.trim())return;
  setBusy(true);setMessage("");
  const occurredAt=new Date(`${occurredDate}T${occurredTime}:00-03:00`);
  if(Number.isNaN(occurredAt.getTime())||occurredAt>new Date()){setMessage("Informe uma data e um horário anteriores ao momento atual.");setBusy(false);return;}
  const {error}=await supabase.rpc("create_retroactive_attendance",{
   p_school_id:school.id,p_student_id:retroStudent.id,p_occurred_at:occurredAt.toISOString(),
   p_area:attendanceArea,p_type:attendanceType,p_origin:recordOrigin,p_private_demand:demand.trim(),
   p_guidance_referrals:guidance.trim(),p_requires_current_follow_up:requiresFollowUp
  });
  if(error){setMessage("Não foi possível registrar o atendimento anterior. Confira os campos e tente novamente.");setBusy(false);return;}
  setMessage(requiresFollowUp?"Atendimento anterior registrado e sinalizado para acompanhamento atual.":"Atendimento anterior registrado com data real e auditoria do lançamento.");
  closeRetro();await load();setBusy(false);
 }

 if(!school)return <main className="loading">Carregando atendimentos…</main>;
 return <AppShell email={email}>
  <header className="attendances-header">
   <div><p className="eyebrow green">EQUIPE MULTIPROFISSIONAL</p><h1>Atendimentos</h1><p className="muted">Registre atendimentos agendados e atendimentos anteriores com data real e histórico de lançamento.</p></div>
   {canRegister&&<button className="retro-button" onClick={()=>{closeScheduled();setRetroOpen(true);setMessage("");}}><History/> Registrar atendimento anterior</button>}
  </header>
  {message&&<div className="feedback" role="status">{message}</div>}

  {canRegister?<section className="card scheduled-section"><div className="form-heading"><div><h2>Agendamentos aptos para registro</h2><p className="muted">Selecione um compromisso previamente agendado. Aluno e encaminhamento já estão vinculados.</p></div></div>{eligible.length?eligible.map(a=><div className="appointment-item" key={a.id}><div className="appointment-person"><UserRound/><div><strong>{a.students?.full_name}</strong><small>{a.students?.classes?.name||"Sem turma"} · {dateFmt.format(new Date(a.starts_at))} · {a.appointment_type==="return"?"RETORNO":"PRIMEIRO ATENDIMENTO"}</small></div></div><button className="primary-button" onClick={()=>{closeRetro();setSelected(a);setMessage("");window.scrollTo({top:0,behavior:"smooth"});}}><ClipboardPlus/> Registrar atendimento</button></div>):<p className="muted">Nenhum agendamento disponível para registro.</p>}</section>:<div className="attendance-notice"><ClipboardPlus/><div><b>Registro reservado à Equipe Multiprofissional.</b><p>Direção e Coordenação acompanham os registros compartilhados, mas não acessam a escuta sigilosa.</p></div></div>}

  {retroOpen&&canRegister&&<form className="card attendance-form retro-form" onSubmit={saveRetroactive}>
   <div className="form-heading"><div><p className="eyebrow purple">REGISTRO RETROATIVO</p><h2>Registrar atendimento anterior</h2><p className="muted">A data real do atendimento ficará separada da data atual de lançamento no CUIDA.</p></div><button type="button" className="close-button" onClick={closeRetro}><X/></button></div>
   <div className="attendance-form-grid">
    <div className="student-picker content-field">
     <span className="field-label">Aluno</span>
     {retroStudent?<div className="selected-student"><div><strong>{retroStudent.full_name}</strong><small>{retroStudent.classes?.name||"Sem turma"}</small></div><button type="button" onClick={()=>{setRetroStudent(null);setStudentSearch("");}}>Trocar aluno</button></div>:<>
      <label className="student-search"><Search/><input value={studentSearch} onChange={e=>setStudentSearch(e.target.value)} placeholder="Digite pelo menos 2 letras do nome ou da turma" autoComplete="off"/></label>
      {studentSearch.trim().length>=2&&<div className="student-results">{studentResults.length?studentResults.map(s=><button type="button" key={s.id} onClick={()=>{setRetroStudent(s);setStudentSearch("");}}><strong>{s.full_name}</strong><small>{s.classes?.name||"Sem turma"}</small></button>):<p>Nenhum aluno encontrado.</p>}</div>}
     </>}
    </div>
    <label>Data real do atendimento<input required type="date" max={today()} value={occurredDate} onChange={e=>setOccurredDate(e.target.value)}/></label>
    <label>Horário real<input required type="time" value={occurredTime} onChange={e=>setOccurredTime(e.target.value)}/></label>
    <label>Área responsável<select value={attendanceArea} onChange={e=>setAttendanceArea(e.target.value)}><option value="psychology">Psicologia</option><option value="social_work">Assistência Social</option><option value="joint">Atendimento conjunto</option></select></label>
    <label>Tipo de atendimento<select value={attendanceType} onChange={e=>setAttendanceType(e.target.value)}><option value="listening">Escuta</option><option value="guidance">Orientação</option><option value="family_contact">Contato com responsável</option><option value="family_visit">Visita familiar</option><option value="network_coordination">Articulação com a rede</option><option value="other">Outro</option></select></label>
    <label>Origem do registro<select value={recordOrigin} onChange={e=>setRecordOrigin(e.target.value)}><option value="historical_record">Anotação ou documento anterior</option><option value="spontaneous">Demanda espontânea</option><option value="previous_referral">Encaminhamento anterior não registrado</option></select></label>
    <label className="content-field">ESCUTA ATIVA – REGISTRO SIGILOSO<textarea required value={demand} onChange={e=>setDemand(e.target.value)} rows={5}/><small>Visível exclusivamente para Psicologia e Assistência Social da escola.</small></label>
    <label className="content-field">ORIENTAÇÕES E PROVIDÊNCIAS<textarea required value={guidance} onChange={e=>setGuidance(e.target.value)} rows={5}/><small>Parte institucional visível à Direção, Coordenação, Psicologia e Assistência Social.</small></label>
    <label className="check-field"><input type="checkbox" checked={requiresFollowUp} onChange={e=>setRequiresFollowUp(e.target.checked)}/><span>Este atendimento anterior necessita de acompanhamento atual</span></label>
   </div>
   <div className="privacy-note"><ShieldCheck/><span>O sistema registrará quem realizou o lançamento e quando ele foi feito. A data de criação não será retroagida.</span></div>
   <div className="appointment-form-actions"><button type="button" className="secondary-button" onClick={closeRetro}>Cancelar</button><button className="primary-button" disabled={busy||!retroStudent}>{busy?"Salvando…":"Salvar atendimento anterior"}</button></div>
  </form>}

  {selected&&canRegister&&<form className="card attendance-form" onSubmit={save}><div className="form-heading"><div><h2>Registrar atendimento</h2><p className="muted"><b>{selected.students?.full_name}</b> · Agendamento de {dateFmt.format(new Date(selected.starts_at))}</p></div><button type="button" className="close-button" onClick={closeScheduled}><X/></button></div><label>ESCUTA ATIVA – DEMANDA<textarea required value={demand} onChange={e=>setDemand(e.target.value)} rows={5}/><small>Registro sigiloso visível exclusivamente para Psicologia e Assistência Social da escola.</small></label><label>ORIENTAÇÕES E ENCAMINHAMENTOS<textarea required value={guidance} onChange={e=>setGuidance(e.target.value)} rows={5}/><small>Informação institucional compartilhada com Direção, Coordenação, Psicologia e Assistência Social.</small></label><label>Continuidade do acompanhamento<select value={continuity} onChange={e=>setContinuity(e.target.value as ContinuityOption)}>{Object.entries(continuityOptions).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>{continuity==="return_scheduled"&&<div className="appointment-form-grid"><label>Data do retorno<input required type="date" value={returnDate} onChange={e=>setReturnDate(e.target.value)}/></label><label>Horário<input type="time" value={returnTime} onChange={e=>setReturnTime(e.target.value)}/></label><label>Duração<select value={returnDuration} onChange={e=>setReturnDuration(e.target.value)}><option value="30">30 minutos</option><option value="50">50 minutos</option><option value="60">1 hora</option></select></label></div>}<div className="appointment-form-actions"><button type="button" className="secondary-button" onClick={closeScheduled}>Cancelar</button><button className="primary-button" disabled={busy}>{busy?"Salvando…":"Salvar atendimento"}</button></div></form>}

  <section className="attendance-list"><h2>Histórico de atendimentos</h2>{records.length?records.map(r=><article className={`card attendance-card ${r.is_retroactive?"retroactive-card":""}`} key={r.id}>
   <div className="record-heading"><div className="appointment-person"><UserRound/><div><strong>{r.students?.full_name}</strong><small>{r.students?.classes?.name||"Sem turma"} · Atendimento em {dateFmt.format(new Date(r.occurred_at))}</small></div></div><div className="record-badges">{r.is_retroactive&&<span className="retro-badge">REGISTRO RETROATIVO</span>}{r.requires_current_follow_up&&<span className="follow-up-badge">ACOMPANHAMENTO ATUAL</span>}</div></div>
   {r.attendance_area&&<p className="record-meta">{areaLabels[r.attendance_area]||r.attendance_area} · {typeLabels[r.attendance_type||""]||r.attendance_type}</p>}
   {privateText(r)&&<p className="confidential-demand"><b>Escuta sigilosa:</b> {privateText(r)}</p>}
   <p><b>Orientações e Providências:</b> {r.guidance_referrals}</p>
   <footer><small>Registrado por {r.profiles?.full_name||r.profiles?.email}</small><small>Lançado no CUIDA em {dateFmt.format(new Date(r.created_at))}</small></footer>
  </article>):<div className="card empty-attendance"><CalendarDays/><p className="muted">Nenhum atendimento registrado.</p></div>}</section>
 </AppShell>;
}
