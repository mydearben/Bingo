import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const DEFAULT_CODE = new URLSearchParams(location.search).get("room") || "";
let currentParticipant = null;
let currentRoom = null;
let currentCard = [];
let activeSquare = null;
let adminRoom = null;
let refreshTimer = null;

function message(id, text, success=false) {
  const el=$(id); if(!el) return; el.textContent=text; el.classList.toggle("success",success);
}
function showView(name) {
  ["welcome","participant","organiser"].forEach(v=>$(`${v}-view`).classList.toggle("hidden",v!==name));
  window.scrollTo({top:0,behavior:"smooth"});
}
function connected(ok) {
  $("connection-state").classList.toggle("online",ok);
  $("connection-state").lastChild.textContent=ok?" Connected":" Not connected";
}
function safeText(s) { return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function hasBingo(entries) {
  const marked = new Set(entries.map(x=>x.index));
  const lines=[];
  for(let r=0;r<5;r++) lines.push(Array.from({length:5},(_,c)=>r*5+c));
  for(let c=0;c<5;c++) lines.push(Array.from({length:5},(_,r)=>r*5+c));
  lines.push([0,6,12,18,24],[4,8,12,16,20]);
  return lines.some(line=>line.every(i=>i===12 || marked.has(i)));
}
function drawCard() {
  const grid=$("bingo-grid"); grid.innerHTML="";
  currentCard.forEach((cell,index)=>{
    const btn=document.createElement("button");
    btn.type="button"; btn.className="bingo-cell"+(cell.free?" free":"")+(cell.name?" done":"");
    btn.disabled=!!cell.free;
    btn.innerHTML=cell.free?'<span class="cell-text">FREE<br>SPACE</span><span class="cell-name">Everyone gets this one</span>':
      `<span class="cell-text">${safeText(cell.prompt)}</span><span class="cell-name">${cell.name?safeText(cell.name):"＋ Add colleague name"}</span>`;
    if(!cell.free) btn.addEventListener("click",()=>openSquare(index));
    grid.appendChild(btn);
  });
  const done=currentCard.filter(c=>!c.free&&c.name).length;
  $("progress-count").textContent=done;
  $("progress-fill").style.width=(done/24*100)+"%";
  $("progress-copy").textContent=done===0?"Start a conversation to mark your first square.":`${done} of 24 statements completed. Keep meeting colleagues!`;
  const entries=currentCard.map((c,index)=>({index,name:c.name})).filter(x=>x.name);
  const bingo=hasBingo(entries);
  $("line-status").textContent=bingo?"Bingo line completed — submit your card!":"No Bingo line yet";
  $("line-status").classList.toggle("ready",bingo);
  $("submit-bingo").disabled=!bingo;
}
function openSquare(index) {
  activeSquare=index; $("dialog-prompt").textContent=currentCard[index].prompt;
  $("colleague-name").value=currentCard[index].name||"";
  message("square-error","");
  $("square-dialog").showModal();
  $("colleague-name").focus();
}
$("square-form").addEventListener("submit",async e=>{
  if(e.submitter?.value==="cancel") return;
  e.preventDefault();
  const name=$("colleague-name").value.trim();
  if(!name) return message("square-error","Please enter a colleague's name.");
  if(name.toLowerCase()===currentParticipant.name.toLowerCase()) return message("square-error","Please enter another colleague, not your own name.");
  const duplicate=currentCard.some((c,i)=>i!==activeSquare&&!c.free&&c.name?.toLowerCase()===name.toLowerCase());
  if(duplicate) return message("square-error","Use a different colleague for each square.");
  const next=currentCard.map((c,i)=>i===activeSquare?{...c,name}:c);
  const {error}=await supabase.rpc("set_bingo_square",{p_session_token:currentParticipant.token,p_square_index:activeSquare,p_colleague_name:name});
  if(error) return message("square-error",error.message);
  currentCard=next; $("square-dialog").close(); drawCard();
});
$("join-button").addEventListener("click",joinRoom);
$("room-code").value=DEFAULT_CODE.toUpperCase();
$("room-code").addEventListener("input",e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6));
async function joinRoom() {
  const code=$("room-code").value.trim().toUpperCase(), name=$("participant-name").value.trim();
  message("join-message","");
  if(code.length!==6) return message("join-message","Enter the six-character event room code.");
  if(!name) return message("join-message","Please enter your name.");
  $("join-button").disabled=true; $("join-button").textContent="Joining…";
  const token=crypto.randomUUID();
  const {data,error}=await supabase.rpc("join_bingo_room",{p_room_code:code,p_participant_name:name,p_session_token:token});
  $("join-button").disabled=false; $("join-button").textContent="Join the Bingo";
  if(error) return message("join-message",error.message);
  currentParticipant={id:data.participant_id,name:data.participant_name,token};
  currentRoom={id:data.room_id,name:data.room_name,code};
  currentCard=data.card;
  localStorage.setItem("peopleBingoSession",JSON.stringify({token,code}));
  $("participant-title").textContent=currentRoom.name;
  $("participant-subtitle").textContent=`Playing as ${currentParticipant.name} · Room ${code}`;
  message("submission-message","");
  drawCard(); connected(true); showView("participant");
}
$("leave-button").addEventListener("click",()=>{currentParticipant=null;currentCard=[];localStorage.removeItem("peopleBingoSession");showView("welcome");});
$("submit-bingo").addEventListener("click",async()=>{
  if(!currentParticipant) return;
  $("submit-bingo").disabled=true;
  const entries=currentCard.map((c,index)=>({index,name:c.name})).filter(x=>x.name);
  const {error}=await supabase.rpc("submit_bingo_card",{p_session_token:currentParticipant.token});
  if(error){message("submission-message",error.message);drawCard();return;}
  message("submission-message","Your card has been submitted to the organiser for verification.",true);
});
$("organiser-link").addEventListener("click",()=>{showView("organiser");checkAdminSession();});
$("organiser-login-button").addEventListener("click",adminLogin);
$("organiser-logout").addEventListener("click",async()=>{await supabase.auth.signOut();adminRoom=null;stopAdminRefresh();$("organiser-login").classList.remove("hidden");$("organiser-panel").classList.add("hidden");$("organiser-logout").classList.add("hidden");});
async function adminLogin() {
  message("organiser-login-message","");
  const {error}=await supabase.auth.signInWithPassword({email:$("organiser-email").value,password:$("organiser-password").value});
  if(error) return message("organiser-login-message",error.message);
  await loadAdmin();
}
async function checkAdminSession(){const {data}=await supabase.auth.getSession();if(data.session) await loadAdmin();}
async function loadAdmin() {
  const {data,error}=await supabase.rpc("get_my_bingo_room");
  if(error){message("organiser-login-message",error.message);return;}
  adminRoom=data;
  $("organiser-login").classList.add("hidden");$("organiser-panel").classList.remove("hidden");$("organiser-logout").classList.remove("hidden");
  $("admin-room-code").textContent=data.room_code;
  $("admin-room-name").value=data.room_name;
  $("admin-capacity").value=data.capacity;
  $("admin-room-state").value=data.status;
  $("room-status").textContent=data.status;
  $("share-link").value=location.origin+location.pathname+"?room="+data.room_code;
  $("prompt-list").value=data.prompts.join("\n");
  await refreshAdmin();
  startAdminRefresh();
}
async function refreshAdmin(){
  if(!adminRoom)return;
  const {data,error}=await supabase.rpc("get_bingo_admin_overview");
  if(error){console.error(error);return;}
  $("admin-participant-count").textContent=`${data.participant_count} / ${adminRoom.capacity}`;
  $("admin-submission-count").textContent=data.submission_count;
  $("admin-winner-count").textContent=data.winner_count;
  $("room-status").textContent=adminRoom.status;
  $("participant-list").innerHTML=data.participants.map(p=>`<div class="participant-row"><div><strong>${safeText(p.name)}</strong><small>Joined ${new Date(p.joined_at).toLocaleString()}</small></div><small>${p.completed_count}/24 squares</small></div>`).join("")||'<p class="muted">No participants have joined yet.</p>';
  $("submission-list").innerHTML=data.submissions.map(s=>`<div class="submission-row"><div><strong>${safeText(s.participant_name)}</strong><small>Submitted ${new Date(s.submitted_at).toLocaleString()} · ${s.status}</small></div><div class="submission-actions">${s.status==="pending"?`<button class="button button-secondary" data-review="approved" data-id="${s.id}">Approve</button><button class="button button-quiet" data-review="rejected" data-id="${s.id}">Reject</button>`:`<span class="status-tag">${s.status}</span>`}</div></div>`).join("")||'<p class="muted">No submissions yet.</p>';
  $("submission-list").querySelectorAll("button[data-review]").forEach(b=>b.addEventListener("click",()=>reviewSubmission(b.dataset.id,b.dataset.review)));
}
async function reviewSubmission(id,status){
  const {error}=await supabase.rpc("review_bingo_submission",{p_submission_id:id,p_decision:status});
  if(error) alert(error.message); else await refreshAdmin();
}
function startAdminRefresh(){stopAdminRefresh();refreshTimer=setInterval(refreshAdmin,8000);}
function stopAdminRefresh(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=null;}
$("refresh-admin").addEventListener("click",refreshAdmin);
$("save-room").addEventListener("click",async()=>{
  const {error}=await supabase.rpc("update_bingo_room",{p_room_name:$("admin-room-name").value.trim(),p_capacity:Number($("admin-capacity").value),p_status:$("admin-room-state").value});
  if(error) return message("room-save-message",error.message);
  adminRoom.room_name=$("admin-room-name").value.trim();adminRoom.capacity=Number($("admin-capacity").value);adminRoom.status=$("admin-room-state").value;
  $("share-link").value=location.origin+location.pathname+"?room="+adminRoom.room_code;
  message("room-save-message","Room settings saved.",true);await refreshAdmin();
});
$("save-prompts").addEventListener("click",async()=>{
  const prompts=$("prompt-list").value.split("\n").map(x=>x.trim()).filter(Boolean);
  if(prompts.length!==24)return message("prompt-save-message",`Please provide exactly 24 non-empty statements. You currently have ${prompts.length}.`);
  const {error}=await supabase.rpc("update_bingo_prompts",{p_prompts:prompts});
  if(error)return message("prompt-save-message",error.message);
  message("prompt-save-message","Statements saved. New cards will use the updated statements.",true);
});
$("copy-link").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("share-link").value);$("copy-link").textContent="Copied";setTimeout(()=>$("copy-link").textContent="Copy",1500);}catch{message("room-save-message","Copy the join link from the field above.");}});
$("export-participants").addEventListener("click",async()=>{
  const {data,error}=await supabase.rpc("get_bingo_admin_overview");if(error)return alert(error.message);
  const rows=[["Name","Joined","Completed squares"],...data.participants.map(p=>[p.name,p.joined_at,p.completed_count])];
  const csv=rows.map(row=>row.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));const a=document.createElement("a");a.href=url;a.download="people-bingo-participants.csv";a.click();URL.revokeObjectURL(url);
});
supabase.auth.onAuthStateChange((_event,session)=>{if(session&&$("organiser-view").classList.contains("hidden")===false)loadAdmin();});
if(SUPABASE_URL.includes("YOUR-PROJECT")||SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
  $("join-message").textContent="Setup required: add your Supabase URL and anon key in config.js. See README.";
} else {
  connected(true);
}
