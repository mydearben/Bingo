import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
});
const DEFAULT_CODE = new URLSearchParams(location.search).get("room") || "";
const GRID_SIZE = 4;
const CARD_SIZE = GRID_SIZE * GRID_SIZE;
const STORAGE_KEY = "peopleBingoSession";
let currentParticipant = null;
let currentRoom = null;
let currentCard = [];
let activeSquare = null;
let adminRoom = null;
let adminChannel = null;
let adminRefreshTimer = null;
let adminRefreshInFlight = false;
let adminRefreshQueued = false;

function message(id, text, success = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("success", success);
}
function showView(name) {
  ["welcome", "participant", "organiser"].forEach(v => $(`${v}-view`).classList.toggle("hidden", v !== name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function connected(ok, label = "Live updates") {
  const el = $("connection-state");
  el.classList.toggle("online", ok);
  el.innerHTML = `<i></i>${ok ? label : "Not connected"}`;
}
function safeText(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function hasBingo(entries) {
  const marked = new Set(entries.map(x => x.index));
  const lines = [];
  for (let r = 0; r < GRID_SIZE; r++) lines.push(Array.from({ length: GRID_SIZE }, (_, c) => r * GRID_SIZE + c));
  for (let c = 0; c < GRID_SIZE; c++) lines.push(Array.from({ length: GRID_SIZE }, (_, r) => r * GRID_SIZE + c));
  lines.push([0, 5, 10, 15], [3, 6, 9, 12]);
  return lines.some(line => line.every(i => marked.has(i)));
}
function drawCard() {
  const grid = $("bingo-grid");
  grid.innerHTML = "";
  currentCard.forEach((cell, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bingo-cell" + (cell.name ? " done" : "");
    btn.innerHTML = `<span class="cell-text">${safeText(cell.prompt)}</span><span class="cell-name">${cell.name ? safeText(cell.name) : "＋ Add colleague name"}</span>`;
    btn.setAttribute("aria-label", `${cell.prompt}. ${cell.name ? `Matched with ${cell.name}` : "Add colleague name"}`);
    btn.addEventListener("click", () => openSquare(index));
    grid.appendChild(btn);
  });
  const done = currentCard.filter(c => c.name).length;
  $("progress-count").textContent = done;
  $("progress-fill").style.width = `${done / CARD_SIZE * 100}%`;
  $("progress-copy").textContent = done === 0
    ? "Start a conversation to mark your first square."
    : `${done} of ${CARD_SIZE} statements completed. Keep meeting colleagues!`;
  const bingo = hasBingo(currentCard.map((c, index) => ({ index, name: c.name })).filter(x => x.name));
  $("line-status").textContent = bingo ? "Bingo line completed — submit your card!" : "No Bingo line yet";
  $("line-status").classList.toggle("ready", bingo);
  $("submit-bingo").disabled = !bingo;
}
function openSquare(index) {
  activeSquare = index;
  $("dialog-prompt").textContent = currentCard[index].prompt;
  $("colleague-name").value = currentCard[index].name || "";
  message("square-error", "");
  $("square-dialog").showModal();
  $("colleague-name").focus();
}
function setParticipantSession(data, token, code) {
  currentParticipant = { id: data.participant_id, name: data.participant_name, token };
  currentRoom = { id: data.room_id, name: data.room_name, code };
  currentCard = data.card;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, code }));
  $("participant-title").textContent = currentRoom.name;
  $("participant-subtitle").textContent = `Playing as ${currentParticipant.name} · Room ${code}`;
  message("submission-message", "");
  drawCard();
  connected(true, "Session restored");
  showView("participant");
}
async function restoreParticipantSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { saved = null; }
  if (!saved?.token || !saved?.code) return;
  if (DEFAULT_CODE && DEFAULT_CODE.toUpperCase() !== saved.code.toUpperCase()) return;
  const { data, error } = await supabase.rpc("get_my_bingo_participant", {
    p_session_token: saved.token,
    p_room_code: saved.code
  });
  if (error || !data?.participant_id) {
    localStorage.removeItem(STORAGE_KEY);
    if (error) message("join-message", "Your saved session could not be restored. Please join the room again.");
    return;
  }
  setParticipantSession(data, saved.token, saved.code);
}

$("square-form").addEventListener("submit", async e => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  if (!currentParticipant || activeSquare === null) return;
  const name = $("colleague-name").value.trim();
  if (!name) return message("square-error", "Please enter a colleague's name.");
  if (name.toLowerCase() === currentParticipant.name.toLowerCase()) return message("square-error", "Please enter another colleague, not your own name.");
  const duplicate = currentCard.some((c, i) => i !== activeSquare && c.name?.toLowerCase() === name.toLowerCase());
  if (duplicate) return message("square-error", "Use a different colleague for each square.");
  $("save-square").disabled = true;
  const { error } = await supabase.rpc("set_bingo_square", {
    p_session_token: currentParticipant.token,
    p_square_index: activeSquare,
    p_colleague_name: name
  });
  $("save-square").disabled = false;
  if (error) return message("square-error", error.message);
  currentCard = currentCard.map((c, i) => i === activeSquare ? { ...c, name } : c);
  $("square-dialog").close();
  drawCard();
});

