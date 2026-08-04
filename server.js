/**
 * NOCTIS MESSENGER - SERVER MASTER V22.0
 * ESTABILIZAÇÃO TOTAL + PAINEL CYBERPUNK 🚀
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
    maxHttpBufferSize: 1e8
});
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};
let userSockets = {};
let firebaseStatus = "Aguardando... ⚪";
let b2Status = "Aguardando... ⚪";
let cachedBucketName = null;

// --- CACHE B2 ---
let b2ConnCache = { authToken: null, uploadUrl: null, uploadAuthToken: null, expiry: 0 };

// --- CONTROLE ---
let adminPassword = "pedropvh133@gmail.com/admin";
let latestVersionCode = 1;
let latestApkName = "";

// --- FIREBASE ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        const serviceAccount = JSON.parse(rawConfig.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "ONLINE 🔥";
    } catch (err) { firebaseStatus = "ERRO 🔥"; }
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
            b2Status = "CONECTADO ☁️";
        }
    } catch (e) { b2Status = "OFFLINE ❌"; }
}
initB2();

// --- DATA ---
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
    } catch (e) {}
}
loadDataFromBackup();

function getFileSHA1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

async function getB2UploadParams() {
    const now = Date.now();
    if (b2ConnCache.authToken && b2ConnCache.uploadUrl && now < b2ConnCache.expiry) {
        return { uploadUrl: b2ConnCache.uploadUrl, uploadAuthToken: b2ConnCache.uploadAuthToken };
    }
    await b2.authorize();
    const resp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
    b2ConnCache = { authToken: b2.authorizationToken, uploadUrl: resp.data.uploadUrl, uploadAuthToken: resp.data.authorizationToken, expiry: now + (4 * 60 * 60 * 1000) };
    return { uploadUrl: b2ConnCache.uploadUrl, uploadAuthToken: b2ConnCache.uploadAuthToken };
}

async function uploadToB2(dataOrPath, fileName, isFilePath = false, retry = true) {
    if (!B2_BUCKET_ID) return { error: "[B2] BUCKET_ID não configurado." };
    try {
        const { uploadUrl, uploadAuthToken } = await getB2UploadParams();
        let params = { uploadUrl, uploadAuthToken, fileName };
        if (isFilePath) {
            params.contentLength = fs.statSync(dataOrPath).size;
            params.contentSha1 = await getFileSHA1(dataOrPath);
            params.data = fs.createReadStream(dataOrPath);
        } else { params.data = dataOrPath; }
        const resp = await b2.uploadFile(params);
        return { url: `B2_URL:${resp.data.fileName}` };
    } catch (e) {
        if (retry) {
            b2ConnCache.expiry = 0;
            return uploadToB2(dataOrPath, fileName, isFilePath, false);
        }
        return { error: e.response ? JSON.stringify(e.response.data) : e.message };
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

app.post('/admin/upload_apk', upload.single('apkFile'), async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== adminPassword) return res.status(403).send('Negado');
    if (!req.file) return res.status(400).send('Sem arquivo');
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
    if (password !== adminPassword) return res.status(403).send('Negado');
    latestVersionCode = parseInt(versionCode);
    if (db) await db.collection('system').doc('config').update({ versionCode: latestVersionCode });
    res.json({ status: 'ok' });
});

app.post('/admin/change_password', async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (oldPassword !== adminPassword) return res.status(403).send('Negado');
    adminPassword = newPassword;
    if (db) await db.collection('system').doc('config').update({ adminPassword });
    res.json({ status: 'ok' });
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).send('Existe');
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
    } else res.status(401).send('Erro');
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
    res.json({ status: (u && (Date.now() - u.lastSeen) < 60000) ? "Online" : "Visto recentemente" });
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

app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const id = 'g_' + Date.now();
    const g = { id, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(g); res.status(201).json(g);
    if (db) await db.collection('groups').doc(id).set(g);
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post('/group/update_pic', async (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const g = groups.find(x => x.id === groupId && x.admins.includes(adminUser));
    if (g) {
        const r = await uploadToB2(Buffer.from(profilePic, 'base64'), `gp_${groupId}_${Date.now()}`);
        if (r.url) { g.profilePic = r.url; res.json(g); if (db) await db.collection('groups').doc(groupId).update({ profilePic: r.url }); }
        else res.status(500).send(r.error);
    } else res.status(403).send('Erro');
});

app.get('/group/messages/:groupId', (req, res) => res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId)));

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
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const resList = messages.filter(m => ((!m.isGroup && m.to === me) || (m.isGroup && groups.find(g => g.id === m.to && g.members.includes(me)) && m.from !== me)) && !m.read);
    res.json(resList);
});

app.post('/mark_read', async (req, res) => {
    const { username, contact } = req.body;
    messages.forEach(m => { if (!m.isGroup && m.from === contact && m.to === username) m.read = true; });
    res.json({ status: 'ok' });
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    const sig = { from, data, time: Date.now() };
    if (to.startsWith('g_')) {
        groups.find(x => x.id === to)?.members.forEach(mm => { if (mm !== from && userSockets[mm]) userSockets[mm].forEach(s => io.to(s).emit('call_signal', sig)); });
    } else { userSockets[to]?.forEach(s => io.to(s).emit('call_signal', sig)); }
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => { res.setHeader('X-Latest-Version', latestVersionCode.toString()); res.setHeader('X-Apk-Name', latestApkName || ""); res.json([]); });

app.get('/download', (req, res) => {
    const link = latestApkName ? `/b2file/${latestApkName}` : "#";
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>NOCTIS - Download</title>
        <style>body{background:#05070A;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#111827;padding:40px;border-radius:20px;text-align:center;border:1px solid #00D2FF;}.btn{background:#00D2FF;color:black;padding:15px 30px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;margin-top:20px;}</style></head>
        <body><div class="card"><h1>🛰️ NOCTIS</h1><p>Versão Segura: ${latestVersionCode}</p><a href="${link}" class="btn">DOWNLOAD APK</a></div></body></html>
    `);
});

app.get('/b2file/:filename', async (req, res) => {
    try {
        const downloadResp = await b2.downloadFileByName({ bucketName: cachedBucketName, fileName: req.params.filename, responseType: 'arraybuffer' });
        res.setHeader('Content-Type', 'application/octet-stream'); res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Erro'); }
});

app.get('/admin', (req, res) => {
    const total = users.length;
    const online = users.filter(u => (Date.now() - u.lastSeen) < 60000).length;
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>NOCTIS MASTER</title>
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
        <style>
            :root { --neon: #00D2FF; --acc: #FF00FF; --bg: #05070A; }
            body { background: var(--bg); color: #FFF; font-family: 'Rajdhani', sans-serif; margin: 0; display: flex; justify-content: center; min-height: 100vh; padding: 20px; }
            .container { width: 100%; max-width: 550px; }
            .card { background: #0A0F1E; padding: 40px; border-radius: 30px; border: 1px solid rgba(0, 210, 255, 0.3); box-shadow: 0 20px 50px #000; position: relative; }
            h1 { font-family: 'Orbitron', sans-serif; color: var(--neon); text-align: center; letter-spacing: 5px; margin-bottom: 30px; text-shadow: 0 0 10px var(--neon); }
            .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; }
            .stat { background: #111827; padding: 15px; border-radius: 20px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
            .stat b { font-size: 24px; color: var(--neon); display: block; }
            .form-group { margin-bottom: 20px; }
            input { width: 100%; background: #020617; border: 1px solid #1E293B; color: white; padding: 15px; border-radius: 12px; outline: none; }
            .btn { width: 100%; background: linear-gradient(90deg, var(--neon), #0072FF); color: black; border: none; padding: 18px; border-radius: 15px; font-weight: 900; cursor: pointer; text-transform: uppercase; letter-spacing: 2px; font-family: 'Orbitron', sans-serif; }
            .progress { display: none; margin-top: 20px; }
            .bar { width: 100%; background: #111; height: 10px; border-radius: 5px; overflow: hidden; }
            .fill { width: 0%; height: 100%; background: var(--neon); transition: 0.3s; }
        </style></head>
        <body><div class="container"><div class="card">
            <h1>🛰️ COMMAND</h1>
            <div class="stats"><div class="stat"><b>${total}</b> Usuários</div><div class="stat"><b>${online}</b> Online</div></div>
            <form id="f"><div class="form-group"><input name="v" type="number" value="${latestVersionCode+1}"></div>
            <div class="form-group"><input name="a" type="file" accept=".apk"></div>
            <div class="form-group"><input name="p" type="password" placeholder="SENHA MASTER"></div>
            <button type="submit" class="btn">DEPLOY APK 🚀</button></form>
            <div class="progress" id="pb"><div class="bar"><div class="fill" id="fill"></div></div><p id="ps" style="font-size:12px; text-align:center"></p></div>
            <p id="m" style="text-align:center; margin-top:20px"></p>
        </div></div>
        <script>
            document.getElementById('f').onsubmit = async (e) => {
                e.preventDefault(); const fd = new FormData(e.target);
                const m = document.getElementById('m'); const pb = document.getElementById('pb'); const fill = document.getElementById('fill'); const ps = document.getElementById('ps');
                m.innerText = "Conectando...";
                if (fd.get('a').size > 0) {
                    pb.style.display="block"; const xhr = new XMLHttpRequest(); xhr.open('POST', '/admin/upload_apk', true);
                    xhr.upload.onprogress = (ev) => { const p = Math.round((ev.loaded/ev.total)*100); fill.style.width = p+"%"; ps.innerText = p + "% - Enviando payload..."; };
                    xhr.onload = () => { if(xhr.status===200){ m.innerText="✅ SUCESSO!"; setTimeout(()=>location.reload(), 2000); } else { m.innerText="❌ ERRO: " + xhr.responseText; pb.style.display="none"; } };
                    xhr.send(fd);
                } else {
                    const r = await fetch('/admin/update_version', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({versionCode: fd.get('v'), password: fd.get('p')}) });
                    m.innerText = r.ok ? "✅ VERSÃO OK" : "❌ ERRO";
                }
            };
        </script></body></html>
    `);
});

app.get('/', (req, res) => res.send(`<h1>🛰️ NOCTIS ONLINE</h1>`));
app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (s) => {
    let user = null;
    s.on('auth', (u) => { user = u; if (!userSockets[u]) userSockets[u] = []; userSockets[u].push(s.id); io.emit('user_online', u); });
    s.on('disconnect', () => { if (user && userSockets[user]) { userSockets[user] = userSockets[user].filter(id => id !== s.id); if (!userSockets[user].length) delete userSockets[user]; } });
});

setInterval(() => { https.get('https://servidor-mensagens.onrender.com/ping', () => {}); }, 10 * 60 * 1000);
server.listen(port, () => console.log(`Noctis pronto.`));
