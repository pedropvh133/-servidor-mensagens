/**
 * NOCTIS MESSENGER - SERVER MASTER V22.5 (STABLE + CYBERPUNK)
 * ESTABILIZAÇÃO TOTAL: SHA1 Checksum, Cache B2 e Painel de Comando Avançado.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const upload = multer({ dest: '/tmp/' });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    maxHttpBufferSize: 1e8 // 100MB
});
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL (RAM) ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};
let userSockets = {}; // Mapeamento: username -> [socket_ids]
let firebaseStatus = "Aguardando... ⚪";
let b2Status = "Aguardando... ⚪";
let cachedBucketName = null;

// --- CACHE DE CONEXÃO B2 ☁️ ⚡ ---
let b2ConnCache = { authToken: null, uploadUrl: null, uploadAuthToken: null, expiry: 0 };

// --- CONTROLE DE ACESSO ---
let adminPassword = "pedropvh133@gmail.com/admin"; // Senha padrão
let latestVersionCode = 1;
let latestApkName = "";

// --- FIREBASE CONFIG (SANEAMENTO) ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        const sanitized = rawConfig.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "CONECTADO! 🔥";
    } catch (err) { firebaseStatus = `ERRO: ${err.message} ❌`; }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function initB2() {
    if (!process.env.B2_KEY_ID || !B2_BUCKET_ID) return;
    try {
        await b2.authorize();
        const bucketResp = await b2.getBucket({ bucketId: B2_BUCKET_ID });
        if (bucketResp.data.buckets && bucketResp.data.buckets.length > 0) {
            cachedBucketName = bucketResp.data.buckets[0].bucketName;
            b2Status = "AUTORIZADO! ☁️";
        }
    } catch (e) { b2Status = "ERRO B2 ❌"; }
}
initB2();

// --- CARGA DE DADOS ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => d.data());
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(3000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) {
            latestVersionCode = configDoc.data().versionCode || 1;
            latestApkName = configDoc.data().apkName || "";
            if (configDoc.data().adminPassword) adminPassword = configDoc.data().adminPassword;
        }
    } catch (e) { console.error('Erro Backup:', e.message); }
}
loadDataFromBackup();

// --- FUNÇÃO AUXILIAR: SHA1 HASH 🛡️ ---
function getFileSHA1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

// --- MIDIA OTIMIZADA COM CACHE DE CONEXÃO 🛰️ 🚀 ---
async function getB2UploadParams() {
    const now = Date.now();
    if (b2ConnCache.authToken && b2ConnCache.uploadUrl && now < b2ConnCache.expiry) {
        return { uploadUrl: b2ConnCache.uploadUrl, uploadAuthToken: b2ConnCache.uploadAuthToken };
    }
    await b2.authorize();
    const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
    b2ConnCache = {
        authToken: b2.authorizationToken,
        uploadUrl: uploadUrlResp.data.uploadUrl,
        uploadAuthToken: uploadUrlResp.data.authorizationToken,
        expiry: now + (6 * 60 * 60 * 1000) // 6 horas
    };
    return { uploadUrl: b2ConnCache.uploadUrl, uploadAuthToken: b2ConnCache.uploadAuthToken };
}

async function uploadToB2(dataOrPath, fileName, isFilePath = false, retry = true) {
    if (!B2_BUCKET_ID) return { error: "Variáveis B2 não configuradas no Render." };
    try {
        const { uploadUrl, uploadAuthToken } = await getB2UploadParams();
        let uploadParams = { uploadUrl, uploadAuthToken, fileName };
        if (isFilePath) {
            uploadParams.contentLength = fs.statSync(dataOrPath).size;
            uploadParams.contentSha1 = await getFileSHA1(dataOrPath);
            uploadParams.data = fs.createReadStream(dataOrPath);
        } else { uploadParams.data = dataOrPath; }
        const uploadResp = await b2.uploadFile(uploadParams);
        return { url: `B2_URL:${uploadResp.data.fileName}` };
    } catch (e) {
        if (retry) {
            b2ConnCache.expiry = 0;
            return uploadToB2(dataOrPath, fileName, isFilePath, false);
        }
        return { error: e.response ? JSON.stringify(e.response.data) : e.message };
    }
}

// --- BROADCAST GRUPAL ---
function notifyGroupChange(groupId, adminSender, type = "GROUP_STATE_CHANGED") {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const signal = { from: adminSender, data: Buffer.from(`${type}:${groupId}`).toString('base64'), time: Date.now(), groupId: groupId, groupName: group.name };
    group.members.forEach(member => {
        if (!callSignals[member]) callSignals[member] = [];
        callSignals[member].push(signal);
        userSockets[member]?.forEach(sid => io.to(sid).emit('call_signal', signal));
    });
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ADMIN ROUTES ---
app.post('/admin/upload_apk', upload.single('apkFile'), async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== adminPassword) return res.status(403).send('Senha Incorreta');
    if (!req.file) return res.status(400).send('Arquivo não enviado');
    try {
        const fileName = `noctis_v${versionCode}_${Date.now()}.apk`;
        const result = await uploadToB2(req.file.path, fileName, true);
        if (result.url) {
            latestVersionCode = parseInt(versionCode); latestApkName = fileName;
            if (db) await db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName, adminPassword }, { merge: true });
            fs.unlinkSync(req.file.path);
            res.json({ status: 'ok' });
        } else res.status(500).send(result.error);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/admin/update_version', async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== adminPassword) return res.status(403).send('Senha Incorreta');
    latestVersionCode = parseInt(versionCode);
    if (db) await db.collection('system').doc('config').update({ versionCode: latestVersionCode });
    res.json({ status: 'ok' });
});

app.post('/admin/change_password', async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (oldPassword !== adminPassword) return res.status(403).send('Senha Atual Incorreta');
    adminPassword = newPassword;
    if (db) await db.collection('system').doc('config').update({ adminPassword });
    res.json({ status: 'ok' });
});

// --- USER ROUTES ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'EXISTE' });
    const u = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(u); res.status(201).json({ status: 'ok' });
    if (db) await db.collection('users').doc(username).set(u);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const u = users.find(x => x.username === username);
    if (u && u.password === password) {
        u.lastSeen = Date.now(); res.json({ status: 'ok', ...u });
        if (db) await db.collection('users').doc(username).update({ lastSeen: Date.now() });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    const r = await uploadToB2(Buffer.from(profilePic, 'base64'), `p_${username}_${Date.now()}`);
    if (r.url) {
        const u = users.find(x => x.username === username);
        if (u) { u.profilePic = r.url; if (db) await db.collection('users').doc(username).update({ profilePic: r.url }); }
        res.json({ status: 'ok', profilePic: r.url });
    } else res.status(500).send(r.error);
});

app.get('/user/info/:username', (req, res) => {
    const u = users.find(x => x.username === req.params.username);
    if (u) { const { password, ...safe } = u; res.json(safe); } else res.status(404).send('Off');
});

app.get('/conversations/list/:username', (req, res) => {
    const me = req.params.username; const set = new Set();
    messages.forEach(m => { if (!m.isGroup) { if (m.from === me) set.add(m.to); if (m.to === me) set.add(m.from); } });
    res.json(users.filter(u => set.has(u.username)).map(u => { const { password, ...s } = u; return s; }));
});

app.get('/status/:username', (req, res) => {
    const u = users.find(x => x.username === req.params.username);
    res.json({ status: (u && (Date.now() - u.lastSeen) < 60000) ? "Online" : "Visto por último recentemente" });
});

app.post('/user/update_settings', async (req, res) => {
    const { username, currentPassword, newUsername, newPassword, bio } = req.body;
    const u = users.find(x => x.username === username && x.password === currentPassword);
    if (u) {
        if (newUsername) u.username = newUsername; if (newPassword) u.password = newPassword; if (bio) u.bio = bio;
        res.json({ status: 'ok', ...u }); if (db) await db.collection('users').doc(username).set(u);
    } else res.status(401).send('Erro');
});

app.post('/user/block', async (req, res) => {
    const { username, target } = req.body;
    const u = users.find(x => x.username === username);
    if (u) { if (!u.blockedUsers.includes(target)) u.blockedUsers.push(target); res.json({ status: 'ok' }); if (db) await db.collection('users').doc(username).update({ blockedUsers: u.blockedUsers }); }
    else res.status(404).send('Erro');
});

app.post('/user/unblock', async (req, res) => {
    const { username, target } = req.body;
    const u = users.find(x => x.username === username);
    if (u) { u.blockedUsers = u.blockedUsers.filter(b => b !== target); res.json({ status: 'ok' }); if (db) await db.collection('users').doc(username).update({ blockedUsers: u.blockedUsers }); }
    else res.status(404).send('Erro');
});

app.get('/user/blocked_list/:username', (req, res) => res.json(users.find(u => u.username === req.params.username)?.blockedUsers || []));

// --- GROUP ROUTES ---
app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const id = 'group_' + Date.now();
    const g = { id, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(g); res.status(201).json(g);
    if (db) await db.collection('groups').doc(id).set(g);
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post(['/group/update_name', '/group/update_settings'], async (req, res) => {
    const { groupId, adminUser, name, description, rules } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        if (name) g.name = name; if (description !== undefined) g.description = description; if (rules !== undefined) g.rules = rules;
        res.json(g); notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ name: g.name, description: g.description, rules: g.rules });
    } else res.status(403).send('Erro');
});

app.post('/group/add_member', async (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        if (!g.members.includes(newMember)) g.members.push(newMember);
        res.json(g); notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ members: g.members });
    } else res.status(403).send('Erro');
});

app.post('/group/remove_member', async (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        g.members = g.members.filter(m => m !== targetUser); g.admins = g.admins.filter(a => a !== targetUser);
        if (!callSignals[targetUser]) callSignals[targetUser] = [];
        callSignals[targetUser].push({ from: adminUser, data: Buffer.from(`REMOVED_FROM_GROUP:${groupId}`).toString('base64'), time: Date.now() });
        res.json(g); notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ members: g.members, admins: g.admins });
    } else res.status(403).send('Erro');
});

app.post('/group/promote', async (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        if (!g.admins.includes(targetUser)) g.admins.push(targetUser);
        res.json(g); notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ admins: g.admins });
    } else res.status(403).send('Erro');
});

app.post('/group/leave', async (req, res) => {
    const { groupId, adminUser } = req.body;
    const g = groups.find(x => x.id === groupId && x.members.includes(adminUser));
    if (g) {
        g.members = g.members.filter(m => m !== adminUser); g.admins = g.admins.filter(a => a !== adminUser);
        if (g.members.length === 0) { groups = groups.filter(x => x.id !== groupId); if (db) await db.collection('groups').doc(groupId).delete(); return res.json({ status: 'ok', deleted: true }); }
        if (g.admins.length === 0 && g.members.length > 0) g.admins.push(g.members[0]);
        notifyGroupChange(groupId, adminUser); if (db) await db.collection('groups').doc(groupId).update({ members: g.members, admins: g.admins });
        res.json({ status: 'ok' });
    } else res.status(404).send('Off');
});

app.post('/group/update_pic', async (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        const r = await uploadToB2(Buffer.from(profilePic, 'base64'), `gp_${groupId}_${Date.now()}`);
        if (r.url) { g.profilePic = r.url; res.json(g); notifyGroupChange(groupId, adminUser); if (db) await db.collection('groups').doc(groupId).update({ profilePic: r.url }); }
        else res.status(500).send(r.error);
    } else res.status(403).send('Erro');
});

app.post('/group/delete', async (req, res) => {
    const { groupId, adminUser } = req.body;
    const idx = groups.findIndex(g => g.id === groupId && g.admins.includes(adminUser));
    if (idx !== -1) { notifyGroupChange(groupId, adminUser, "GROUP_DELETED"); groups.splice(idx, 1); res.json({ status: 'ok' }); if (db) await db.collection('groups').doc(groupId).delete(); }
    else res.status(403).send('Erro');
});

app.get('/group/messages/:groupId', (req, res) => res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId)));

// --- MESSAGE ROUTES ---
app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup, unlockTimestamp, replyToId, replyText, replySender } = req.body;
    const target = isGroup ? groups.find(g => g.id === recipient) : users.find(u => u.username === recipient);
    if (!isGroup && target?.blockedUsers?.includes(username)) return res.json({ status: 'ok' });

    let final = content;
    if (isAudio || isImage || isVideo) {
        const r = await uploadToB2(Buffer.from(content, 'base64'), `m_${Date.now()}_${username}`);
        if (r.url) final = r.url; else return res.status(500).send(r.error);
    }

    const m = { id: Date.now(), from: username, to: recipient, content: final, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false, delivered: false, unlockTimestamp, replyToId, replyText, replySender, reactions: {} };
    messages.push(m); res.json({ status: 'ok' });

    if (isGroup) {
        const g = groups.find(x => x.id === recipient);
        g?.members.forEach(mm => { if (mm !== username && userSockets[mm]) userSockets[mm].forEach(s => io.to(s).emit('new_message', { ...m, groupName: g.name })); });
    } else {
        userSockets[recipient]?.forEach(s => io.to(s).emit('new_message', m));
    }
    if (db) await db.collection('messages').doc(m.id.toString()).set(m);
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    for (let m of list) { if (m.from === req.params.u2 && !m.delivered) { m.delivered = true; if (db) await db.collection('messages').doc(m.id.toString()).update({ delivered: true }); } }
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const resList = messages.filter(m => ((!m.isGroup && m.to === me) || (m.isGroup && groups.find(g => g.id === m.to && g.members.includes(me)) && m.from !== me)) && !m.read);
    resList.forEach(m => { if (!m.delivered) { m.delivered = true; if (db) await db.collection('messages').doc(m.id.toString()).update({ delivered: true }); } });
    res.json(resList);
});

app.post('/mark_read', async (req, res) => {
    const { username, contact } = req.body;
    messages.forEach(m => { if (!m.isGroup && m.from === contact && m.to === username && !m.read) { m.read = true; if (db) await db.collection('messages').doc(m.id.toString()).update({ read: true }); } });
    res.json({ status: 'ok' });
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    const sig = { from, data, time: Date.now() };
    if (to.startsWith('group_')) {
        const group = groups.find(x => x.id === to);
        group?.members.forEach(mm => { if (mm !== from) { const gSig = { ...sig, groupName: group.name, groupId: group.id }; if (!callSignals[mm]) callSignals[mm] = []; callSignals[mm].push(gSig); userSockets[mm]?.forEach(s => io.to(s).emit('call_signal', gSig)); } });
    } else { if (!callSignals[to]) callSignals[to] = []; callSignals[to].push(sig); userSockets[to]?.forEach(s => io.to(s).emit('call_signal', sig)); }
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => {
    const u = req.params.username;
    const signals = callSignals[u] || [];
    callSignals[u] = []; // Limpa após ler
    res.setHeader('X-Latest-Version', latestVersionCode.toString());
    res.setHeader('X-Apk-Name', latestApkName || "");
    res.json(signals);
});

// --- INTERFACES HTML ---
app.get('/download', (req, res) => {
    const link = latestApkName ? `/b2file/${latestApkName}` : "#";
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>NOCTIS - Download</title>
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@900&display=swap" rel="stylesheet">
        <style>body{background:#05070A;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .card{background:#0A0F1E;padding:50px;border-radius:30px;text-align:center;border:1px solid #00D2FF;box-shadow:0 0 30px #00D2FF44;}
        h1{font-family:'Orbitron';color:#00D2FF;letter-spacing:5px;}
        .btn{background:#00D2FF;color:black;padding:20px 40px;border-radius:15px;text-decoration:none;font-weight:900;display:inline-block;margin-top:30px;transition:0.3s;}
        .btn:hover{transform:scale(1.1);box-shadow:0 0 20px #00D2FF;}</style></head>
        <body><div class="card"><h1>🛰️ NOCTIS</h1><p>Versão Segura: ${latestVersionCode}</p><a href="${link}" class="btn">GET ENCRYPTED BINARY</a></div></body></html>
    `);
});

app.get('/b2file/:filename', async (req, res) => {
    try {
        if (!cachedBucketName) await initB2();
        const resp = await b2.downloadFileByName({ bucketName: cachedBucketName, fileName: req.params.filename, responseType: 'arraybuffer' });
        res.setHeader('Content-Type', 'application/octet-stream'); res.send(Buffer.from(resp.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.get('/admin', (req, res) => {
    const total = users.length;
    const online = users.filter(u => (Date.now() - u.lastSeen) < 60000).length;
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>NOCTIS MASTER</title>
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
        <style>
            :root { --neon: #00D2FF; --acc: #FF00FF; --bg: #05070A; }
            body { background: var(--bg); color: #FFF; font-family: 'Rajdhani', sans-serif; margin: 0; display: flex; justify-content: center; min-height: 100vh; padding: 20px; overflow-x:hidden; }
            body::before { content: ""; position: fixed; inset: 0; background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.1) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.02), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.02)); background-size: 100% 4px, 4px 100%; pointer-events: none; }
            .container { width: 100%; max-width: 550px; animation: fadeInUp 0.8s ease-out; }
            @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
            .card { background: #0A0F1E; padding: 40px; border-radius: 40px; border: 1px solid rgba(0, 210, 255, 0.3); box-shadow: 0 25px 60px #000; position: relative; }
            h1 { font-family: 'Orbitron', sans-serif; color: var(--neon); text-align: center; letter-spacing: 5px; margin-bottom: 35px; text-shadow: 0 0 15px var(--neon); }
            .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 35px; }
            .stat { background: #111827; padding: 20px; border-radius: 25px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
            .stat b { font-size: 30px; color: var(--neon); display: block; font-family: 'Orbitron'; }
            .form-group { margin-bottom: 25px; }
            label { font-size:11px; color:#64748B; text-transform:uppercase; margin-bottom:10px; display:block; letter-spacing:2px; }
            input { width: 100%; background: #020617; border: 2px solid #1E293B; color: white; padding: 18px; border-radius: 18px; outline: none; transition:0.3s; }
            input:focus { border-color: var(--neon); box-shadow: 0 0 15px #00D2FF33; }
            .btn { width: 100%; background: linear-gradient(90deg, var(--neon), #0072FF); color: black; border: none; padding: 22px; border-radius: 20px; font-weight: 900; cursor: pointer; text-transform: uppercase; letter-spacing: 3px; font-family: 'Orbitron', sans-serif; font-size:14px; box-shadow:0 10px 20px #000; }
            .btn:hover { transform: translateY(-2px); filter: brightness(1.2); }
            .progress { display: none; margin-top: 30px; }
            .bar { width: 100%; background: #111; height: 12px; border-radius: 6px; overflow: hidden; }
            .fill { width: 0%; height: 100%; background: linear-gradient(90deg, var(--neon), var(--acc)); transition: 0.3s; box-shadow: 0 0 10px var(--neon); }
            .status-info { background:rgba(0,0,0,0.4); padding:15px; border-radius:20px; margin-bottom:30px; font-size:12px; border-left:4px solid var(--neon); }
        </style></head>
        <body><div class="container"><div class="card">
            <h1>🛰️ MASTER</h1>
            <div class="stats"><div class="stat"><b>${total}</b> Usuários</div><div class="stat"><b>${online}</b> Online</div></div>
            <div class="status-info">FIREBASE: ${firebaseStatus} | VAULT: ${b2Status}</div>
            <form id="f"><label>Protocol Version</label>
            <div class="form-group"><input name="v" type="number" value="${latestVersionCode+1}"></div>
            <label>Binary Payload (APK)</label>
            <div class="form-group"><input name="a" type="file" accept=".apk"></div>
            <label>Master Security Clearance</label>
            <div class="form-group"><input name="p" type="password" placeholder="SENHA MASTER"></div>
            <button type="submit" class="btn">INJECT DEPLOYMENT 🚀</button></form>
            <div class="progress" id="pb"><div class="bar"><div class="fill" id="fill"></div></div><p id="ps" style="font-size:11px; text-align:center; color:var(--neon); margin-top:10px"></p></div>
            <p id="m" style="text-align:center; margin-top:25px; font-weight:700"></p>
        </div></div>
        <script>
            document.getElementById('f').onsubmit = async (e) => {
                e.preventDefault(); const fd = new FormData(e.target);
                const m = document.getElementById('m'); const pb = document.getElementById('pb'); const fill = document.getElementById('fill'); const ps = document.getElementById('ps');
                m.style.color = "#FFF"; m.innerText = "📡 Estabelecendo Uplink..."; 
                if (fd.get('a').size > 0) {
                    pb.style.display="block"; const xhr = new XMLHttpRequest(); xhr.open('POST', '/admin/upload_apk', true);
                    xhr.upload.onprogress = (ev) => { const p = Math.round((ev.loaded/ev.total)*100); fill.style.width = p+"%"; ps.innerText = p + "% - Transmitindo dados..."; };
                    xhr.onload = () => { if(xhr.status===200){ m.style.color="#00F260"; m.innerText="✨ INJEÇÃO CONCLUÍDA!"; setTimeout(()=>location.reload(), 2500); } else { m.style.color="#FF4B2B"; m.innerText="❌ FALHA: " + xhr.responseText; pb.style.display="none"; } };
                    xhr.send(fd);
                } else {
                    const r = await fetch('/admin/update_version', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({versionCode: fd.get('v'), password: fd.get('p')}) });
                    if(r.ok){ m.style.color="#00F260"; m.innerText="✅ PROTOCOLO ATUALIZADO"; setTimeout(()=>location.reload(), 1500); } else { m.style.color="#FF4B2B"; m.innerText="❌ NEGADO"; }
                }
            };
        </script></body></html>
    `);
});

app.get('/', (req, res) => res.send(`<h1>🛰️ NOCTIS MASTER ONLINE ✅</h1>`));
app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (s) => {
    let user = null;
    s.on('auth', (u) => { user = u; if (!userSockets[u]) userSockets[u] = []; userSockets[u].push(s.id); io.emit('user_online', u); console.log('Auth:', u); });
    s.on('disconnect', () => { if (user && userSockets[user]) { userSockets[user] = userSockets[user].filter(id => id !== s.id); if (!userSockets[user].length) { delete userSockets[user]; io.emit('user_offline', user); } } });
});

setInterval(() => { https.get('https://servidor-mensagens.onrender.com/ping', () => {}); }, 10 * 60 * 1000);
server.listen(port, () => console.log(`Noctis Master V22.5 pronto.`));