$("join-button").addEventListener("click", joinRoom);
$("room-code").value = DEFAULT_CODE.toUpperCase();
$("room-code").addEventListener("input", e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6));
async function joinRoom() {
  const code = $("room-code").value.trim().toUpperCase();
  const name = $("participant-name").value.trim();
  message("join-message", "");
  if (code.length !== 6) return message("join-message", "Enter the six-character event room code.");
  if (!name) return message("join-message", "Please enter your name.");
  $("join-button").disabled = true;
  $("join-button").textContent = "Joining…";
  const token = crypto.randomUUID();
  const { data, error } = await supabase.rpc("join_bingo_room", {
    p_room_code: code, p_participant_name: name, p_session_token: token
  });
  $("join-button").disabled = false;
  $("join-button").textContent = "Join the Bingo";
  if (error) return message("join-message", error.message);
  setParticipantSession(data, token, code);
}
$("leave-button").addEventListener("click", () => {
  currentParticipant = null;
  currentRoom = null;
  currentCard = [];
  localStorage.removeItem(STORAGE_KEY);
  showView("welcome");
});
$("submit-bingo").addEventListener("click", async () => {
  if (!currentParticipant) return;
  $("submit-bingo").disabled = true;
  const { error } = await supabase.rpc("submit_bingo_card", { p_session_token: currentParticipant.token });
  if (error) {
    message("submission-message", error.message);
    drawCard();
    return;
  }
  message("submission-message", "Your card has been submitted to the organiser for verification.", true);
});

