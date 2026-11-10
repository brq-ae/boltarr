// Boltarr — SSH keys and per-host SSH access.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── SSH Key Management ────────────────────────────────────────────────────────

let sshKeys = [];
let sshKeyVisible = new Set();

async function loadSshKeys() {
  sshKeys = await api("GET", "/api/ssh-keys");
  renderSshKeys();
}

function renderSshKeys() {
  const el = document.getElementById("sshKeysList");
  if (!el) return;
  if (!sshKeys.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:8px 0">No keys registered yet.</div>`;
    return;
  }
  el.innerHTML = sshKeys.map(k => {
    const visible  = sshKeyVisible.has(k.id);
    const preview  = visible ? k.public_key : (k.fingerprint || (k.public_key.substring(0, 40) + "…"));
    const eyeTitle = visible ? "Hide key" : "Show key";
    const eyeIcon  = visible ? "🙈" : "👁";
    return `
    <div class="ssh-key-row" id="sshkrow-${k.id}">
      <div class="ssh-key-info">
        <div class="ssh-key-name">${escHtml(k.name)}</div>
        <div class="ssh-key-preview mono" id="sshkprev-${k.id}">${escHtml(preview)}</div>
      </div>
      <div class="ssh-key-inline-actions">
        <button class="btn-icon" title="${eyeTitle}" onclick="toggleSshKeyView(${k.id})">${eyeIcon}</button>
        <button class="btn-icon" title="Copy key" onclick="copySshKey(${k.id})">⎘</button>
        <button class="btn-icon btn-danger" title="Remove" onclick="deleteSshKey(${k.id})">✕</button>
      </div>
      <div class="ssh-key-kebab-wrap">
        <button class="svc-kebab" onclick="toggleSshKeyMenu(${k.id})" title="Actions">⋮</button>
        <div class="svc-menu" id="sshkmenu-${k.id}">
          <button class="svc-menu-item" onclick="closeSshKeyMenus();toggleSshKeyView(${k.id})">${eyeIcon} ${eyeTitle}</button>
          <button class="svc-menu-item" onclick="closeSshKeyMenus();copySshKey(${k.id})">⎘ Copy key</button>
          <button class="svc-menu-item danger" onclick="closeSshKeyMenus();deleteSshKey(${k.id})">✕ Remove</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function toggleSshKeyView(id) {
  if (sshKeyVisible.has(id)) sshKeyVisible.delete(id);
  else sshKeyVisible.add(id);
  const k = sshKeys.find(k => k.id === id);
  if (!k) return;
  const visible = sshKeyVisible.has(id);
  const prev = document.getElementById(`sshkprev-${id}`);
  if (prev) {
    prev.textContent = visible ? k.public_key : (k.fingerprint || k.public_key.substring(0, 40) + "…");
    prev.classList.toggle("expanded", visible);
  }
  // update eye icon in both inline and menu
  const row = document.getElementById(`sshkrow-${id}`);
  if (!row) return;
  const eyeIcon  = visible ? "🙈" : "👁";
  const eyeTitle = visible ? "Hide key" : "Show key";
  const inlineEye = row.querySelector(".ssh-key-inline-actions button:first-child");
  if (inlineEye) { inlineEye.textContent = eyeIcon; inlineEye.title = eyeTitle; }
  const menuEye = row.querySelector(".svc-menu button:first-child");
  if (menuEye) menuEye.textContent = `${eyeIcon} ${eyeTitle}`;
}

async function copySshKey(id) {
  const k = sshKeys.find(k => k.id === id);
  if (!k) return;
  try {
    await navigator.clipboard.writeText(k.public_key);
    showToast("Key copied to clipboard");
  } catch {
    showToast("Copy failed — try showing the key and copying manually");
  }
}

function toggleSshKeyMenu(id) {
  const menu = document.getElementById(`sshkmenu-${id}`);
  if (!menu) return;
  const wasOpen = menu.classList.contains("open");
  closeSshKeyMenus();
  if (!wasOpen) menu.classList.add("open");
}

function closeSshKeyMenus() {
  document.querySelectorAll(".ssh-key-kebab-wrap .svc-menu.open").forEach(m => m.classList.remove("open"));
}

async function addSshKey() {
  const name = document.getElementById("sshKeyName").value.trim();
  const public_key = document.getElementById("sshKeyValue").value.trim();
  if (!name || !public_key) return showToast("Name and public key are required");
  try {
    await api("POST", "/api/ssh-keys", { name, public_key });
    document.getElementById("sshKeyName").value = "";
    document.getElementById("sshKeyValue").value = "";
    await loadSshKeys();
    showToast("Key added");
  } catch (e) {
    showToast("Failed to add key: " + (e.message || "invalid format"));
  }
}

async function deleteSshKey(id) {
  if (!confirm("Remove this key? It will also remove all host access assignments for it.")) return;
  await api("DELETE", `/api/ssh-keys/${id}`);
  await loadSshKeys();
  showToast("Key removed");
}

// ── SSH Access section inside host detail panel ───────────────────────────────

async function loadHostSshSection(ip) {
  const [access, keys] = await Promise.all([
    api("GET", `/api/hosts/${ip}/ssh-access`),
    api("GET", `/api/ssh-keys`),
  ]);

  const el = document.getElementById("dtab-ssh");
  if (!el) return;

  // Group existing access by username
  const byUser = {};
  for (const a of access) {
    if (!byUser[a.username]) byUser[a.username] = [];
    byUser[a.username].push(a);
  }

  const usersHTML = Object.entries(byUser).map(([user, entries]) => {
    const rows = entries.map(a => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1;font-size:12px;color:var(--text)">${escHtml(a.name)}</div>
        <div style="font-size:10px;font-family:monospace;color:var(--text-3);flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.fingerprint || "")}</div>
        <button class="btn-ghost btn-danger" style="font-size:11px;padding:2px 6px" onclick="removeHostSshAccess(${a.id},${jsq(ip)})">✕</button>
      </div>`).join("");

    return `
      <div style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:var(--accent);font-family:monospace">${escHtml(user)}</span>
          <button class="btn" style="font-size:10px;padding:2px 8px" onclick="copySshCurl(${jsq(ip)},${jsq(user)})" title="Copies a command that deploys these keys into ${escHtml(user)}'s ~/.ssh/authorized_keys">Copy deploy cmd</button>
          <button class="btn" style="font-size:10px;padding:2px 8px" onclick="downloadAuthorizedKeys(${jsq(ip)},${jsq(user)})">Download</button>
        </div>
        ${rows}
      </div>`;
  }).join("");

  const keyOptions = keys.map(k => `<option value="${k.id}">${escHtml(k.name)}</option>`).join("");

  el.innerHTML = `
    ${usersHTML || `<div style="font-size:12px;color:var(--text-3);padding:8px 0;margin-bottom:12px">No SSH access configured for this host yet.</div>`}
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="flex:2;min-width:120px">
        <label style="font-size:10px">Key</label>
        <select id="sshAccessKey" style="width:100%">
          ${keyOptions || '<option value="">— no keys registered —</option>'}
        </select>
      </div>
      <div class="field" style="flex:1;min-width:80px">
        <label style="font-size:10px">Username</label>
        <input type="text" id="sshAccessUser" value="root" placeholder="root" style="width:100%">
      </div>
      <button class="btn btn-primary" style="font-size:11px;padding:5px 10px;white-space:nowrap" onclick="addHostSshAccess(${jsq(ip)})">+ Grant Access</button>
    </div>
  `;
}