// Organiser dashboard and realtime subscriptions
$("organiser-link").addEventListener("click", () => { showView("organiser"); checkAdminSession(); });
$("organiser-login-button").addEventListener("click", adminLogin);
$("organiser-logout").addEventListener("click", async () => {
  stopAdminRealtime();
  await supabase.auth.signOut();
  adminRoom = null;
  $("organiser-login").classList.remove("hidden");
  $("organiser-panel").classList.add("hidden");
  $("organiser-logout").classList.add("hidden");
});
async function adminLogin() {
  message("organiser-login-message", "");
  const { error } = await supabase.auth.signInWithPassword({
    email: $("organiser-email").value,
    password: $("organiser-password").value
  });
  if (error) return message("organiser-login-message", error.message);
  await loadAdmin();
}
async function checkAdminSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) await loadAdmin();
}
async function loadAdmin() {
  stopAdminRealtime();
  const { data, error } = await supabase.rpc("get_my_bingo_room");
  if (error) return message("organiser-login-message", error.message);
  adminRoom = data;
  $("organiser-login").classList.add("hidden");
  $("organiser-panel").classList.remove("hidden");
  $("organiser-logout").classList.remove("hidden");
  $("admin-room-code").textContent = data.room_code;
  $("admin-room-name").value = data.room_name;
  $("admin-capacity").value = data.capacity;
  $("admin-room-state").value = data.status;
  $("room-status").textContent = data.status;
  $("prompt-list").value = data.prompts.join("\n");
  updateJoinLinkAndQr();
  await refreshAdmin();
  startAdminRealtime();
}
function updateJoinLinkAndQr() {
  const url = new URL(location.href);
  url.searchParams.set("room", adminRoom.room_code);
  $("share-link").value = url.toString();
  const holder = $("qr-code");
  holder.innerHTML = "";
  if (window.QRCode) {
    new window.QRCode(holder, {
      text: url.toString(), width: 184, height: 184,
      colorDark: "#172b4d", colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.H
    });
  } else {
    holder.textContent = "QR library could not be loaded. You can still copy the join link.";
  }
}
function downloadQr() {
  const holder = $("qr-code");
  const canvas = holder.querySelector("canvas");
  const image = holder.querySelector("img");
  const href = canvas?.toDataURL("image/png") || image?.src;
  if (!href) return message("qr-message", "Generate the QR code before downloading it.");
  const link = document.createElement("a");
  link.href = href;
  link.download = `people-bingo-${adminRoom.room_code}.png`;
  link.click();
  message("qr-message", "QR code downloaded.", true);
}
async function refreshAdmin() {
  if (!adminRoom) return;
  if (adminRefreshInFlight) { adminRefreshQueued = true; return; }
  adminRefreshInFlight = true;
  try {
    const { data, error } = await supabase.rpc("get_bingo_admin_overview");
    if (error) throw error;
    $("admin-participant-count").textContent = `${data.participant_count} / ${adminRoom.capacity}`;
    $("admin-submission-count").textContent = data.submission_count;
    $("admin-winner-count").textContent = data.winner_count;
    $("room-status").textContent = adminRoom.status;
    $("participant-list").innerHTML = data.participants.map(p =>
      `<div class="participant-row"><div><strong>${safeText(p.name)}</strong><small>Joined ${new Date(p.joined_at).toLocaleString()}</small></div><small>${p.completed_count}/16 squares</small></div>`
    ).join("") || '<p class="muted">No participants have joined yet.</p>';
    $("submission-list").innerHTML = data.submissions.map(s =>
      `<div class="submission-row"><div><strong>${safeText(s.participant_name)}</strong><small>Submitted ${new Date(s.submitted_at).toLocaleString()} · ${s.status}</small></div><div class="submission-actions">${s.status === "pending" ? `<button class="button button-secondary" data-review="approved" data-id="${s.id}">Approve</button><button class="button button-quiet" data-review="rejected" data-id="${s.id}">Reject</button>` : `<span class="status-tag">${safeText(s.status)}</span>`}</div></div>`
    ).join("") || '<p class="muted">No submissions yet.</p>';
    $("submission-list").querySelectorAll("button[data-review]").forEach(b =>
      b.addEventListener("click", () => reviewSubmission(b.dataset.id, b.dataset.review))
    );
  } catch (error) {
    console.error("Dashboard refresh failed", error);
  } finally {
    adminRefreshInFlight = false;
    if (adminRefreshQueued) {
      adminRefreshQueued = false;
      refreshAdmin();
    }
  }
}
function queueAdminRefresh() {
  clearTimeout(adminRefreshTimer);
  adminRefreshTimer = setTimeout(refreshAdmin, 180);
}
function startAdminRealtime() {
  if (!adminRoom) return;
  const channelName = `bingo-admin-${adminRoom.id}`;
  adminChannel = supabase.channel(channelName)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "bingo_participants",
      filter: `room_id=eq.${adminRoom.id}`
    }, queueAdminRefresh)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "bingo_submissions",
      filter: `room_id=eq.${adminRoom.id}`
    }, queueAdminRefresh)
    .subscribe(status => {
      if (status === "SUBSCRIBED") connected(true, "Live updates");
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") connected(false);
    });
}
function stopAdminRealtime() {
  clearTimeout(adminRefreshTimer);
  adminRefreshTimer = null;
  if (adminChannel) supabase.removeChannel(adminChannel);
  adminChannel = null;
  adminRefreshInFlight = false;
  adminRefreshQueued = false;
}
async function reviewSubmission(id, status) {
  const { error } = await supabase.rpc("review_bingo_submission", {
    p_submission_id: id, p_decision: status
  });
  if (error) alert(error.message);
  else await refreshAdmin();
}
$("refresh-admin").addEventListener("click", refreshAdmin);
$("save-room").addEventListener("click", async () => {
  const { error } = await supabase.rpc("update_bingo_room", {
    p_room_name: $("admin-room-name").value.trim(),
    p_capacity: Number($("admin-capacity").value),
    p_status: $("admin-room-state").value
  });
  if (error) return message("room-save-message", error.message);
  adminRoom.room_name = $("admin-room-name").value.trim();
  adminRoom.capacity = Number($("admin-capacity").value);
  adminRoom.status = $("admin-room-state").value;
  message("room-save-message", "Room settings saved.", true);
  await refreshAdmin();
});
$("save-prompts").addEventListener("click", async () => {
  const prompts = $("prompt-list").value.split("\n").map(x => x.trim()).filter(Boolean);
  if (prompts.length !== CARD_SIZE) return message("prompt-save-message", `Please provide exactly ${CARD_SIZE} non-empty statements. You currently have ${prompts.length}.`);
  const { error } = await supabase.rpc("update_bingo_prompts", { p_prompts: prompts });
  if (error) return message("prompt-save-message", error.message);
  message("prompt-save-message", "Statements saved. New cards will use the updated statements.", true);
});
$("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("share-link").value);
    $("copy-link").textContent = "Copied";
    setTimeout(() => $("copy-link").textContent = "Copy", 1500);
  } catch {
    message("room-save-message", "Copy the join link from the field above.");
  }
});
$("download-qr").addEventListener("click", downloadQr);
$("export-participants").addEventListener("click", async () => {
  const { data, error } = await supabase.rpc("get_bingo_admin_overview");
  if (error) return alert(error.message);
  const rows = [["Name", "Joined", "Completed squares"], ...data.participants.map(p => [p.name, p.joined_at, p.completed_count])];
  const csv = rows.map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a"); a.href = url; a.download = "people-bingo-participants.csv"; a.click(); URL.revokeObjectURL(url);
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (session && !$("organiser-view").classList.contains("hidden")) loadAdmin();
});
if (SUPABASE_URL.includes("YOUR-PROJECT") || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
  message("join-message", "Setup required: add your Supabase URL and anon key in config.js. See README.");
} else {
  connected(true, "Connected");
  restoreParticipantSession();
}