async function addHostSshAccess(ip) {
  const keyEl = document.getElementById("sshAccessKey");
  const userEl = document.getElementById("sshAccessUser");
  const ssh_key_id = parseInt(keyEl?.value);
  const username = userEl?.value.trim();
  if (!ssh_key_id || !username) return showToast("Select a key and enter a username");
  try {
    await api("POST", `/api/hosts/${ip}/ssh-access`, { ssh_key_id, username });
    await loadHostSshSection(ip);
  } catch (e) {
    showToast("Already assigned");
  }
}

async function removeHostSshAccess(accessId, ip) {
  await api("DELETE", `/api/ssh-access/${accessId}`);
  await loadHostSshSection(ip);
}

function sshDeployCmd(ip, user) {
  const url = `${location.protocol}//${location.host}/api/hosts/${ip}/authorized-keys?user=${user}`;
  // Resolves the TARGET user's home (root→/root, john→/home/john), creates ~/.ssh,
  // appends keys, dedupes, and fixes perms + ownership. Run as root (or via sudo).
  return `sudo sh -c 'U="${user}"; H=$(getent passwd "$U" | cut -d: -f6); ` +
    `install -d -m700 "$H/.ssh"; ` +
    `curl -sfL "${url}" >> "$H/.ssh/authorized_keys"; ` +
    `sort -u "$H/.ssh/authorized_keys" -o "$H/.ssh/authorized_keys"; ` +
    `chmod 600 "$H/.ssh/authorized_keys"; ` +
    `chown -R "$U" "$H/.ssh"'`;
}

async function copySshCurl(ip, user) {
  await navigator.clipboard.writeText(sshDeployCmd(ip, user));
  showToast(`Copied — deploys to ${user}'s ~/.ssh/authorized_keys`);
}

async function downloadAuthorizedKeys(ip, user) {
  const text = await fetch(`/api/hosts/${ip}/authorized-keys?user=${user}`).then(r => r.text());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = "authorized_keys";
  a.click();
}

